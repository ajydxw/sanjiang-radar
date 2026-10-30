# 可选姓名与完整学号确认

专用身份入口已配置为 `https://sanjiang-radar.tail43ed3c.ts.net/`；本机已授权导入35条姓名与完整学号，并完成私有回环验证。固定 HTTPS 的真实模式匿名接口与首页已返回200，Pages 通过链接跳转至该入口。GitHub Pages 只托管静态文件，不能执行身份验证；未配置并验收专用 HTTPS 入口时，公开页面继续显示未开放，不发送姓名或学号，不尝试读取不存在的 API。游客与确认后的功能完全一致，仅同一句问候可以追加服务器确认的姓名。姓名和学号不是密码，这不是强身份认证，不能用于权限、成绩、缴费或私人资料访问。

## 专用身份入口

正式 Pages 继续使用 `NEXT_PUBLIC_IDENTITY_ENABLED=0`。只有在 HTTPS 服务验收通过后，才通过 `NEXT_PUBLIC_IDENTITY_URL=https://已核实的身份域名/` 加一个顶层跳转链接，且 URL 必须为无用户名、密码、查询、片段或子路径的 HTTPS 根地址。`NEXT_PUBLIC_IDENTITY_ENTRY_MODE=test` 明确显示合成账号测试；只有真实名单已获授权配置且验收后才可显式设为 `real`。未配置或 URL 不合格时仍显示未开放。不能只把 Pages 的身份开关改为1，否则静态站没有 API。

跳转后在站长电脑的身份专用站内继续浏览同一套公开页面；姓名确认、问候和 Cookie 均留在这个同源站中，不跨站读取 Cookie、不回传姓名或令牌给 Pages。原网站的收藏和设置会保留，但不会自动同步到身份专用站。若用户主动回到 GitHub Pages，则仍按游客显示。公开快照会随该私有前端构建复制，未另配自动同步。电脑关机或隧道断开不影响原 Pages 的直接浏览。

专用服务 `scripts/serve-identity.mjs` 仅监听 `127.0.0.1:4312`（可显式指定其他空闲端口）。其 `identityOnly` 模式在其他业务模块初始化前隔离，只提供安全静态文件和 `/api/identity/session`、`confirm`、`logout`，其他 `/api/*` 一律404，不挂管理员、问答、共享点赞或抽签路由。私有文件不得放入静态输出目录。现有 cpolar 启动助手硬编码4311且对应完整服务，不能直接当作本专用服务启动器。

在项目目录构建独立私有前端（不覆盖正式 `out/`）：

```powershell
$env:RADAR_IDENTITY_BUILD='1'
$env:NEXT_PUBLIC_BASE_PATH=''
$env:NEXT_PUBLIC_IDENTITY_ENABLED='1'
$env:NEXT_PUBLIC_IDENTITY_URL=''
npm run build
```

导出位于 `.sites-runtime/identity-web/out/`。启动合成测试需显式设置 `$env:RADAR_IDENTITY_TEST_MODE='1'`、移除 `RADAR_IDENTITY_ROSTER_PATH`，再运行 `node scripts/serve-identity.mjs`；仅测试账号为“测试同学／000000001”，接口和界面都会标明测试，不应输入真实信息，测试会话另存 `.sites-runtime/identity/test-sessions/`。真实模式移除测试变量，仅设置 `RADAR_IDENTITY_ROSTER_PATH` 为已授权且已加密的本项目私有名单文件路径；未给路径或文件不能读取时拒绝启动，不搜索文件或导入名单。环境变量只放路径，不放名单内容。

需要公网时只能把已核实的 HTTPS 隧道指向这个专用端口，保留公网 Host 以通过准确同源校验，不能暴露4399配置助手、4310或其他服务；先以合成账号检查安全路径、登录/退出、刷新与 Cookie，再开放对应测试或真实入口。免费随机域名可能变动，更换域名会丢失该域名的 Cookie；没有稳定域名时不能承诺跨重连长期免确认，也不能用短暂 health 成功代替身份联通验收。返回正式 Pages 构建前需移除 `RADAR_IDENTITY_BUILD`，恢复 `/sanjiang-radar` 子路径和身份开关0；生产入口 URL 必须仍是已核实的地址。

