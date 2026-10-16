# 三江雷达的项目参考

核对日期：2026-10-09。查看了公开仓库、元数据及下列代码文件。当前原型为自主实现，没有复制这些项目的代码，也没有直接运行第三方客户端。PU 学校查询、官方登录状态下的活动列表分页与详情读取已通过独立验证，并已接入网站与本机定时同步。

| 项目 | 可以参考 | 已核对的限制 |
| --- | --- | --- |
| [PU 活动助手](https://github.com/fengnightstarts/pu_client) | 学校列表、登录态、活动列表与详情、学院和年级筛选、报名起止时间 | 第三方客户端，当前未看到明确许可。三江雷达独立实现只读同步，已读完当前三江账号可见的综合列表并核对活动详情；账号可见范围不能等同全校覆盖。仓库还包含自动报名，其范围超出我们的 V1。 |
| [赛历 / competitions-platform](https://github.com/lucia212/competitions-platform) | 分类、收藏、竞赛卡片、截止排序 | MIT。当前 `frontend/src/App.tsx` 引入静态 `data/competitions`，`lastSync` 为固定字符串。界面展示不能证明实时采集已打通。 |
| [VPush](https://github.com/icekale/vpush) | 独立用户订阅、聚合动态、去重、多渠道通知、数据源状态 | MIT。当前针对社交平台，需要另写三江官网、PU 和竞赛适配；不能直接当校园版使用。 |
| [Campus Opportunity Hub](https://github.com/Nateesh07/Campus-Opportunity-Hub) | 校园机会列表、筛选、截止状态、来源入口、按来源独立处理 | README 声称 MIT，但当前树和 GitHub 元数据未发现对应许可文件。部分采集逻辑用相对当天日期补报名时间，亦包含写在代码中的活动，因此不能据介绍断言全部为实时权威数据。 |

## 实际读到的代码依据

- [PU 的 http_client.py](https://github.com/fengnightstarts/pu_client/blob/main/utill/http_client.py)：`get_school_list` / 学校列表请求、`get_activity_list` 与 `get_activity_info`；活动请求用登录 Token 和学校 `sid`。代码说明存在读取路径，但不证明三江学院当前可以稳定同步。
- [PU 的 filter.py](https://github.com/fengnightstarts/pu_client/blob/main/utill/filter.py)：`filter_by_join_end_time`、`filter_by_grade`、`filter_by_college`，可借鉴字段设计和可组合的筛选思路。
- [赛历 App.tsx](https://github.com/lucia212/competitions-platform/blob/main/frontend/src/App.tsx)：第 10 行引入静态记录，第 69 行 `lastSync` 是固定文案。
- [Campus Opportunity Hub tracker.py](https://github.com/Nateesh07/Campus-Opportunity-Hub/blob/main/services/tracker.py)：报名前、报名中、临近截止、已截止的状态计算。
- [Campus Opportunity Hub internet_fetcher.py](https://github.com/Nateesh07/Campus-Opportunity-Hub/blob/main/services/internet_fetcher.py)：存在公开 API 请求，但如第 138–139 行在日期缺失时生成时间，第 179 行之后以及 `_fetch_all_india_college_opportunities` 包含预设记录。三江雷达不把这样的日期补齐用于正式通知。

## PU 与三江学院的实际核验

2026-10-08 重新通过 GitHub 官方文件接口查看 `fengnightstarts/pu_client` 的代码，并独立查询代码使用的公开学校接口：

- 接口：`POST https://pocketuni.net/index.php?app=api&mod=Sitelist&act=getSchools`。
- 实际返回 HTTP 200，共 621 所学校；存在 `name: 三江学院`、`go_id: 235207080935424`。
- 该项目的 `School.from_dict` 读取 `name` 与 `go_id`，说明三江学院可以通过其学校选择逻辑识别。
- 活动列表地址为 `https://apis.pocketuni.net/apis/activity/list`，详情地址为 `https://apis.pocketuni.net/apis/activity/info`。代码使用登录 Token 和所选学校编号构建认证头，因此实际活动读取需要三江学院账号的有效登录状态。
- 另一个较旧仓库 `MarvinChiang/pocketuni-Kill` 的静态学校表记录 `620-三江学院`。这是旧字段体系的证据，不应把 620 直接当作当前接口的 `go_id`。

2026-10-09 的实际登录读取结果：

- 用户在官方网页版完成登录后，页面位于 `https://class.pocketuni.net/`。当前官方前端使用的活动列表、详情地址及认证头格式与上述 GitHub 代码一致。
- 保留专用浏览器资料，通过官方页面内的已登录会话发出只读请求；认证信息只在页面内使用，不返回到诊断结果或导出文件中。
- 选择学校编号为 `235207080935424`，与已查到的三江学院记录一致。
- 最初以 `sort: 1, page: 1, limit: 10` 验证 HTTP 200、业务码 0。随后发现「即将开始」排序仅返回 12 条，不能作为默认完整列表。
- 改用官方默认综合排序 `sort: 0`、每页 50 条，共读取 16 页、发现 753 条，分页自然结束。优先核对可行动与近期活动，保留 200 条已核对详情；更早且未读详情的历史记录仅保存本机列表档案。
- 真实标题示例：`【铁心桥校区】[文旅院]10.9宣讲会志愿者`、`由简及面，职赢未来 ——“启航雨花”职业指导培训`、`【铁心桥校区】[文旅院]南京小玩家科技有限公司宣讲会`。
- 列表含活动名称、学分、活动起止时间、报名开始时间、容量及已报名人数等字段；字段存在不代表每条活动都有明确值。
- 详情请求的活动编号使用数字，公开活动字段实际位于 `data.baseInfo`。读取到报名截止、活动结束、容量、奖励及学院/年级限制；不能把列表采集时间冒充发布时间，也不能把志愿时长上限冒充奖励。
- 网站仅服务 2026 级新生：明确排除 2026 级的记录隐藏，允许或资格未知的 166 条进入公开数据；该数量含历史记录，已截止活动默认不展示。
- 已接入独立 PU 数据源、手机页面和本机定时同步。每 30 分钟检查 PU，失败保留上次成功数据；运行依赖本机开机、同步进程及有效官方登录状态。

当前结论：已实际验证三江学院账号可见的真实列表分页与详情读取，并接入网站。尚不能证明该账号覆盖全校所有活动，也尚未建立云端全天运行服务。

专用窗口使用仅本次生效的直接连接参数访问官方网页，未修改系统代理设置。本机原先经系统代理访问时出现 `ERR_CONNECTION_CLOSED`，不能据此推断其他设备的网络原因。

通过 GitHub 官方 API 看到 [issue 10](https://github.com/fengnightstarts/pu_client/issues/10) 有报名接口返回“请更新到最新版本”的用户报告。它针对报名功能；本次独立实测的活动列表请求已成功。我们只参考读取路径，不验证或接入自动报名功能。

三江雷达自行实现分页边界、历史详情缓存、失败隔离与新生筛选。原项目固定 11 页、每页 10 条的逻辑不能直接当完整覆盖；异常消息可能拼接 Token，亦不适合原样使用。三江雷达的诊断不包含登录令牌或密码。

## 应用到三江雷达

当前原型已实现：信息卡片、学院/年级筛选、分类、搜索、收藏、日期排序、截止提示、报名未开始提示、未知资格标识、来源入口及独立的数据源接入状态。

后续采集与通知实现遵循：

1. 信息源统一输出标准结构，某个来源失败不影响其他来源。
2. 缺失的截止时间、资格、奖励不推测；正式记录保留证据与来源。
3. 同一活动关联多个来源，分别保留全国报名、校内选拔和作品提交日期。
4. 新信息和已收藏信息的截止提醒分别设计，不能把页面倒计时当成已经发送的通知。
5. PU 容量和剩余名额是同步时的快照，显示更新时间；不接入自动报名或签到。
