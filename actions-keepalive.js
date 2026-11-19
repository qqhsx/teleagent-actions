// GitHub Actions 专用：一次性保活脚本
// 复用本仓库已验证的 lib/login.js + lib/keepalive.js，不重复造轮子。
// 每次运行 = 一轮：加载缓存 JWT → 失效则重登 → 自愈拉起 → 官方心跳 → 换票。
// 凭据来源（GitHub Secrets，经环境变量注入）：
//   TA_ACCOUNT 手机号/账号
//   TA_PASSWORD 密码
'use strict';

const fs = require('fs');
const path = require('path');
const Login = require('./lib/login');
const KeepAlive = require('./lib/keepalive');

const DATA_DIR = process.env.TA_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

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
  _file: path.join(DATA_DIR, 'config.json'),
};

const login = new Login(DATA_DIR, log);
const auth = { jwt: null }; // 保活模块只读取 .jwt
const ka = new KeepAlive(auth, config, log, notifier);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureJwt() {
  const jwtFile = login.jwtPath();

  // 1) 优先用 Cache 恢复的 JWT
  if (fs.existsSync(jwtFile)) {
    const cached = fs.readFileSync(jwtFile, 'utf8').trim().split(/\r?\n/)[0].trim();
    if (cached) {
      auth.jwt = cached;
      ka.bindToken(cached);
      try {
        const ins = await ka.resolveInstance();
        console.log(`[Auth] 缓存 JWT 有效，实例 ${ka.instanceId} 状态 ${ins.status}`);
        return ins;
      } catch (e) {
        console.warn(`[Auth] 缓存 JWT 不可用（${e.message}），准备重新登录`);
      }
    }
  }

  // 2) 缓存失效 → 账号密码登录（这是唯一会触发异地风控的环节，尽量少走）
  const account = (process.env.TA_ACCOUNT || '').trim();
  const password = process.env.TA_PASSWORD || '';
  if (!account || !password) {
    throw new Error('缓存 JWT 失效且未提供 TA_ACCOUNT / TA_PASSWORD，无法重新登录');
  }
  console.log('[Auth] 使用账号密码登录（含滑块自动识别）…');
  const r = await login.loginByPassword(account, password);
  auth.jwt = r.operationToken;
  ka.bindToken(auth.jwt);
  fs.writeFileSync(jwtFile, auth.jwt + '\n', { mode: 0o600 });
  console.log('[Auth] 登录成功，新 JWT 已落盘（将由 Actions Cache 保存供下次复用）');
  return await ka.resolveInstance();
}

async function main() {
  console.log('==== TeleAgent 保活 · 本轮开始 ' + new Date().toISOString() + ' ====');

  let ins = await ensureJwt();

  // 自愈：实例关机/排队 → 远程拉起（即使休眠真的发生，也能最快恢复）
  if (ins.status !== 100 && ins.status !== 4) {
    console.warn(`[Heal] 实例状态 ${ins.status}，执行 instance/start 远程拉起`);
    await ka.ensureRunning(ins);
    ins = await ka.resolveInstance();
  }

  // 官方活跃信号：refresh + heartbeat（模拟网页端停留）
  const hb = await ka.sendHeartbeat();
  console.log(`[KeepAlive] 心跳结果：${JSON.stringify(hb.results || hb)}`);

  // 换票：活跃信号 + 生成云电脑入口
  let url = null;
  for (let i = 0; i < 3; i++) {
    try {
      url = await ka.connectTicket();
      break;
    } catch (e) {
      console.warn(`[KeepAlive] 换票第 ${i + 1} 次失败：${e.message.slice(0, 100)}`);
      await sleep(4000);
    }
  }
  if (!url) throw new Error('换票连续 3 次失败');

  // 最终确认状态
  const finalIns = await ka.resolveInstance();
  console.log(`[Done] ✅ 本轮保活完成，实例状态 ${finalIns.status}，心跳累计 ${ka.heartbeatCount}`);
  console.log('==== 本轮结束 ====');
}

main().catch((e) => {
  console.error('❌ 保活失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
