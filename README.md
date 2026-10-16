# 三江雷达

帮助三江学院2026级大一新生发现容易错过的校园信息：学校通知、PU活动、竞赛、考试和学生办理事项。

基于 Next.js、React、TypeScript 与 Node.js。个人学生项目，与三江学院、PU或微信官方没有隶属关系。

## 功能

- 今日雷达、分类搜索、学院与新生资格筛选、报名倒计时、官方原文入口。
- 共享爱心点赞、大家点赞/我的点赞、600ms爱心与彩色圆点动画。
- 关注活动的报名开始/截止提醒，导出 ICS 导入手机日历。
- 学校官网、PU、公众号链接、竞赛官网、考试通知的独立采集模块。
- 生活助手私有提问队列与管理员审核；没有内置自动模型调用或免费AI服务。
- 无需运行脚本即可读取通知的 `/read` 文字阅读版。

## 开始使用

需要 Node.js 22.18+。浏览器采集另需 Microsoft Edge；PU登录与会话保护当前依赖 Windows。

```sh
git clone https://github.com/ajydxw/sanjiang-radar.git
cd sanjiang-radar
npm ci
npm run dev
```

打开开发工具显示的本机地址（默认 `http://localhost:3000`）。安装脚本只会从 `examples/feeds/` 初始化缺失的五份空数据，不覆盖已有内容。如果安装时禁用了脚本，请先运行 `npm run setup:feeds`。

**仓库提供源码与空模板，不包含维护者的账号、真实PU数据、公众号文章正文、私人提问或浏览器登录资料。** 初次运行没有活动属于正常状态；需要使用自己的合法来源与账号采集。

## 运行完整网站

```sh
npm run build
npm run serve
```

默认地址为 `http://127.0.0.1:4173`，后端提供共享点赞、私有提问与文字阅读版。可通过 `RADAR_PREVIEW_PORT` 和 `RADAR_PREVIEW_HOST` 配置监听地址。只运行 `npm run dev` 用于前端开发，不提供上述Node后端接口。

管理员初始用户名是 `admin`，没有预设密码。运行 `npm run setup:admin` 后，在本机 `http://127.0.0.1:4398` 设置独立密码，再通过 `/#admin` 登录。公网管理登录需要 HTTPS。详见 [管理说明](docs/admin.md)。

## 信息采集

```sh
npm run collect:school
node scripts/login-pu.mjs
npm run collect:pu
npm run collect:wechat
npm run collect:competitions
npm run collect:exams
npm run sync:watch
```

首次PU登录在官方网页完成，采集时关闭专用登录窗口。一次只启动一个使用该浏览器资料的进程。请自行核对来源的访问规则、账号权限与发布范围；仅采集活动列表和详情，不包含自动报名、签到或抢名额。

竞赛PDF解析可选安装 Python 3 与 `pip install -r requirements.txt`。Python需在 PATH 中，或通过 `RADAR_PYTHON` 指定可执行文件。公众号目前支持文章链接导入，自动发现新推送和易班尚未接入。普通话等校内考试通知仍有覆盖缺口，省级安排不能代替校内新生资格核验。

采集会生成 `public/data/*.json`，原始资料、账号状态、点赞与问答存入 `.sites-runtime/`。它们默认被 Git 忽略。截止时间、资格与奖励未确认时保持未知；来源失败保留上次成功结果。

## 检查

```sh
npm run build
npm run typecheck
npm run test:collector
npm run test:security
npm run test:admin
npm run test:assistant
npm run test:reading
```

浏览器交互检查另外使用 `npm run test:likes`、`npm run test:reminders`、`npm run test:visits`，需要已安装 Edge。构建应先于类型检查，以生成 Next.js 类型文件。

## 部署与限制

静态导出位于 `out/`；仅上传静态文件不会提供共享点赞、问答收件、管理或 `/read` 后端。完整部署需运行 Node 服务，公网建议使用 HTTPS 反向代理。采集与网站可分开运行，需自行配置定时任务与权限。详见 [部署说明](docs/deployment.md)、[安全设计](docs/security.md)、[PU接入](docs/pu-collection.md)。

日历文件是一次性快照，改期或取消不会自动撤回手机旧提醒；名额为采集时快照；匿名浏览器点赞不等同真实人数。项目还处于原型阶段，不保证通知完整覆盖。

## 目录

- `src/`：页面、筛选、点赞、日历提醒和管理界面。
- `sources/`：来源解析、字段与公开数据校验。
- `scripts/`：采集、Node服务、私有队列与检查。
- `examples/feeds/`：可公开分发的空数据模板。
- `docs/`：接入、部署与功能说明。

欢迎用脱敏问题和代码改进参与项目。提交前检查没有加入密码、令牌、Cookie、真实问答和采集档案，参见 [贡献说明](CONTRIBUTING.md)。

## 许可证与参考

本项目源码采用 [MIT](LICENSE)。上游网站内容、第三方商标和依赖软件保留各自权利，不因本项目开源而被重新授权。参考与依赖说明见 [第三方说明](THIRD_PARTY_NOTICES.md) 和 [项目参考](docs/open-source-references.md)。