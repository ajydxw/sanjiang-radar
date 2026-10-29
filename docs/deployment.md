# GitHub Pages 部署

网址：https://ajydxw.github.io/sanjiang-radar/

页面和五份公开信息快照由 GitHub 托管，不依赖维护者电脑或 cpolar。公开链接没有班级身份验证。

## 自动发布

1. Settings → Pages → Build and deployment → Source 选择 GitHub Actions。
2. .github/workflows/pages.yml 在 main 推送时运行，也可在 Actions → Publish Sanjiang Radar → Run workflow 手动触发。
3. 工作流安装 Node.js 24 依赖，检查日期、提醒、访问记录与公开数据，再构建 out/ 并部署。
4. 等待 build 和 deploy 均成功；失败先查看日志，旧页面通常仍保留上一次成功发布内容。

NEXT_PUBLIC_BASE_PATH=/sanjiang-radar 同时用于 Next 资源路径、favicon 和 JSON 请求。改仓库名或域名时需同步修改。

## 发布新信息

采集仍在维护者电脑执行，PU 需要有效登录。当前方案没有配置 GitHub 定时采集。

在此仓库目录运行：

```sh
node scripts/import-public-feeds.mjs "采集项目/public/data"
npm run check:public
git add public/data
git commit -m "Update campus information"
git push origin main
```

导入脚本只读取已知五份 JSON，先全部验证再替换。不复制 .sites-runtime/、登录资料、数据库、私人问题或班级名单。不要强制推送；远端有新提交时先整合。

## 本地验证

PowerShell：

```powershell
$env:NEXT_PUBLIC_BASE_PATH='/sanjiang-radar'
$env:NEXT_TELEMETRY_DISABLED='1'
npm ci
npm run build
npm run test:pages
```

浏览器测试使用本机 Microsoft Edge，以纯静态服务验证子路径、无 API 请求、搜索、收藏刷新保持、浏览器隔离、日历导出及手机宽度。

## 功能范围

个人收藏与资料只存在当前浏览器。ICS 需手动导入日历；关闭网页后的提醒由日历提供。Pages 不运行旧的 Node 后台，不提供共享点赞、报名抽奖或 AI 在线回答。

需要恢复多人互动时，应另外部署支持持久数据库的服务器。原电脑上的完整项目和历史抽奖结果未由此次发布改写。
