// GitHub Actions 专用：一次性保活脚本（支持多账号）
// 复用本仓库已验证的 lib/login.js + lib/keepalive.js + lib/api.js，不重复造轮子。
// 每个账号一轮：加载缓存 JWT → 失效才重登 → 自愈拉起 → 官方心跳 → 换票 → 每日积分（幂等）。
// 凭据来源（GitHub Secrets，经环境变量注入）：
//   账号1：TA_ACCOUNT / TA_PASSWORD（兼容旧命名，也可用 TA_ACCOUNT_1 / TA_PASSWORD_1）
//   账号2：TA_ACCOUNT_2 / TA_PASSWORD_2
//   账号3：TA_ACCOUNT_3 / TA_PASSWORD_3 ……依次编号，最多 10 个
// 数据隔离：账号1 用 data/（沿用旧路径，兼容历史 JWT 缓存）；账号N 用 data/accN/。
'use strict';

const fs = require('fs');
const path = require('path');
const Login = require('./lib/login');
const KeepAlive = require('./lib/keepalive');
const Api = require('./lib/api');

const DATA_DIR = process.env.TA_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const MAX_ACCOUNTS = 10;

// 极简日志/通知桩：保活模块只用到 info/warn/error 和 event
const log = {
  info: (t, m) => console.log(`[${t}] ${m}`),
  warn: (t, m) => console.warn(`[WARN ${t}] ${m}`),
  error: (t, m) => console.error(`[ERR ${t}] ${m}`),
};
const notifier = { event: async () => {} };