## 本地接口

已有 `createRadarServer` 可注入 `identityAuth`。不传时创建未配置的身份模块，不搜索磁盘、不读取名单、不新增监听端口或常驻服务。服务端准备好且获得部署授权前，不启用前端入口。

| 请求 | 结果 |
| --- | --- |
| `GET /api/identity/session` | `{enabled:false,confirmed:false,name:null}`；配置后 enabled 为 true；有效会话才返回 confirmed:true 与 name |
| `POST /api/identity/confirm` | JSON `{name,studentId}`，完整字符串匹配，忽略输入首尾空白，保留学号前导零；成功返回上述会话结构和独立 Cookie |
| `POST /api/identity/logout` | JSON `{}`，删除服务器会话并清除 Cookie，返回 204 |

所有 POST 要求准确同源 Origin、JSON 和至多 4096 字节正文；公网 Origin 必须 HTTPS，仅本机可使用 HTTP。接口不接受查询参数，不提供名单、搜索、单字段校验、学号回显或管理员能力。姓名错、学号错、组合错和字段格式错均返回同一 401 提示。限流返回 429/Retry-After；未配置返回 503，仍可直接浏览。

`sanjiang_identity` Cookie 限定 `/api/identity`、HttpOnly、SameSite=Strict，公网增加 Secure。令牌随机生成，默认有效30天；有效会话通过 `GET /api/identity/session` 检查时，若剩余不足15天，则持久化续至该次检查后的30天。正常活跃使用会自动续期，无需反复输入；不是永久有效的登录。每次有效检查均把 Cookie 的剩余时长与服务器记录对齐，只有续期写入成功才会延长到期时间；无 Origin 的公网 GET 仍使用 Secure，绝不信任转发头降级 Cookie。退出、清除 Cookie、自然到期、站长撤销或更换网址后需要重新确认。不把姓名、学号或身份状态写入浏览器存储，不跨设备同步。电脑关机时身份服务暂不可用，恢复服务后仍可读取未过期会话。

通过私有 `rosterPath` 配置时，会话默认分条存于本项目 `.sites-runtime/identity/sessions/`，仅以令牌 SHA-256 哈希作为文件名；每条的姓名、过期时间和名单版本摘要通过现有 Windows DPAPI CurrentUser 加密。原始令牌和学号不写入会话文件；记录只有本机当前 Windows 用户可解密。重启 Node 服务或电脑不会主动清除这些会话。保存失败不签发 Cookie，读取或解密失败不认可确认状态。合成 `roster` 注入默认仍为隔离的内存会话，测试可显式指定本项目身份私有目录下的 `sessionDirectory` 验证持久化。仅运行一个身份服务进程；不支持多机共享此目录。

站长可在项目目录运行 `node scripts/revoke-identity-sessions.mjs` 撤销默认目录内全部身份会话，运行中的服务会在下一次会话检查时发现记录已删除。它不会改名单或管理员登录，不增加公网管理接口。自定义会话目录应由同一受控进程调用 `identityAuth.revokeAll()`；不向网页开放该方法。清除旧会话后仍可通过姓名与学号再次确认，这不是禁止某个学生使用功能。

读取、续期、退出、确认写入和本机撤销共用会话目录内的 `.write-lock` 小型互斥，续期在持锁后重新读取，不能重建已删除或过期的记录；同时避免现有 DPAPI 权限检查与另一操作删除文件交错。异常崩溃可能留下锁，后续操作最多等待5秒后拒绝，不自动猜测锁是否失效。恢复时先停止所有使用该会话目录的身份服务及撤销命令，核对目标确为本项目 `.sites-runtime/identity/sessions/.write-lock`（自定义目录使用对应路径），只删除这个空锁目录，再重启身份服务；保留名单和全部 `.dpapi` 会话文件。普通重启无需此步骤。

