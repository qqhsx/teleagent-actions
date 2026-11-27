# TeleAgent 云电脑保活 · GitHub Actions 版

用 GitHub Actions + cron-job.org 定时执行**一次性保活脚本**，保持 TeleAgent（星辰）云电脑在线，并自动领取每日积分。**支持多个账号**，各账号独立隔离、互不影响。

## 原理

把原仓库的长驻服务改造成"一次性脚本"：外部 cron-job.org 每 30 分钟触发一次 GitHub Actions 的 `workflow_dispatch`，每次跑一轮：

1. 从 Actions Cache 恢复上次的 JWT（有效期几天）
2. JWT 有效 → 直接复用；失效 → 用账号密码重新登录（滑块验证码自动识别）
3. 查实例状态：关机/排队 → `instance/start` 远程拉起（自愈）
4. 发官方活跃信号 `refresh` + `heartbeat`
5. `instance/connect` 换票（活跃信号，同时是云电脑入口）
6. 领取每日积分（服务端幂等，不会重复领）
7. 新 JWT 落盘，由 Cache 保存供下次复用

关键点：**只有 JWT 失效时才登录**，把触发异地风控的环节压到最低频率。

## 功能

- ✅ 实例保活：官方心跳 + 换票，关机自动远程拉起
- ✅ 每日积分：自动领取，服务端幂等防重复
- ✅ **多账号**：最多 10 个账号，每账号独立 JWT / 积分标记 / 重试，失败互不影响
- ✅ 抗风控设计：JWT 复用 + 0~45 秒随机抖动 + 失败自动重试一次
- ✅ 单触发源：只有 cron-job.org，无 GitHub 自带 schedule 干扰

## 部署

### 1. 准备仓库

把本目录所有文件（含 `.github/workflows/keepalive.yml`）推到你的 GitHub 仓库。

> **推荐 Public**：公开仓库的标准 runner 免费且不限分钟数。多账号会线性增加额度消耗，公开仓库是最省钱的选择；密码仍走 Secrets，不会因公开而泄露。若只有单账号，Private 也可以（每月 2000 分钟额度内）。

### 2. 配置账号 Secrets（多账号核心）

仓库 → **Settings → Secrets and variables → Actions → New repository secret**。

**第 1 个账号**（沿用旧命名，兼容已有配置）：

| Name | Value |
|---|---|
| `TA_ACCOUNT` | 账号1 的登录账号（如 `qqhsx`） |
| `TA_PASSWORD` | 账号1 的登录密码 |

**第 2 个及以后**：按编号**成对**添加，编号必须**连续**（脚本遇到第一个空档就停止，不会跳过）：

| Name | Value |
|---|---|
| `TA_ACCOUNT_2` | 账号2 的账号 |
| `TA_PASSWORD_2` | 账号2 的密码 |
| `TA_ACCOUNT_3` | 账号3 的账号 |
| `TA_PASSWORD_3` | 账号3 的密码 |
| … | … 依次到 `TA_ACCOUNT_10` / `TA_PASSWORD_10` |

- workflow 已预置账号 1~5 共 10 个变量，加账号**只需加 Secrets，不用改代码**；要加第 6 个以上，才在 workflow 的 `env` 里补对应两行。
- 加账号示例：想加第二个，就加 `TA_ACCOUNT_2` + `TA_PASSWORD_2` 两条，保存后下一轮自动生效。
- 删账号：删掉对应编号的 Secrets 即可；若要删中间的编号，需把后面的编号**前移保持连续**。
- 密码只存在 Secrets 里，不落盘、不进缓存、不出现在日志。

**数据隔离**：账号1 的 JWT 在 `data/jwt.txt`（沿用旧路径，历史缓存可直接恢复）；账号2 在 `data/acc2/jwt.txt`，账号3 在 `data/acc3/jwt.txt`，积分标记同理各放各的目录。账号之间完全隔离，一个失败不影响另一个。

### 3. 配置定时触发

