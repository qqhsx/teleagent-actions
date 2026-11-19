// 调度模块：每日积分领取（纯 API）+ 补跑
'use strict';

const fs = require('fs');
const path = require('path');

class Scheduler {
  constructor({ config, log, api, ka, power, notifier }) {
    this.config = config;
    this.log = log;
    this.api = api;
    this.ka = ka;
    this.power = power;
    this.notifier = notifier || { event: async () => {} };
    this.state = loadState(path.join(config._file, '..', 'state.json'));
    this.timer = null;
    this.running = false;
    this.lastResult = this.state.last_result || null;
    this.nextAt = null;
  }

  status() {
    return {
      claim_time: this.config.points.claim_time,
      poll_minutes: this.config.points.poll_minutes || 10,
      next_claim_at: this.nextAt ? new Date(this.nextAt).toISOString() : null,
      next_claim_text: this.nextAt ? new Date(this.nextAt).toLocaleString('zh-CN') : null,
      last_result: this.lastResult,
      last_claim_date: this.state.last_claim_date || null,
      claiming: this.running,
      catchup_on_start: !!this.config.points.catchup_on_start,
    };
  }

  start() {
    this.scheduleNext();
    if (this.pollTimer) clearInterval(this.pollTimer); // 防重复注册：onToken 重复触发（自动重登/文件误判）会再次 start()
    // 认证活动轮询：每 poll_minutes 分钟带 JWT 查一次积分（确定的账号活动信号，兼作保活心跳）
    const pm = Math.max(2, parseInt(this.config.points.poll_minutes || '10', 10));
    this.pollTimer = setInterval(() => {
      this.api.refreshPoints().catch(() => {});
    }, pm * 60 * 1000);
    this.pollTimer.unref && this.pollTimer.unref();
    if (this.config.points.catchup_on_start && this.state.last_claim_date !== today()) {
      this.log.info('Scheduler', `启动补跑：今日（${today()}）尚未领取，3 秒后执行`);
      setTimeout(() => this.triggerClaim('catchup'), 3000);
    } else {
      this.log.info('Scheduler', `今日已领取过（${this.state.last_claim_date}），等待下一周期`);
    }
  }

  reschedule() {
    clearTimeout(this.timer);
    this.scheduleNext();
    this.log.info('Scheduler', `计划已更新：每日 ${this.config.points.claim_time} 领取`);
  }

  scheduleNext(minGapMs = 0) {
    const [h, m] = String(this.config.points.claim_time || '08:05').split(':').map((x) => parseInt(x, 10));
    const now = new Date();
    const next = new Date(now);
    next.setHours(h || 8, m || 5, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    // 领取刚跑完又遇到「距今不足 minGapMs」的今日同一时刻（定时器毫秒截断可能提前零点几秒触发）→ 跳到明天，防止 1 秒内连跑两次
    else if (next.getTime() - Date.now() <= minGapMs) next.setDate(next.getDate() + 1);
    this.nextAt = next.getTime();
    const wait = this.nextAt - Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.triggerClaim('scheduled'), wait);
    this.timer.unref && this.timer.unref();
    this.log.info('Scheduler', `下一次领取：${next.toLocaleString('zh-CN')}`);
  }

  async triggerClaim(source) {
    if (this.running) return { ok: false, error: '领取任务执行中' };
    this.running = true;
    this.log.info('Claim', `开始领取（触发：${source}，通道：API）`);
    try {
      const r = await this.claimViaApi();
      this.lastResult = { ...r, source, at: new Date().toISOString() };
      this.state.last_result = this.lastResult;
      if (r.status === 'claimed' || r.status === 'already_claimed') {
        this.state.last_claim_date = today();
      }
      saveState(path.join(this.config._file, '..', 'state.json'), this.state);
      this.log.info('Claim', `结果：${r.status}${r.balance ? '，余额 ' + r.balance : ''}`);
      if (r.status === 'claimed' && this.notifier) {
        this.notifier.event('claim', '积分已领取', `今日 +100 积分\n余额：${r.balance || '未知'}\n时间：${new Date().toLocaleString('zh-CN')}`, 60);
      }
      // 领取后刷新积分状态
      setTimeout(() => this.api.refreshPoints().catch(() => {}), 3000);
      return { ok: true, ...r };
    } catch (e) {
      this.log.error('Claim', `异常: ${e.message}`);
      if (this.notifier) {
        this.notifier.event('claim-fail', '积分领取异常', `原因：${e.message}`, 60);
      }
      return { ok: false, error: e.message };
    } finally {
      this.running = false;
      // 领取后重排：30 秒内即将到达的「今日同一时刻」直接跳到明天（防止边界提前触发导致 1 秒内连领两次）
      if (source !== 'manual') this.scheduleNext(30 * 1000);
    }
  }

  // API 领取：checkDayTask 查状态 → 未领则调 checkTask?\u003cdaily_login\u003e → 刷新余额
  async claimViaApi() {
    // 1. 查状态（幂等：已领则直接返回 already_claimed）
    let dt = null;
    try {
      dt = await this.api.dayTaskRaw();
      const act = (dt && dt.data && dt.data.activity_data || []).find((a) => (a.jump_url || '').includes('checkTask'));
      if (act && act.action_status === 'completed') {
        const bal = await this.api.refreshPoints().catch(() => null);
        return { status: 'already_claimed', balance: this.api.pointsSnapshot().balance };
      }
    } catch (e) {
      this.log.warn('Claim', `查任务状态失败（${e.message}），直接尝试领取`);
    }
    // 2. 领取
    const r = await this.api.claimDailyLogin();
    if (r && (r.code === 200 || r.code === 0)) {
      await this.api.refreshPoints().catch(() => {});
      return { status: 'claimed', balance: this.api.pointsSnapshot().balance, detail: r.data || null };
    }
    // 3. 领后复核：可能已领过（服务端幂等返回非成功码）
    const dt2 = await this.api.dayTaskRaw().catch(() => null);
    const act2 = (dt2 && dt2.data && dt2.data.activity_data || []).find((a) => (a.jump_url || '').includes('checkTask'));
    if (act2 && act2.action_status === 'completed') {
      return { status: 'already_claimed', balance: this.api.pointsSnapshot().balance };
    }
    throw new Error('领取接口返回非成功（' + JSON.stringify(r).slice(0, 120) + '）');
  }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function loadState(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; }
}
function saveState(fp, s) {
  try { fs.writeFileSync(fp, JSON.stringify(s, null, 2)); } catch {}
}

module.exports = Scheduler;