确认尝试有独立 IP 和全局令牌桶。IP 只来自真实套接字，不信任 X-Forwarded-For、Forwarded 或 X-Real-IP。代理后的访问者共享代理 IP 限额；需要更大规模时，应先验证可信代理和边缘限流，不能直接信任客户端头。最多保存 256 个限流地址和 256 个会话；接口不记录姓名、学号、IP、令牌或请求正文。

## 私有名单边界

`createIdentityAuth({roster:[{name,studentId}]})` 供受控服务器进程注入和合成测试使用，禁止将真实数据写入源代码、测试、命令行、构建、环境变量或 GitHub。另一种显式配置为 `createIdentityAuth({rosterPath})`：只允许本项目 `.sites-runtime/identity/` 下的 `.dpapi` 普通文件，沿用本机 Windows DPAPI CurrentUser 和当前用户/SYSTEM 的目录访问保护；不存在、解密失败或格式不正确时不开放功能。

加密后的载荷是仅服务器解密的 JSON 数组，字段只含 name、studentId，学号必须是字符串且不重复；不生成公开 JSON、公开哈希索引或名单下载接口。现有 DPAPI 工具加密输入限制 2048 字符、密文文件限制 8192 字符；超过限制须另行审查存储方案，不截断名单。已授权的35条主表最小JSON为1438字符，密文2517字节，直接适配现有限制，没有扩容公共工具；仅存于 `.sites-runtime/identity/roster.dpapi`。导入排除手机号、性别和宿舍等其他列，源xlsx只读且哈希未变。名单在创建模块时加载，更新或删除名单后必须重启服务；名单内容变化会使旧会话版本失效。已完成35组完整组合及回环真实模式验证。正式服务仅监听本机回环4312，由 Tailscale Funnel 提供固定 HTTPS 入口；匿名会话接口已确认启用真实模式，没有用真实学生信息做公网登录测试。

公开仓库、public、out、Next 构建产物、Actions、日志和截图均不得含真实名单。私有文件不得上传新服务。真实名单仅获授权用于本机身份核验。已验证 HTTPS 合成登录、Secure Cookie 与服务端会话读取，以及真实模式匿名入口；手机网络未实测。读取会话临时失败最多自动重试一次，提交确认和退出不自动重试。服务没有注册开机自启，站长电脑或服务离线时身份入口不可用。

## 验证

前端仅在构建时显式设置 `NEXT_PUBLIC_IDENTITY_ENABLED=1` 才查询同源身份接口，并且需要后端返回 `enabled:true` 才显示姓名、学号输入框。未配置、服务离线、名单不可读时继续直接浏览，不声称确认成功。公开 Pages 工作流固定该开关为 `0`，不会向其他主机转发个人信息。此开关不是安全边界，真正匹配、会话和限流均由服务器完成。

本地合成数据联调：先以空 `NEXT_PUBLIC_BASE_PATH`、`NEXT_PUBLIC_IDENTITY_ENABLED=1` 构建，再执行 `npm run test:identity-ui`。测试启动临时回环服务并在结束时关闭，仅使用合成名单；不导入真实名单。发布前必须重新以 `/sanjiang-radar` 子路径、身份开关 `0` 构建并执行 `npm run test:pages`。

`node --test scripts/identity-auth.test.mjs` 仅使用合成名单，验证默认关闭、完整组合、统一失败、前导零、会话隔离/替换/失效/退出、安全来源、正文边界、代理头不能绕过 IP 限流及全局限流。在 Windows 另验证 DPAPI 会话跨服务重建恢复、退出/撤销/过期、名单变更、伪造 Cookie 与密文破坏后的拒绝行为；临时文件只写入本项目忽略的身份测试目录并在结束时清除。静态 Pages 还应运行原有浏览器检查，保持默认无 API 请求和完整游客功能。
