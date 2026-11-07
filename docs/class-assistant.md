# 班级生活助手

本功能使用站长自己的 API，先在本机准备，默认关闭付费请求。它与原有人工答疑队列、姓名学号问候功能分开；原问候登录不能使用付费额度。

## 额度与模型

这是一次性总预算，不是每日或每月刷新。35 位成员各分配 2,142,857 微美元（$2.142857），合计 $74.999995，剩余 $0.000005 不分配。切换模型、退出登录、重启服务都不补发额度。四个模型共享每个人自己的余额。Astra 另外限制每人累计最多 $0.35（350,000 微美元，按下述假设约 10 次），包含已用和未结算预占；它包含在总额度内，不是额外赠送。其他三个模型的额度规则不变，Astra 未使用的限额不会占住它们的余额。

按 2026-11-07 [OpenAI 官方标准价格](https://developers.openai.com/api/docs/pricing)配置，单位为美元/百万 token：

| 模型 | 输入 | 缓存输入 | 输出 | 每人预计次数 |
| --- | ---: | ---: | ---: | ---: |
| GPT-6 Astra | 10 | 1 | 50 | 10 |
| GPT-6.1 Sol | 2 | 0.10 | 10 | 306 |
| GPT-6.1 Terra | 1 | 0.05 | 5 | 612 |
| GPT-6 Luna | 0.10 | 0.01 | 0.50 | 6,122 |

界面默认选择并优先展示 GPT-6 Luna，标注“日常问答推荐”。其他模型仍可手动选择；用户本次手选后刷新余额不会强制切回 Luna。默认模型不可用时，按 Terra、Sol、Astra 的顺序选择可用模型。

次数假设每次完整请求为 1,000 输入 token、500 输出 token，无缓存优惠；Astra 按独立子额度估算，其他模型按完整个人余额估算，不是四份可以分别领完的次数。实际请求含系统提示与选中的校园资料，推理也占输出 token。按上游实际 usage 和配置价格结算，微美元以下向上取整。价格会变化，接 API 时必须重新核对；第三方平台的倍率、最低收费等不一定适用此价格。

默认每次输出上限 1,024 token，包含推理过程，不保证都能产生完整可见回答。每条问题最多 500 个 Unicode 字符，每条独立回答，不带前文。答疑仅使用公开资料，不支持工具执行、联网代理、上传文件或读取私有名单。

当前单轮问答采用 `prompt_cache_options.mode=explicit` 且不设置缓存断点，按[官方缓存说明](https://developers.openai.com/api/docs/guides/prompt-caching)关闭缓存读写，避免新模型默认缓存写入的额外费用。表中的缓存输入价保留作价格资料，不预先计算缓存优惠。遇到非零或异常的缓存写入用量，暂停计费并核对，不能把写入 token 按普通输入价偷偷结算。

## 35 人访问控制

站长在本机导入恰好 35 个唯一成员，每人领取独立随机访问码。服务端存储访问码哈希，登录后使用 HttpOnly、SameSite Cookie。名单、访问码领取表、会话和费用账本全部放在被 Git 忽略的 `.sites-runtime/class-assistant/`，不得复制进 `public/`、`out/`、GitHub 或发送给 API。

不提供公开注册。姓名或学号不作为密码，也不接受浏览器传来的成员编号来指定扣谁的额度。访问码只单独交给本人；如果主动把访问码借给他人，系统无法识别屏幕前实际是谁。

## 扣费流程

1. 服务端核验登录、模型、请求编号、问题范围和频率。
2. 用官方免费 [输入 token 计数接口](https://developers.openai.com/api/docs/guides/token-counting)计算完整请求，按未缓存输入加最大输出预占费用。额度不足时不发起生成。
3. 事务写入预占后才调用生成接口。同一个请求编号不能重复消费。
4. 返回有效 usage 后结算，释放多占的金额。输出 token 已含推理，不能再重复加收。
5. 超时、异常响应、缺失 usage 等结果不明时保留预占并暂停该账户的后续付费请求，交由站长核对。服务重启也不能把未确认的请求当成免费失败。

预算只覆盖通过本服务发起、按已确认价格计费的请求。应给本服务单独配置 API 项目/密钥，并保留提供方的消费限制；其他软件共用同一账户产生的费用不在本地账本内。提供方价格变化或不遵守用量/上限约定时，本地限额无法替代其真实账单。

## 部署边界

GitHub Pages 仅托管静态页面，不能保存 API 密钥或执行计费。班级助手需要一个独立同源 Node 服务，默认仅监听本机 `127.0.0.1:4314`。公网启用前需要正确的 HTTPS 域名与 Origin 配置。

前端设置 `NEXT_PUBLIC_CLASS_ASSISTANT_ENABLED=1` 后读取同源接口。普通静态站不配置该值时显示准备中；将来可用 `NEXT_PUBLIC_CLASS_ASSISTANT_URL` 链接到专用 HTTPS 入口。API 密钥只能配置在服务端，禁止任何 `NEXT_PUBLIC_` 密钥变量。

当前交付为未接真实 API 的框架。测试使用合成成员与模拟提供方，不代表真实 API、账号模型权限或公网手机连通性已经验收。

## 本机使用

需要 Node.js 24.16 或更高版本。在项目根目录执行：

```powershell
npm ci
npm run build:class-assistant
npm run serve:class-assistant
```

打开 `http://127.0.0.1:4314/assistant/`。关闭服务进程后网页和接口即停止，尚未设置开机自启。

首次初始化名册（本次已准备私有 `roster.json`，已经初始化后不要重建数据库）：

```powershell
npm run class-assistant:admin -- init --roster .sites-runtime/class-assistant/roster.json
```

输入格式为35条 `{ "name": "姓名", "memberKey": "班级内唯一标识" }`，不需要另收集学号。只能在本机使用。凭证领取文件为 `.sites-runtime/class-assistant/private-claim-codes.json`；不要整份发到班级群，应逐人分发。服务器的私有账本保留请求结果和用量用于防止重复扣费及对账，不向其他成员公开。

## 之后接入 API

1. 将 `config/class-assistant.example.json` 复制到 `.sites-runtime/class-assistant/config.json`，确认提供方确为 OpenAI 官方、四个模型对该 API 账号可用，并重新核对标准价格。
2. 在私有 `.sites-runtime/class-assistant/api.env` 写入 `CLASS_ASSISTANT_OPENAI_API_KEY=你的密钥` 和 `CLASS_ASSISTANT_CONFIG=.sites-runtime/class-assistant/config.json`。不要把密钥粘到网页或公开配置里。
3. 核对完成后，在私有配置里将 `pricingConfirmed` 和 `enabled` 都设为 `true`。默认不启用快速服务档位、付费工具或自动重试。
4. 使用 `node --env-file=.sites-runtime/class-assistant/api.env scripts/serve-class-assistant.mjs` 启动；公网发布还须设置正确的 `PUBLIC_ORIGIN=https://你的专用域名` 并配置 HTTPS 反向代理。
5. 先用本人账户发一条短问题，对照提供方用量和本地扣费，再交给同学使用。切勿把模拟测试当成真实接口验收。

如果是第三方兼容 API，需要先核实其模型 ID、价格、输入 token 计数及 usage 格式，再适配；本框架默认仅接受官方地址，不会把密钥发送到任意地址。

## 检查与对账

```powershell
npm run test:class-assistant
npm run typecheck
npm run class-assistant:admin -- audit
```

对账仅在本机运行。未确认费用需核对提供方账单后再处理，不应直接删除数据库、改余额或把预占请求当成免费失败。

同一账本只运行一个服务。`audit` 可以查看用量但不得改变正在进行的预占；`reconcile` 必须先停止服务。若程序异常退出留下私有服务锁，先确认对应服务进程确已停止，再处理锁文件，不能直接删除正在运行服务的锁。保留 `ledger.sqlite` 及相关日志文件，否则会丢失额度账本。
