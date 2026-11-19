// teleagent-dashboard — 会话保活 + 每日积分 + 电源管理 + 机器状态
// 面向 TeleAgent 平台（agent.teleai.com.cn），参考 muyicn/ctyun-dashboard 的架构思路。
// 鉴权：页面「账号登录」（密码换取 JWT 落盘 data/jwt.txt，快过期时自动重登）；
//       密码以 AES-256-GCM 密文存 data/config.json。
// 用法：node server.js  （配置见 data/config.json，首次运行自动生成）
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const Auth = require('./lib/auth');
const Login = require('./lib/login');
const Api = require('./lib/api');
const KeepAlive = require('./lib/keepalive');
const Power = require('./lib/power');
const SysMon = require('./lib/sysmon');
const Scheduler = require('./lib/scheduler');
const Log = require('./lib/log');
const Notifier = require('./lib/notify');
const PanelAuth = require('./lib/panelauth');

const ROOT = __dirname;
const DATA_DIR = process.env.TA_DATA_DIR || path.join(ROOT, 'data');
const PORT = parseInt(process.env.PORT || '8590', 10);

fs.mkdirSync(DATA_DIR, { recursive: true });

const log = new Log(DATA_DIR);
const login = new Login(DATA_DIR, log);
const config = loadConfig();
const auth = new Auth(config, log, login);
const api = new Api(auth, config, log);
const notifier = new Notifier(config, log);
const ka = new KeepAlive(auth, config, log, notifier);
const power = new Power(config, log, notifier, ka);
const sysmon = new SysMon();
const scheduler = new Scheduler({ config, log, api, ka, power, notifier });
// 面板自带 Basic Auth（可选，公网/隧道暴露前开启）
const panelAuth = new PanelAuth(config, log);
// 定时重启避让：积分领取进行中则跳过本轮计划
power.setBusyCheck(() => scheduler.running);

// ---------- 配置 ----------
function loadConfig() {
  const def = {
    port: PORT,
    // token 来源：页面登录后 JWT 落盘 data/jwt.txt（token_file 为其落盘路径，登录后自动设置）
    token_file: process.env.TA_TOKEN_FILE || '',
    // 账号密码登录（异地部署主力：页面登录 → JWT 落盘 data/jwt.txt，自动重登续期）
    auth: { account: '', passwordEnc: '', autoRelogin: true, reloginDays: 7 },
    // 保活（ticket 模式：instance/connect 换票 + 自愈 instance/start）
    keepalive: { enabled: true, mode: 'ticket', refreshSec: 300 },
    // 积分（poll_minutes：认证 API 定期轮询，兼作账号活动心跳）
    points: { claim_time: '08:05', catchup_on_start: true, poll_minutes: 10 },
    // 电源：定时重启计划（统一走平台 instance/restart，重启云电脑不动部署机）
    power: {
      restart_plan: { enabled: false, mode: 'daily', time: '04:30', weekday: 0 },
    },
    // 通知（企业微信 webhook，掉线/拉起/积分事件推送）
    notify: { enabled: false, wecomWebhook: '', cooldownMin: 30 },
    // 平台
    api_base: 'https://agent.teleai.com.cn/superCowork/sapi',
  };
  const fp = path.join(DATA_DIR, 'config.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
  const merged = deepMerge(def, cur);
  fs.writeFileSync(fp, JSON.stringify(merged, null, 2));
  merged._file = fp;
  return merged;
}
function deepMerge(a, b) {
  const out = Array.isArray(a) ? [...a] : { ...a };
  if (!b || typeof b !== 'object') return out;
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) {
      out[k] = deepMerge(a[k], b[k]);
    } else if (b[k] !== undefined) {
      out[k] = b[k];
    }
  }
  return out;
}