const config = {
  auth: { account: '', passwordEnc: '', autoRelogin: true, reloginDays: 7 },
  keepalive: { enabled: true, mode: 'ticket', refreshSec: 300 },
  points: { claim_time: '08:05', catchup_on_start: true, poll_minutes: 10 },
  notify: { enabled: false, wecomWebhook: '', cooldownMin: 30 },
  power: { restart_plan: { enabled: false } },
  api_base: 'https://agent.teleai.com.cn/superCowork/sapi',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 发现所有已配置的账号：编号必须连续，遇到空档即停止。
function discoverAccounts() {
  const list = [];
  const first = (process.env.TA_ACCOUNT_1 || process.env.TA_ACCOUNT || '').trim();
  const firstPwd = process.env.TA_PASSWORD_1 || process.env.TA_PASSWORD || '';
  if (first && firstPwd) {
    list.push({ id: 1, account: first, password: firstPwd, dir: DATA_DIR });
  }
  for (let i = 2; i <= MAX_ACCOUNTS; i++) {
    const acc = (process.env[`TA_ACCOUNT_${i}`] || '').trim();
    const pwd = process.env[`TA_PASSWORD_${i}`] || '';
    if (!acc || !pwd) break;
    const dir = path.join(DATA_DIR, `acc${i}`);
    fs.mkdirSync(dir, { recursive: true });
    list.push({ id: i, account: acc, password: pwd, dir });
  }
  return list;
}

function readClaimState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeClaimState(file, s) {
  try { fs.writeFileSync(file, JSON.stringify(s, null, 2)); } catch (e) {
    console.warn(`[Points] 状态落盘失败（不影响本轮）：${e.message}`);
  }
}

// 每日积分领取：本地日期标记 + 服务端 dayTaskRaw 幂等，双重防重复。
// 失败绝不影响保活主流程（调用处 try-catch 吞掉）。
async function maybeClaimPoints(api, auth, claimFile, tag) {
  const state = readClaimState(claimFile);
  if (state.last_claim_date === today()) {
    console.log(`${tag}[Points] 今日已领取过（本地标记），跳过`);
    return;
  }

  api.bindToken(auth.jwt);

  let completed = false;
  try {
    const dt = await api.dayTaskRaw();
    const acts = (dt && dt.data && dt.data.activity_data) || [];
    const task = acts.find((a) => (a.jump_url || '').includes('checkTask'));
    if (task && task.action_status === 'completed') completed = true;
  } catch (e) {
    console.warn(`${tag}[Points] 查任务状态失败（${e.message}），直接尝试领取`);
  }

  if (completed) {
    console.log(`${tag}[Points] 服务端显示今日已领取，仅更新本地标记`);
    writeClaimState(claimFile, { ...state, last_claim_date: today() });
    return;
  }

  const r = await api.claimDailyLogin();
  if (r && (r.code === 200 || r.code === 0)) {
    await api.refreshPoints().catch(() => {});
    const bal = api.pointsSnapshot().balance;
    console.log(`${tag}[Points] ✅ 今日积分已领取（+100），余额 ${bal == null ? '未知' : bal}`);
    writeClaimState(claimFile, { ...state, last_claim_date: today(), last_balance: bal });
    return;
  }

  const dt2 = await api.dayTaskRaw().catch(() => null);
  const acts2 = (dt2 && dt2.data && dt2.data.activity_data) || [];
  const task2 = acts2.find((a) => (a.jump_url || '').includes('checkTask'));
  if (task2 && task2.action_status === 'completed') {
    console.log(`${tag}[Points] 复核确认今日已领取，更新本地标记`);
    writeClaimState(claimFile, { ...state, last_claim_date: today() });
    return;
  }
  throw new Error('领取接口返回非成功：' + JSON.stringify(r).slice(0, 120));
}

async function ensureJwt(login, auth, ka, account, password, tag) {
  const jwtFile = login.jwtPath();

  // 1) 优先用 Cache 恢复的 JWT（异地风控只发生在登录环节，尽量少走）
  if (fs.existsSync(jwtFile)) {
    const cached = fs.readFileSync(jwtFile, 'utf8').trim().split(/\r?\n/)[0].trim();
    if (cached) {
      auth.jwt = cached;
      ka.bindToken(cached);
      try {
        const ins = await ka.resolveInstance();
        console.log(`${tag}[Auth] 缓存 JWT 有效，实例 ${ka.instanceId} 状态 ${ins.status}`);
        return ins;
      } catch (e) {
        console.warn(`${tag}[Auth] 缓存 JWT 不可用（${e.message}），准备重新登录`);
      }
    }
  }

  // 2) 缓存失效 → 账号密码登录（含滑块自动识别）
  if (!account || !password) {
    throw new Error('缓存 JWT 失效且未提供该账号凭据，无法重新登录');
  }
  console.log(`${tag}[Auth] 使用账号密码登录（含滑块自动识别）…`);
  const r = await login.loginByPassword(account, password);
  auth.jwt = r.operationToken;
  ka.bindToken(auth.jwt);
  fs.writeFileSync(jwtFile, auth.jwt + '\n', { mode: 0o600 });
  console.log(`${tag}[Auth] 登录成功，新 JWT 已落盘（将由 Actions Cache 保存供下次复用）`);
  return await ka.resolveInstance();
}

// 单个账号跑完整一轮。所有实例都是本账号私有，互不干扰。
async function runOneAccount(acc) {
  const tag = `[账号${acc.id} ${acc.account}] `;
  const login = new Login(acc.dir, log);
  const auth = { jwt: null };
  const ka = new KeepAlive(auth, config, log, notifier);
  const api = new Api(auth, config, log);
  const claimFile = path.join(acc.dir, 'claim-state.json');

  console.log(`${tag}==== 本轮开始 ====`);

  let ins = await ensureJwt(login, auth, ka, acc.account, acc.password, tag);

  // 自愈：实例关机/排队 → 远程拉起
  if (ins.status !== 100 && ins.status !== 4) {
    console.warn(`${tag}[Heal] 实例状态 ${ins.status}，执行 instance/start 远程拉起`);
    await ka.ensureRunning(ins);
    ins = await ka.resolveInstance();
  }

  // 官方活跃信号：refresh + heartbeat
  const hb = await ka.sendHeartbeat();
  console.log(`${tag}[KeepAlive] 心跳结果：${JSON.stringify(hb.results || hb)}`);

  // 换票：活跃信号 + 生成云电脑入口
  let url = null;
  for (let i = 0; i < 3; i++) {
    try {
      url = await ka.connectTicket();
      break;
    } catch (e) {
      console.warn(`${tag}[KeepAlive] 换票第 ${i + 1} 次失败：${e.message.slice(0, 100)}`);
      await sleep(4000);
    }
  }
  if (!url) throw new Error('换票连续 3 次失败');

  // 每日积分（独立于保活，失败不影响本账号结果）
  try {
    await maybeClaimPoints(api, auth, claimFile, tag);
  } catch (e) {
    console.warn(`${tag}[Points] 本轮积分跳过（不影响保活）：${e.message}`);
  }

  const finalIns = await ka.resolveInstance();
  console.log(`${tag}[Done] ✅ 本轮保活完成，实例状态 ${finalIns.status}，心跳累计 ${ka.heartbeatCount}`);
  console.log(`${tag}==== 本轮结束 ====`);
}

// 失败重试：某账号抛错后等待 N 秒补跑一次，把最坏空窗从 60 分钟压到约 34 分钟。
// 只在失败时等待，正常轮次零额外开销。
const RETRY_DELAY_SEC = Math.max(0, parseInt(process.env.TA_RETRY_DELAY_SEC || '180', 10));

async function runAccountWithRetry(acc) {
  const tag = `[账号${acc.id} ${acc.account}] `;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await runOneAccount(acc);
      return;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (attempt >= 2) throw e;
      console.warn(`${tag}[Retry] 第 1 次失败（${msg.slice(0, 120)}），${RETRY_DELAY_SEC}s 后补跑一次…`);
      if (RETRY_DELAY_SEC > 0) await sleep(RETRY_DELAY_SEC * 1000);
      console.log(`${tag}[Retry] 开始补跑第 2 次…`);
    }
  }
}

