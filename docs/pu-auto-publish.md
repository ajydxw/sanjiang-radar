# PU 活动自动发布

Windows 任务 `SanjiangRadar-PU-AutoPublish` 每天上午 09:00（电脑当地时间，当前为北京时间）采集并发布一次，不再每 30 分钟运行或每次登录都运行。错过计划时间时，任务计划程序会在条件允许后补跑。安装脚本只更新计划，不立即额外采集。电脑需保持开机、联网，Windows 用户需处于登录状态。采集使用同级 `sanjiang-radar` 项目中已有的 PU 官方登录会话。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-pu-sync-startup.ps1
Get-ScheduledTaskInfo -TaskName 'SanjiangRadar-PU-AutoPublish'
Get-Content -Encoding UTF8 .\.sites-runtime\pu-publisher\status.json
```

任务先检查是否已有 PU 采集或登录进程，每次最多读取 50 页，采集超时为 20 分钟。只有本轮完整成功且通过公开数据校验的 `pu.json` 才会更新本机公开数据和两份预览。Git 操作在 `.sites-runtime/pu-publisher/repo` 中执行，基于远程 `main` 提交，使用本机已有的 GitHub 凭证。GitHub Pages 工作流须对本次提交成功完成，公网文件的 SHA-256 须与本轮快照一致，状态才会写为 `published`。

`status.json` 记录最新阶段、错误码及最近一次已校验发布的提交。登录失效、采集不完整或发布失败时，任务退出并等待下一次调度。`queued`、`running` 和 `verifying-live` 表示正在等待发布确认。

PU 官方登录过期时，先确认采集已结束，再到同级 `sanjiang-radar` 项目手动执行 `node scripts/login-pu.mjs`。在打开的官方窗口完成登录并关闭，然后可以立即重试。

```powershell
Start-ScheduledTask -TaskName 'SanjiangRadar-PU-AutoPublish'
```