到 [cron-job.org](https://cron-job.org) 建一个 job，每 30 分钟 POST 一次 dispatch：

- **URL**：`https://api.github.com/repos/<你的用户名>/<仓库名>/actions/workflows/keepalive.yml/dispatches`
- **HTTP Headers**：
  - `Authorization: Bearer <你的 GitHub Token>`（classic PAT，需 `repo` + `workflow` 权限；**这个令牌要长期保留，勿 revoke**）
  - `Accept: application/vnd.github+json`
- **Body**：`{"ref":"main"}`
- **Schedule**：Custom → `*/30 * * * *`

> GitHub 自带 `schedule` 必须保持关闭（本仓库 workflow 已删除），否则两个触发源叠加会产生 5~10 分钟的短间隔。

### 4. 首次验证

Actions 页面 → "TeleAgent 云电脑保活" → **Run workflow** 手动触发一次，点进去看日志：

- `成功 N/M 个账号` 中 **N = M** 才是真的成功；任一账号失败现在会让 job 显示红色 failure（不会再用绿灯掩盖事故）
- `[Done] ✅ 本轮保活完成` = 登录 + 心跳 + 换票 + 积分都通了
- `[Cache] 本轮全部账号失败，不写缓存标记` = 守门生效，坏 JWT 不会污染下一轮
- `[Auth] 使用账号密码登录` 后报异地/验证码错误 = 境外 IP 被风控，见「已知限制」

## 触发间隔与容错

- **固定 30 分钟**：`*/30` 触发点 :00 / :30，间隔恒定，远离 1 小时休眠阈值。脚本内 0~45 秒随机抖动打散固定时刻。
- **失败重试**：某账号抛错后等 3 分钟补跑一次（可用仓库变量 `TA_RETRY_DELAY_SEC` 调整，设 0 关闭）。最坏空窗从 60 分钟压到约 34 分钟。各账号独立重试。
- **为什么不用 `*/20`**：cron 的 `*/25`、`*/20` 在不能整除 60 时会产生 10 分钟短间隔；脚本内 sleep 又会烧光额度。详见 `部署说明.md`。
- **自愈**：真休眠了，下一轮 `instance/start` 会远程拉起，代价只是断开约半小时，不会永久掉线。
- **缓存守门**：只有本轮至少一个账号成功才保存 `data/`；失败轮绝不写入空/残缺 JWT。每轮自动清理旧缓存，只保留最近 6 个，避免超过 GitHub 100 个缓存上限后 restore 失效。

## 已知限制

1. **境外 IP 风控**：GitHub 托管 runner 出口在境外，JWT 失效后重新登录时可能被判定异地（滑块/operationToken 失败）。缓解：JWT 复用天数内不重登 + 失败重试；偶发一轮失败，下一轮缓存恢复后自愈。若持续被拦，只能换国内自托管 runner。
2. **调度延迟**：cron-job.org 高峰可能延迟；`concurrency` 防并发 + 失败重试兜底。
3. **额度**：Public 仓库不限；Private 仓库每账号约 1440 分钟/月，多账号会超额。
4. **合规**：这是对平台回收策略的对抗性使用，且涉及积分接口，请自行评估账号风险。

## 文件清单

- `actions-keepalive.js` — 一次性保活脚本（多账号循环，复用 `lib/login` + `lib/keepalive` + `lib/api`）
- `.github/workflows/keepalive.yml` — 触发定义（仅 `workflow_dispatch`）
- `部署说明.md` — 详细部署与排错说明
- `lib/`、`package.json` 等 — 原仓库代码，保持不变

---

<details>
<summary>附录：原仓库的长驻 Dashboard 服务（本 Actions 版未使用）</summary>

原项目是一个长驻 Web 控制台（端口 8590），提供实例保活、一键打开云电脑、每日积分、电源管理、机器状态、企微通知等功能。本仓库的 GitHub Actions 版不依赖它，仅复用了 `lib/` 下的登录/保活/API 模块。

```powershell
cd teleagent-dashboard
npm install          # 仅需 ws 一个依赖
node server.js       # 打开 http://127.0.0.1:8590 → 「🔑 账号登录」登录
```

Docker 部署：复制 `.env.example` 为 `.env`，填 `TA_PANEL_USER` / `TA_PANEL_PASSWORD` 后 `docker compose up -d --build`。登录后 JWT 落盘 `data/jwt.txt`（容器内挂载卷持久化），自动接管并按 `reloginDays` 重登续期。

配置项（`data/config.json`）：`auth.account/passwordEnc`、`keepalive.enabled/mode/refreshSec`、`points.claim_time/catchup_on_start`、`power.restart_plan`、`notify.wecomWebhook`、`panel.pass_hash` 等，详见原仓库文档。

</details>
