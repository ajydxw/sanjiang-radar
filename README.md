# 三江雷达 · 班级信息工具

[打开三江雷达](https://ajydxw.github.io/sanjiang-radar/)

整理三江学院的学校通知、PU 活动、竞赛和考试办理信息，供同学查阅。GitHub Pages 托管页面和最近发布的数据快照，维护者电脑关机后仍可访问。

独立学生项目，与学校、PU 或微信官方没有隶属关系。网址公开，分享至班级群不构成身份验证。

## 网页功能

- 今日雷达、分类与关键词搜索、学院和资格筛选、截止时间、官方原文入口。
- 个人收藏、报名开始与截止提醒、导出 ICS 文件到手机日历。
- 上次访问后新增的信息标记，保留玻璃导航和手机适配。
- 收藏、资料和提醒选项仅存在当前浏览器；清理浏览器数据会清除它们，不跨设备同步。

当前发布的是纯静态信息版，不提供共享点赞、班级抽奖、管理员登录或 AI 在线答复。仓库保留的服务端模块和旧版功能说明供开发参考，不代表 Pages 正在运行这些接口。

## 本地运行

使用 Node.js 24：

```sh
npm ci
npm run dev
```

构建静态网页：

```sh
npm run build
```

生成的 out/ 可用静态服务器预览。发布到仓库子路径时，设置构建环境 NEXT_PUBLIC_BASE_PATH=/sanjiang-radar；现有 GitHub Actions 已设置。

## 更新信息

网页显示最近发布的快照，不会在 GitHub 上登录 PU 或自动采集。维护者在自己的电脑采集后，只导入经过校验的五份公开 JSON：

```sh
node scripts/import-public-feeds.mjs "采集项目/public/data"
npm run check:public
git add public/data
git commit -m "Update campus information"
git push origin main
```

推送后工作流自动检查、构建并部署。只有工作流成功后网页才会更新。浏览器每五分钟重新读取已发布快照，也可刷新读取。

首次在仓库 Settings → Pages → Source 选择 GitHub Actions。详见 [部署文档](docs/deployment.md)。

## 数据边界

public/data/ 仅发布校园信息，保留来源链接、更新时间和失败状态。密码、Cookie、PU 浏览器登录资料、私人问答、点赞数据库、班级报名与抽奖记录不进入发布包。

来源不保证完整覆盖；普通话等通知仍可能缺失，资格和具体安排以学校原文为准。过期活动移出首页收藏推荐，个人收藏历史保留。日历是一次性快照，改期或取消需手动修改手机日历。名额也是采集时快照。

代码采用 [MIT](LICENSE)，上游文章、第三方商标和依赖软件保留各自权利。参见 [第三方说明](THIRD_PARTY_NOTICES.md)。
