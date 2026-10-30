# 可选姓名与完整学号确认

当前默认禁用，尚未上线。GitHub Pages 只托管静态文件，不能执行身份验证；公开页面应继续显示未开放，不发送姓名或学号，不尝试读取不存在的 API。游客与确认后的功能完全一致，仅同一句问候可以追加服务器确认的姓名。姓名和学号不是密码，这不是强身份认证，不能用于权限、成绩、缴费或私人资料访问。

## 本地接口

已有 `createRadarServer` 可注入 `identityAuth`。不传时创建未配置的身份模块，不搜索磁盘、不读取名单、不新增监听端口或常驻服务。服务端准备好且获得部署授权前，不启用前端入口。

| 请求 | 结果 |
| --- | --- |
| `GET /api/identity/session` | `{enabled:false,confirmed:false,name:null}`；配置后 enabled 为 true；有效会话才返回 confirmed:true 与 name |
| `POST /api/identity/confirm` | JSON `{name,studentId}`，完整字符串匹配，忽略输入首尾空白，保留学号前导零；成功返回上述会话结构和独立 Cookie |
| `POST /api/identity/logout` | JSON `{}`，删除服务器会话并清除 Cookie，返回 204 |

所有 POST 要求准确同源 Origin、JSON 和至多 4096 字节正文；公网 Origin 必须 HTTPS，仅本机可使用 HTTP。接口不接受查询参数，不提供名单、搜索、单字段校验、学号回显或管理员能力。姓名错、学号错、组合错和字段格式错均返回同一 401 提示。限流返回 429/Retry-After；未配置返回 503，仍可直接浏览。

`sanjiang_identity` Cookie 限定 `/api/identity`、HttpOnly、SameSite=Strict，公网增加 Secure。令牌随机生成，服务器内存仅保存令牌哈希、姓名和过期时间，默认最多八小时；再次确认替换当前令牌，退出、过期及服务器重启使其失效。不把学号或身份状态写入浏览器存储，不跨设备同步。

确认尝试有独立 IP 和全局令牌桶。IP 只来自真实套接字，不信任 X-Forwarded-For、Forwarded 或 X-Real-IP。代理后的访问者共享代理 IP 限额；需要更大规模时，应先验证可信代理和边缘限流，不能直接信任客户端头。最多保存 256 个限流地址和 256 个会话；接口不记录姓名、学号、IP、令牌或请求正文。

## 私有名单边界

`createIdentityAuth({roster:[{name,studentId}]})` 供受控服务器进程注入和合成测试使用，禁止将真实数据写入源代码、测试、命令行、构建、环境变量或 GitHub。另一种显式配置为 `createIdentityAuth({rosterPath})`：只允许本项目 `.sites-runtime/identity/` 下的 `.dpapi` 普通文件，沿用本机 Windows DPAPI CurrentUser 和当前用户/SYSTEM 的目录访问保护；不存在、解密失败或格式不正确时不开放功能。

加密后的载荷是仅服务器解密的 JSON 数组，字段只含 name、studentId，学号必须是字符串且不重复；不生成公开 JSON、公开哈希索引或名单下载接口。现有 DPAPI 工具加密输入限制 2048 字符、密文文件限制 8192 字符；超过限制须另行审查存储方案，不截断名单。名单在创建模块时加载，更新或删除名单后必须重启服务以清除旧会话。本轮没有导入真实名单、创建名单文件或启用此配置。

公开仓库、public、out、Next 构建产物、Actions、日志和截图均不得含真实名单。私有文件不得上传新服务。实际上线还需要维护者确认托管地点、名单放置授权、HTTPS 与运行维护安排；仅提交这些代码不能视为线上可用。

## 验证

前端仅在构建时显式设置 `NEXT_PUBLIC_IDENTITY_ENABLED=1` 才查询同源身份接口，并且需要后端返回 `enabled:true` 才显示姓名、学号输入框。未配置、服务离线、名单不可读时继续直接浏览，不声称确认成功。公开 Pages 工作流固定该开关为 `0`，不会向其他主机转发个人信息。此开关不是安全边界，真正匹配、会话和限流均由服务器完成。

本地合成数据联调：先以空 `NEXT_PUBLIC_BASE_PATH`、`NEXT_PUBLIC_IDENTITY_ENABLED=1` 构建，再执行 `npm run test:identity-ui`。测试启动临时回环服务并在结束时关闭，仅使用合成名单；不导入真实名单。发布前必须重新以 `/sanjiang-radar` 子路径、身份开关 `0` 构建并执行 `npm run test:pages`。

`node --test scripts/identity-auth.test.mjs` 仅使用合成名单，验证默认关闭、完整组合、统一失败、前导零、会话隔离/替换/失效/退出、安全来源、正文边界、代理头不能绕过 IP 限流及全局限流。静态 Pages 还应运行原有浏览器检查，保持默认无 API 请求和完整游客功能。