// ---------- 状态聚合 ----------
function status() {
  return {
    time: new Date().toISOString(),
    auth: auth.status(),
    keepalive: ka.status(),
    points: api.pointsSnapshot(),
    power: power.status(),
    system: sysmon.snapshot(),
    scheduler: scheduler.status(),
  };
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  // 登录页本身不走鉴权（静态页 + 提交到 /api/panel/login 换会话 Cookie）
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(ROOT, 'public', 'login.html')));
    return;
  }
  // 面板登录：验证账号密码 → 签发会话 Cookie（HttpOnly；Basic 通道照旧支持 API 调用）
  if (req.method === 'POST' && url.pathname === '/api/panel/login') {
    let body = '';
    for await (const c of req) body += c;
    let b = {};
    try { b = JSON.parse(body || '{}'); } catch { return json(res, { ok: false, error: '请求格式不对' }, 400); }
    const r = panelAuth.verifyLogin(b.user, b.password);
    if (!r.ok) {
      log.warn('PanelAuth', `面板登录失败：${r.error}`);
      return json(res, { ok: false, error: r.error }, 401);
    }
    res.setHeader('set-cookie', panelAuth.issueCookie(req));
    log.info('PanelAuth', '面板登录成功（会话 Cookie 已签发，7 天有效）');
    json(res, { ok: true });
    return;
  }
  // 退出面板登录：清除会话 Cookie
  if (req.method === 'POST' && url.pathname === '/api/panel/logout') {
    res.setHeader('set-cookie', panelAuth.clearCookie(req));
    json(res, { ok: true });
    return;
  }
  // 面板鉴权门禁：页面与所有 API 统一过闸（未登录页面 → 302 登录页；API → 401）
  if (!panelAuth.check(req, res)) return;
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status()));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(log.tail(200)));
      return;
    }
    // 刷新积分状态（只读 API）
    if (req.method === 'POST' && url.pathname === '/api/points/refresh') {
      const r = await api.refreshPoints();
      json(res, r);
      return;
    }
    // 手动触发领取（平台 API）
    if (req.method === 'POST' && url.pathname === '/api/points/claim') {
      const r = await scheduler.triggerClaim('manual');
      json(res, r);
      return;
    }
    // 保活开关 / 立即保活一轮
    if (req.method === 'POST' && url.pathname === '/api/keepalive/toggle') {
      const r = ka.toggle();
      json(res, r);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/keepalive/reconnect') {
      const r = await ka.reconnect();
      json(res, r);
      return;
    }
    // 一键打开云电脑（换票生成官方网页入口）
    if (req.method === 'POST' && url.pathname === '/api/desktop/open') {
      try {
        const u = await ka.freshConnectUrl();
        json(res, { ok: true, url: u });
      } catch (e) {
        json(res, { ok: false, error: e.message }, 500);
      }
      return;
    }
    // 平台接口：重置云电脑服务（instance/rebuild，高危；需 confirm=RESET 参数防误触）
    if (req.method === 'POST' && url.pathname === '/api/power/platform-rebuild') {
      const confirmWord = String(url.searchParams.get('confirm') || '');
      if (confirmWord !== 'RESET') {
        return json(res, { ok: false, error: '缺少确认参数（confirm=RESET）' }, 400);
      }
      if (!auth.status().ok) return json(res, { ok: false, error: '未登录，无法调用平台接口' }, 400);
      try {
        json(res, await ka.platformRebuild());
      } catch (e) {
        log.error('Power', `平台重置失败: ${e.message}`);
        json(res, { ok: false, error: e.message }, 500);
      }
      return;
    }
    // 平台接口：取消排队（instance/cancel）
    if (req.method === 'POST' && url.pathname === '/api/power/platform-cancel') {
      if (!auth.status().ok) return json(res, { ok: false, error: '未登录，无法调用平台接口' }, 400);
      try {
        json(res, await ka.platformCancel());
      } catch (e) {
        log.error('Power', `取消排队失败: ${e.message}`);
        json(res, { ok: false, error: e.message }, 500);
      }
      return;
    }
    // 平台接口：服务状态（service/status，实时查询）
    if (req.method === 'GET' && url.pathname === '/api/platform/service-status') {
      if (!auth.status().ok) return json(res, { ok: false, error: '未登录，无法调用平台接口' }, 400);
      try {
        json(res, await ka.pollServiceStatus());
      } catch (e) {
        json(res, { ok: false, error: e.message }, 500);
      }
      return;
    }
    // 临时诊断：福利社 API 探测（定位每日登录积分的领取接口）
    if (req.method === 'GET' && url.pathname === '/api/welfare/probe') {
      try {
        const results = await api.probeWelfareApis();
        json(res, { ok: true, results });
      } catch (e) {
        json(res, { ok: false, error: e.message }, 500);
      }
      return;
    }
    // 临时诊断：dayTask 原始返回
    if (req.method === 'GET' && url.pathname === '/api/welfare/daytask') {
      json(res, await api.dayTaskRaw());
      return;
    }
    // 每日登录积分领取（API 版）
    if (req.method === 'POST' && url.pathname === '/api/welfare/claim-daily') {
      try {
        const r = await api.claimDailyLogin();
        log.info('Claim', `API 领取结果: ${JSON.stringify(r).slice(0, 200)}`);
        json(res, r);
      } catch (e) {
        log.error('Claim', `API 领取失败: ${e.message}`);
        json(res, { ok: false, error: e.message }, 500);
      }
      return;
    }
    // 账号密码登录：换取 JWT 并接管凭据（密码密文存 data/config.json，明文不落盘）
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      let body = '';
      for await (const c of req) body += c;
      const b = JSON.parse(body || '{}');
      const account = String(b.account || '').trim();
      const password = String(b.password || '');
      if (!account || !password) return json(res, { ok: false, error: '账号和密码都要填' }, 400);
      try {
        const r = await auth.loginAndStore(account, password, { remember: b.remember !== false });
        json(res, r);
      } catch (e) {
        log.error('Login', `登录失败（${account}）：${e.message}`);
        json(res, { ok: false, error: e.message }, 400);
      }
      return;
    }
    // 用已保存的账号密码立即重登（手动续期）
    if (req.method === 'POST' && url.pathname === '/api/auth/relogin') {
      try {
        json(res, await auth.reloginSaved());
      } catch (e) {
        json(res, { ok: false, error: e.message }, 400);
      }
      return;
    }
    // 清除登录凭据（JWT + 密码密文）
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      json(res, await auth.clearLogin());
      return;
    }
    // 通知配置 / 测试
    if (req.method === 'POST' && url.pathname === '/api/notify') {
      let body = '';
      for await (const c of req) body += c;
      const patch = JSON.parse(body || '{}');
      config.notify = deepMerge(config.notify || {}, patch);
      fs.writeFileSync(config._file, JSON.stringify({ ...config, _file: undefined }, null, 2));
      notifier.reset();
      json(res, { ok: true, notify: { enabled: config.notify.enabled, has_webhook: !!config.notify.wecomWebhook } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/notify/test') {
      const r = await notifier.send('测试通知', `来自 teleagent-dashboard\n时间：${new Date().toLocaleString('zh-CN')}`);
      json(res, r.ok ? { ok: true } : { ok: false, error: r.error || '未配置 webhook' }, r.ok ? 200 : 400);
      return;
    }
    // 平台重启：调用平台 instance/restart，重启云电脑本身，不动部署机
    if (req.method === 'POST' && url.pathname === '/api/power/platform-restart') {
      if (!auth.status().ok) return json(res, { ok: false, error: '未登录，无法调用平台接口' }, 400);
      try {
        json(res, await ka.platformRestart());
      } catch (e) {
        log.error('Power', `平台重启失败: ${e.message}`);
        json(res, { ok: false, error: e.message }, 500);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      let body = '';
      for await (const c of req) body += c;
      const patch = JSON.parse(body || '{}');
      const allowed = ['points', 'keepalive', 'notify'];
      for (const k of allowed) if (patch[k]) config[k] = deepMerge(config[k], patch[k]);
      // power 仅允许改 restart_plan（安全门禁，禁止外部写入其他字段）
      if (patch.power && patch.power.restart_plan && typeof patch.power.restart_plan === 'object') {
        const rp = patch.power.restart_plan;
        config.power = Object.assign({}, config.power || {}, {
          restart_plan: {
            enabled: !!rp.enabled,
            mode: rp.mode === 'weekly' ? 'weekly' : 'daily',
            time: /^\d{2}:\d{2}$/.test(String(rp.time)) ? String(rp.time) : '04:30',
            weekday: Number.isInteger(Number(rp.weekday)) && Number(rp.weekday) >= 0 && Number(rp.weekday) <= 6 ? Number(rp.weekday) : 0,
          },
        });
        power.applyPlan(config.power.restart_plan);
      }
      // auth 节仅允许改开关（账号/密码只能通过 /api/auth/login 设置，禁止外部直接写入）
      if (patch.auth && typeof patch.auth === 'object') {
        const a = config.auth || {};
        if (typeof patch.auth.autoRelogin === 'boolean') a.autoRelogin = patch.auth.autoRelogin;
        if (patch.auth.reloginDays != null) a.reloginDays = Math.max(1, parseInt(patch.auth.reloginDays, 10) || 7);
        config.auth = a;
      }
      fs.writeFileSync(config._file, JSON.stringify({ ...config, _file: undefined }, null, 2));
      // 仅当保存内容真的涉及领取时间时才重排领取计划——否则保存电源/保活/通知等配置
      // 也会打出误导性的「计划已更新：每日 08:05 领取」（计划实际没变）
      if (patch.points && patch.points.claim_time != null) scheduler.reschedule();
      // 保活间隔变化时同步到 ka
      ka.refreshSec = Math.max(60, parseInt(config.keepalive.refreshSec || '300', 10));
      json(res, { ok: true, points: config.points, keepalive: config.keepalive });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  } catch (e) {
    json(res, { error: String(e && e.message || e) }, 500);
  }
});

function json(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- 启动 ----------
const HOST = process.env.TA_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1（已监听全部网卡）' : HOST;
  log.info('System', `teleagent-dashboard 已就绪: http://${shown}:${PORT}`);
  if (panelAuth.enabled) log.info('System', `面板登录保护已开启（Basic Auth，用户 ${panelAuth.user}）`);
  else log.warn('System', '面板登录保护未开启（未设 TA_PANEL_PASSWORD）——仅建议本机 127.0.0.1 使用');
});

let svcTimer = null; // 平台服务状态轮询定时器（防 onToken 重复触发时叠加）
auth.onToken(async (jwt) => {
  log.info('Auth', `会话凭据已加载（有效期至 ${auth.expiryText()}），开始初始化各模块`);
  api.bindToken(jwt);
  ka.bindToken(jwt);
  if (process.env.TA_OFFLINE === '1') {
    log.warn('System', 'TA_OFFLINE=1：离线自检模式，跳过平台连接（API/保活/领取）');
    return;
  }
  if (config.keepalive.enabled) ka.start(jwt);
  await api.refreshPoints();
  scheduler.start();
  // 平台服务状态周期查询（10 分钟），供面板展示（onToken 重复触发时先清旧定时器，避免叠加轮询）
  ka.pollServiceStatus().catch(() => {});
  if (svcTimer) clearInterval(svcTimer);
  svcTimer = setInterval(() => { ka.pollServiceStatus().catch(() => {}); }, 10 * 60 * 1000);
  svcTimer.unref();
});
auth.init().catch((e) => log.error('Auth', `初始化失败: ${e.message}`));

process.on('SIGINT', () => { try { ka.stop(); } catch {} process.exit(0); });