async function main() {
  console.log('==== TeleAgent 保活 · 本轮开始 ' + new Date().toISOString() + ' ====');

  const accounts = discoverAccounts();
  if (!accounts.length) {
    throw new Error('未发现任何账号：请检查 TA_ACCOUNT/TA_PASSWORD 及 TA_ACCOUNT_N/TA_PASSWORD_N Secrets');
  }
  console.log(`[Accounts] 共发现 ${accounts.length} 个账号：${accounts.map((a) => `#${a.id} ${a.account}`).join('、')}`);

  // 全局随机抖动一次：打散机械心跳时刻；账号之间串行，各轮天然错开数秒。
  // 放在循环外而非每账号各抖一次，是为控制总时长（Actions 按 job 时长计费）。
  const jitterMax = Math.max(0, parseInt(process.env.TA_JITTER_SEC || '45', 10));
  if (jitterMax > 0) {
    const j = Math.floor(Math.random() * jitterMax) + 1;
    console.log(`[Jitter] 随机延迟 ${j}s 后执行（打散固定时刻）`);
    await sleep(j * 1000);
  }

  const results = [];
  for (const acc of accounts) {
    try {
      await runAccountWithRetry(acc);
      results.push({ id: acc.id, ok: true });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error(`[账号${acc.id} ${acc.account}] ❌ 两轮均失败：${msg.slice(0, 160)}`);
      results.push({ id: acc.id, ok: false, err: msg });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`[汇总] 成功 ${results.length - failed.length}/${results.length} 个账号`);
  if (failed.length) {
    // 关键：此处不 throw —— 让 job 以成功结束，确保 actions/cache 保存本轮更新后的 JWT。
    // 否则某账号偶发失败会导致整个 job 失败，缓存无法保存，下轮被迫重登（更易触发异地风控）。
    console.error(`[汇总] 失败账号：${failed.map((r) => '#' + r.id).join('、')}（本 job 仍以成功退出，以保存 JWT 缓存）`);
  }
  console.log('==== 本轮结束 ====');
}

main().catch((e) => {
  console.error('❌ 保活主流程失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
