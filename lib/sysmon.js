// 机器状态：CPU / 内存 / 磁盘 / 运行时长（纯本地，不依赖登录态）
'use strict';

const os = require('os');

class SysMon {
  constructor() { this._last = cpuSnapshot(); }

  snapshot() {
    const now = cpuSnapshot();
    const idleDelta = now.idle - this._last.idle;
    const totalDelta = now.total - this._last.total;
    this._last = now;
    const cpuPct = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
    const mem = process.platform === 'win32' ? winMem() : nixMem();
    const disk = diskFree();
    return {
      scope: 'local', // 标识：显示的是工具所在机器（部署机/本机）自身状态；云电脑状态看「实例保活」卡片
      cpu_pct: Math.min(100, Math.max(0, cpuPct)),
      mem_total_gb: mem.total, mem_used_gb: mem.used, mem_pct: mem.pct,
      disk_free_gb: disk.free, disk_pct: disk.pct, disk_mount: disk.mount,
      uptime_text: humanDur(os.uptime() * 1000),
      platform: `${os.type()} ${os.release()}`,
      hostname: os.hostname(),
    };
  }
}

function cpuSnapshot() {
  const c = os.cpus();
  let idle = 0, total = 0;
  for (const x of c) {
    idle += x.times.idle;
    total += x.times.idle + x.times.user + x.times.nice + x.times.sys + x.times.irq;
  }
  return { idle, total };
}

function winMem() {
  const total = os.totalmem() / 1024 ** 3;
  // Node 无直接已用内存（Windows）；用进程视角粗略+总内存展示
  const free = os.freemem() / 1024 ** 3;
  const used = total - free;
  return { total: +total.toFixed(1), used: +used.toFixed(1), pct: Math.round((used / total) * 100) };
}
function nixMem() { return winMem(); }

function diskFree() {
  const fs = require('fs');
  try {
    const st = fs.statSync(process.cwd());
    const gb = 1024 ** 3;
    // statSync 无 size 信息（Windows）；退化为读磁盘可用（PowerShell 已在主进程外）
    return { free: null, pct: null, mount: process.cwd() };
  } catch { return { free: null, pct: null, mount: null }; }
}

function humanDur(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分` : `${m}分${s % 60}秒`;
}

module.exports = SysMon;
