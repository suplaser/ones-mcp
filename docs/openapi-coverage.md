# Open API 覆盖与验证

本项目直接使用用户级个人 API Key。大部分接口使用 `https://sz.ones.cn/openapi/v2`；属性选项使用同一站点的 `/openapi/v3alpha`，凭据详情位于 `/oauth2/introspect`。所有接口均使用所配置的 API 站点，不将凭据发送到额外站点。

## 0.6.0 每日计划与登记工时

新增 `ones_get_daily_hours`，由现有工作项列表和简单模式已登记工时列表组合计算，不调用新的业务写接口。当前合计 30 个工具（19 个只读、11 个需用户确认的写工具）。

### 计算与范围

- 必填 `teamID/startDate/endDate`，日期为 `YYYY-MM-DD`、含两端，单次最多 366 天。可选 `projectID/issueTypeID/userIDs`，或 `mineOnly=true` 核验当前用户身份；本工具不接受起始游标，报告每次从来源第一页开始计算。
- 默认时区 `America/Los_Angeles`，可通过 `timeZone` 选择有效 IANA 时区。当前日期与工时工作日期都通过该时区转换，不依赖执行机器时区。日历计数使用日期标签，避免夏令时 23/25 小时的日期造成分母变化。
- 计划余额为 `max(timeEstimatedHour-timeSpentHour,0)`，只用工作项自身字段，不使用父子 `total*` 聚合值或 `timeRemainingHour`。累计扣减包含查询区间外、其他登记人的实际工时。缺失或非法字段不作为零。
- 分摊从所选时区今天开始，或显式 `allocationStartDate` 指定的未来日期，不允许过去起算日。`calendar=weekdays` 为默认周一至周五，不扣法定节假日；可选 `calendarDays`。分母为起算日至到期日（含）的全部有效日期，再截取展示区间。超过约十年的分摊周期单列为 `horizonTooLong`。
- `dueDate` 只接受已验证的日期字符串，不猜测任意数字或时间单位。缺失、非法、早于起算日、期间没有有效工作日均单列。过去展示日期只有实际登记，计划不还原历史。
- 人员条件仅对计划使用 `assignee.id`，对实际登记使用 `owner.id`；来源工作项不按负责人提前过滤，避免漏掉在他人工作项上登记的工时。`excludePlannedStatusIDs` 只影响计划，仍读其实际登记，不按状态名称猜测完成类别。
- 工时记录 `startTime` 使用 Unix 秒，整条 `hours` 归到该时区的工作日期，不按录入时间或时间跨度分摊；周末登记照常统计。不完整或无法归属的记录被计数并降低完整性。

### 输出与读取限制

`range` 明确展示区间、时区、今天、分摊起算日和日历；`scope` 明确团队、项目、类型、人员及计划排除状态。`days` 返回每日计划小时、登记小时与记录数量；`allocations` 返回逐项估计、累计登记、余额、到期日、分摊天数和日均值。`totals` 是展示区间合计，以及已知余额和已知未分摊余额；`unallocated` 包含逐项原因，余额未知时不补零。仅输出时保留八位小数，合计不累积逐行舍入误差。

默认最多 100 个来源工作项、10 页工作项和每项 10 页工时，每页 100 条；分别可通过 `maxIssues`（最多 500）、`maxIssuePages/maxWorklogPagesPerIssue`（最多 20）调整。总读取预算约 25 秒，不自动重试。每种列表在本次读取内按 ID 去重，重复/缺失游标或整页重复时停止。项目、类型在来源返回后还会复核；未知范围会计数。调用方取消返回取消错误，不伪装成成功的部分统计。

`coverage` 报告来源扫描、工时读取、计划输入是否完整，以及页数、去重、未知范围和非法工时记录数量；`problems` 只返回安全错误码与有关工作项 ID。`complete=false` 时每日数值只代表已读可判定的部分。无到期日等明确未分摊情况单列时，来源可以是完整的；另外通过 `allKnownRemainingHoursScheduled=false` 明确余额没有全部安排。完整性只针对本次权限可见资源和已读字段，不代表原子快照或全组织数据。

只读权限需求为工作项读取及 `read:project:issue-timeSpent`；`mineOnly` 还需身份核验。仅支持简单工时模式，其他模式不能将本工具结果视为完整。计划预测无需 MCP 写入确认，原有全部写工具的确认规则保持不变。

### 0.6.0 验证记录（2026-11-12）

- `npm test`：157 项，156 通过，1 项 Windows 跳过 Unix 权限测试，0 失败。17 项新增测试覆盖公式与累计扣减、日均分母、历史展示、人员归属、周末、洛杉矶/上海与夏令时、未分摊、缺失字段、分页及去重、权限、预算、取消、舍入及真实 MCP 协议输出。
- 本机已有凭据启动真实 stdio：版本 0.6.0，发现 30 个工具，其中 19 个只读。
- 一次完整读取 43 个工作项和 16 条唯一工时记录，返回七天汇总，`coverage.complete=true`。13 个仍有余额的工作项缺少到期日，单列 `missingDueDate`，`allKnownRemainingHoursScheduled=false`，没有把它们视为零工作量。
- 非空工时样本的完整记录小时合计与工作项自身累计登记一致；另按该样本的工作日期和登记人汇总，返回非零登记工时并读取完整。真实样本没有有效到期日，计划的非零分摊由模拟数据和边界测试验证。
- 仅发送 GET 查询，没有业务写入；未打印真实 ID、姓名、日期记录正文或凭据。

## 0.5.0 组合检索、评论与工时维护

当前合计 29 个工具：18 个只读、11 个需要用户确认的写工具。以下七个新写工具全部复用 0.4.0 的确认、预览、凭据绑定、重复请求与不确定结果保护。

| MCP 工具 | 官方路径（相对于 `/openapi/v2`） | 参数与范围 |
| --- | --- | --- |
| `ones_send_issue_comment` | `POST /project/issues/{issueID}/comments` | `text`；可选 `repliedMessageID` 回复已有评论 |
| `ones_update_issue_comment` | `PUT /project/issues/{issueID}/comments/{commentsID}` | `commentID` 映射至路径，`text` 完整替换正文 |
| `ones_delete_issue_comment` | `DELETE /project/issues/{issueID}/comments/{commentsID}` | 删除指定评论，不发送请求正文 |
| `ones_update_issue_worklog` | `PUT /project/issues/{issueID}/workLog/simple/timesSpent/{timesSpentID}` | `worklogID` 映射至路径；完整提供 `hours`、`startTime`、`owner.id`、`description` |
| `ones_delete_issue_worklog` | `DELETE /project/issues/{issueID}/workLog/simple/timesSpent/{timesSpentID}` | 删除指定实际工时，不发送请求正文 |
| `ones_set_issue_estimated_hours` | `POST /project/issues/{issueID}/workLog/simple/timesEstimated` | `hours` 设置预估工时 |
| `ones_set_issue_remaining_hours` | `POST /project/issues/{issueID}/workLog/simple/timesRemaining` | `hours` 设置剩余工时 |

所有写入均带 `teamID` 查询参数。评论正文依官方参数声明保守限制为非空且最多 128 字符，不采用示例中更大的长度。评论 Scope 为 `write:project:issue-comment`；实际、预估、剩余工时分别为 `write:project:issue-timeSpent`、`write:project:issue-timeEstimated`、`write:project:issue-timeRemaining`。实际工时必须大于零；预估和剩余工时允许零；小时数最多五位小数。更新实际工时的描述在本工具中必填，空字符串明确表示清空，避免省略导致含义不明。

评论修改、删除及回复先从评论列表核验原记录；目标未出现在列表时返回 `COMMENT_UNVERIFIED`，不能断言已不存在，也不绕过分页限制写入。工时修改和删除先读取记录详情并验证 ID。确认后再读目标子记录，变化时停止。确认内容包含原文或原记录，删除不提供恢复。除工时修改返回记录外，新工具接受官方仅含 `SUCCESS`/`success` 的成功响应，不虚构新评论 ID；写入发送后响应不明确仍为 `WRITE_OUTCOME_UNKNOWN`。

### 组合检索语义

`ones_search_issues` 使用 `GET /openapi/v2/project/issues` 的游标分页，不调用 ONESQL。向来源发送 `teamID`、`limit`、可选 `cursor/projectID/issueTypeID`，其余条件在本地筛选：

- `keyword` 只按标题做不区分大小写的字面包含匹配；不执行 SQL 或正则。
- `assigneeIDs`、`statusIDs`、`excludeStatusIDs` 各自支持多个 ID；`assignedToMe=true` 通过当前凭据的 active 用户 ID 筛选，不能与 `assigneeIDs` 同用。
- 项目、类型、标题、负责人、状态、创建和更新时间条件之间为 AND；ID 数组内部为 OR。项目和类型还会对返回记录做本地复核。
- `createdAfter/createdBefore/updatedAfter/updatedBefore` 为 Unix 秒，包含给定边界时间点。当前列表的 `createTime` 样本为微秒时间戳；`sourceTimeUnit` 默认 `microseconds`，可显式选择 `milliseconds` 或 `seconds`。不按数值大小自动猜测，返回记录保留原始时间，不混用工时记录的秒时间戳。
- 默认 `pageSize=100`、`maxPages=3`，最大每批 10 页、每页 100 条，约 25 秒总预算。无匹配仍会继续扫描后续页；调用方取消返回取消错误，不伪装成成功的部分结果。
- 返回 `scan.scannedCount/returnedCount/unknownFieldCount/duplicateCount/pagesRead/startedFromCursor/sourceTimeUnit/exhausted/stopReason`；这些仅统计本批，不提供匹配总数。`exhausted` 仅说明到达来源末页，不保证缺字段的记录已能判定，也不说明从中间游标开始的一批覆盖了前面记录。
- 页数或时间预算耗尽时使用 `scan.nextCursor` 续查，保持其余参数一致。单批内按 ID 去重；跨批由客户端合并。重复/缺失游标、连续整页重复会以 `paginationUnavailable` 停止，不无限翻页。并发修改下不保证快照一致或无遗漏。
- 过滤所需字段缺失时不将该记录当匹配；除非其他条件已明确排除，否则计入 `unknownFieldCount`。当前部署全部 43 条列表样本缺少 `updateTime`，按更新时间筛选返回 43 条无法判定，不能将空匹配解释为没有更新过的工作项。详情中的其他时间字段未被猜作更新时间。

本次 ONESQL 只读探测中，普通 `LIMIT 2`、字面条件可用，但参数化标题条件未命中已知数据，`LIMIT 0,2` 未限制为两条，游标投影报错。原因未确定，暂不开放通用 ONESQL 或承诺其完整分页。

### 0.5.0 验证记录（2026-11-12）

- `npm test`：140 项，139 通过，1 项在 Windows 跳过 Unix 权限测试，0 失败。新增覆盖七种写请求、批准/拒绝、DELETE 无正文、原记录变化、未知结果防重放，以及组合条件、游标异常、缺字段、明确时间单位、时间预算、取消和凭据遮蔽。
- 使用本机已有凭据启动真实 stdio：版本 0.5.0，发现 29 个工具，其中 18 个只读。扫描当前可见的 43 个工作项到末页；每页一条的游标续查成功。
- 真实标题、项目、类型、负责人、状态及创建时间组合筛选命中已知一条工作项；“我负责”得到 33 条并逐项与当前用户核对。缺失更新时间被计入 43 条无法判定记录。
- 发送评论、修改/删除实际工时、设置预估/剩余工时共五个工具以 `previewOnly=true` 完成预览。前十个工作项中未找到评论目标，评论修改、删除及回复目标核验由模拟测试覆盖，不声称已真实预览这些路径。
- 真实调用没有发送任何业务写入；当前客户端确认界面与远端实际写入接受情况未由本次验证证明。输出仅记录状态、数量和结构，不保存凭据、人员信息或业务正文。

## 0.4.0 写操作与确认

| MCP 工具 | 官方路径 | 范围 |
| --- | --- | --- |
| `ones_create_issue` | `POST /openapi/v2/project/issues` | 创建工作项，显式提供负责人、标题、项目、类型、属性和关注者；可提供父工作项 |
| `ones_update_issue` | `PUT /openapi/v2/project/issues/{issueID}` | 仅更新显式提供的标题、负责人、属性；不更新状态 |
| `ones_execute_issue_workflow` | `POST /openapi/v2/project/issues/{issueID}?action=executeWorkflow` | `workflowID` 映射为正文 `id`，可提供步骤属性、评论、附件、Wiki 关联与工时参数 |
| `ones_add_issue_worklog` | `POST /openapi/v2/project/issues/{issueID}/workLog/simple/timesSpent` | 简单模式实际工时登记，`hours` 为小时、最多 5 位小数，`startTime` 为 Unix 秒，登记人使用 `owner.id` |

保留 17 个只读工具，新增这 4 个写工具，共计 21 个。写工具标注 `readOnlyHint=false`、`destructiveHint=true`、`idempotentHint=false`；这些提示不代替服务端确认。

### 批准与执行边界

1. 严格校验输入，拒绝未知参数。属性 `value` 必须显式提供，`null` 表示清空；禁止重复属性 ID。普通修改工具拒绝系统状态属性 `field005` 或类型 12，状态应通过工作流流转。
2. 核验当前凭据为 active 且有用户 ID，读取目标项目/工作项及可执行工作流。创建子工作项时读取父项。详情表单不等于完整新建必填规则，不自动填充未知字段或默认值。
3. `previewOnly=true` 返回不可变请求的预览，不弹确认、不写入。实际执行必须由客户端显式声明 `elicitation.form`，否则返回 `CONFIRMATION_UNAVAILABLE`。
4. 使用与本次工具请求关联的 `elicitation/create` 表单，展示站点、身份、目标、方法、完整 URL 与正文。确认勾选默认 false；必须同时满足 `action=accept` 和布尔值 `confirm=true`。`confirmed` 工具参数无效。
5. 确认及后续准备的时限为 5 分钟；拒绝、取消、无响应或过期均不发送写入。超过 64 KiB 的确认内容会被拒绝，不截断后让用户批准。
6. 发送前检查凭据与预览一致，重新读取已有工作项及所选工作流；变化时停止。请求使用同一份参数快照，确认期间的调用方修改不会改变发送内容。
7. 工作流会执行其在 ONES 中配置的后置动作。`linkedWikiPages=[]` 会主动清空关联，非空数组全量替换，省略或 null 不请求更新；这些内容必须出现在确认预览中。

前后读取检查不构成 ONES 服务端的原子版本锁；读取后到写入间仍可能存在并发变化。MCP 用户确认依赖可信客户端将表单展示给用户并返回决定，服务不能证明任意第三方客户端背后确有人工操作。

### 重复请求及不确定结果

- 每个逻辑操作需要 `requestID`。同一进程内相同 ID、相同参数共享一次准备、确认及结果；不同操作或参数复用 ID 返回 `REQUEST_ID_CONFLICT`。拒绝、取消与错误结果也会被记住，重放不重新弹窗。
- 预览不占用执行 ID。当前进程最多记住 1000 个实际调用，达到上限后拒绝新写请求，不淘汰不确定记录。服务重启后记录不保留，不提供跨进程或 ONES 服务端幂等保证。
- 发送前的失败不会尝试写入。发送后的网络故障、取消、HTTP 5xx、非法响应、成功标志缺失或响应目标不符报告 `WRITE_OUTCOME_UNKNOWN`，不自动重试，也不建议更换 ID 重试；必须先查询确认结果。
- 明确的认证、权限、参数、资源不存在及限流拒绝返回对应安全错误码。写响应必须有明确 `SUCCESS`/`success` 标志并满足结构校验；工作流允许成功但不含 data 的官方响应。
- 当前请求记录在进程内存中，不持久化操作正文或凭据。API Key 不出现在预览、响应或日志中。

创建、修改和流转需要 `write:project:issue`；工时登记需要 `write:project:issue-timeSpent`。预览及执行还需要凭据身份、项目或工作项的读取权限。具体可用性、表单必填规则及工时模式仍由部署与业务权限决定。

### 0.4.0 验证记录（2026-11-12）

- `npm test`：110 项测试，109 项通过、1 项在 Windows 上跳过 Unix 权限测试，0 失败。
- 模拟 API + 实际 MCP 协议链路覆盖四种写请求的方法/正文映射、用户确认、拒绝/取消/超时、伪造批准参数、不可变快照、凭据/工作项变化、工作流失效、并发重放、结果未知及禁止重试。
- 本机已有凭据启动真实 stdio 服务：版本 0.4.0，发现 21 个工具；四个新工具均以 `previewOnly=true` 完成身份和目标只读核验。
- 未执行真实创建、修改、状态流转或工时登记。实际写入接受情况和当前客户端的人机确认界面尚未经真实写入验证，不能把模拟成功等同于远端写入成功。

## 0.3.0 新增接口

| MCP 工具 | 实际路径 | 参数与范围 |
| --- | --- | --- |
| `ones_get_field_options` | `POST /openapi/v3alpha/field/options` | 查询参数 `teamID`；正文将 `fieldID`、`optionIDs`、`includeFields` 分别映射为 `field_uuid`、`uuids`、`include_fields`；可传 `keyword`、`limit`、`offset` |
| `ones_list_issue_statuses` | `GET /openapi/v2/project/issueStatuses` | `teamID`；团队级状态，保留原始 `pageInfo`，不增加官方未声明的项目或分页参数 |
| `ones_list_issue_workflows` | `GET /openapi/v2/project/issues/{issueID}?action=executableWorkflow` | `teamID`、工作项内部 ID；返回 `workflows` 数组，不执行工作流 |
| `ones_list_issue_comments` | `GET /openapi/v2/project/issues/{issueID}/comments` | `teamID`、工作项内部 ID；返回 `list`，仅当服务端提供 `pageInfo` 时保留 |
| `ones_list_issue_worklogs` | `GET /openapi/v2/project/issues/{issueID}/workLog/simple/timesSpent` | `teamID`、工作项内部 ID、`limit`、`cursor`；每次最多请求 100 条 |
| `ones_get_issue_worklog` | `GET /openapi/v2/project/issues/{issueID}/workLog/simple/timesSpent/{timesSpentID}` | `worklogID` 映射至路径中的 `timesSpentID`，返回 `worklog` 对象 |

这六个接口均只读，合计 17 个 MCP 工具。属性选项的 POST 不写入业务数据，不自动重试。

### 返回语义与部署差异

- 属性选项文档提供相对路径 `/field/options`；本机已验证 v3alpha 路径可用，v2 路径返回 404。较旧部署可能尚未提供该能力。
- 选项结构因属性类型而异；保留原始键及可能出现的 `__reference_object__` 包装，不将成员或项目选项强制转换成固定选项结构，不补造默认值。
- `limit` 默认 20，本工具限制为 1–100；`offset` 默认 0。官方文档未声明数量上限，本工具的 100 是本地请求限制。接口不提供总数或 `hasNextPage`。
- 本机三个选项属性的 `limit` 和关键词筛选有效，但 `offset=1` 与 `offset=0` 返回相同首项；参数按文档发送，暂不承诺部署实际支持完整翻页。客户端遇到重复选项应停止，不能将同一首项无限翻页。
- 团队状态列表不代表每个项目可用的全部状态，也不等于当前工作项允许的流转；后者应读取可执行工作流。
- 评论兼容文档中的小写 `success`。真实部署可直接返回数组，转换为 `list`，不虚构 `pageInfo`。文档只声明 `teamID`，本工具不增加未声明的 `limit/cursor` 参数；缺少分页信息或 `hasNextPage=true` 时不能保证完整。
- 工时查询仅适用于简单模式，`hours` 保留原始小时数及小数，`startTime` 为 Unix 秒。已登记工时、预估工时和剩余工时分别处理，不从单页计算完整总工时。
- 相关读取 Scope：属性选项 `read:project:issueField`、状态 `read:project:issueStatus`、工作流 `read:project:issue`、评论 `read:project:issue-comment`、工时 `read:project:issue-timeSpent`。具体可用性仍取决于部署、Scope 和业务权限。

### 0.3.0 验证记录（2026-11-12）

- `npm test`：76 项测试，75 项通过、1 项因 Windows 环境跳过 Unix 文件权限测试，0 失败；包含构建与真实 stdio 发现工具测试。
- 使用本机已有凭据启动真实 stdio MCP：服务版本 0.3.0，`tools/list` 返回 17 个工具，六个新增工具均调用成功。
- 状态列表、非空工作流、属性选项、非空工时列表和已登记工时详情均完成真实读取。评论样本返回空数组；非空评论和分页对象兼容由模拟测试覆盖。
- 选项偏移未生效，已在上方记录；工时游标分页由模拟测试验证，本次真实样本未证明存在下一页。
- 所有真实调用仅执行查询；验证输出仅记录状态、数量和结构，不保存凭据、人员信息或业务正文。
- 高级检索暂未接入：本次 ONESQL 只读探测中，参数化条件与 `LIMIT offset, size` 样例未得到预期结果，原因尚未确定；不将这些探测报告为已完成的检索能力。

## 0.2.0 新增接口

| MCP 工具 | 官方路径 | 参数与范围 |
| --- | --- | --- |
| `ones_get_current_user` | `GET /oauth2/introspect` | 无参数；返回 active、用户 ID、组织 ID、Scopes 和过期时间，不返回凭据 |
| `ones_list_teams` | `GET /openapi/v2/account/teams` | 无参数；用户在当前组织中有权访问的团队，不分页 |
| `ones_search_users` | `GET /openapi/v2/account/users/search` | `teamID`、可选 `keyword`、`limit`、`cursor`；每页最多 100 |
| `ones_list_issue_types` | `GET /openapi/v2/project/issueTypes` | `teamID`；保留官方 pageInfo，不添加未声明的分页或项目筛选参数 |
| `ones_search_issue_fields` | `GET /openapi/v2/project/searchIssueFields` | `teamID`、可选 `keyword`、`limit`、`cursor`；默认及最大 500，关键词只匹配字段名称 |
| `ones_get_issue_form_fields` | `POST /openapi/v2/project/issueFormFields` | 查询参数 `teamID`；将 `projectID`、`issueTypeIDs` 映射为正文中的 `project_uuid`、`issue_type_uuids` |

这六个接口均只读，包括使用 POST 的详情表单字段查询。原有四个项目、工作项接口及本地 `ones_auth_status` 继续保留。

## 重要语义

- 当前用户工具通过凭据详情读取 `sub`，输出为 `userID`，不据此虚构姓名或完整个人资料。Scopes 按逗号或空白拆分并去重，不返回未声明的 OAuth 字段。
- `active: false` 原样返回；缺失用户 ID 不会生成默认身份。凭据可用不代表具备所有资源权限。
- 工作项类型是团队级结果，不能假设每个项目都使用全部类型；测试角色以返回的 `testRole` 为准。
- 属性目录接口使用新版 `searchIssueFields`，覆盖官方文档标明的完整目录；较旧的 `issueFields` 列表不保证覆盖全部属性。
- 属性目录只提供静态元数据，不包含选项和默认值；0.3.0 新增独立的属性选项工具，未提供完整默认值规则。
- 详情表单查询返回字段并集，不包含新建表单、步骤表单、隐藏字段、编号字段，也不保证展示顺序。`required` 仅表示团队属性定义，不能作为完整的新建必填规则。
- 不使用固定字段 ID 回退，也不自行换算未知类型的字段值或工时单位。
- POST 表单查询不自动重试，保持与其他查询一致的超时、取消、错误处理及凭据遮蔽。

相关读取 Scope 包括 `read:account:teams`、`read:account:user`、`read:project:issueType`、`read:project:issueField`。接口能否执行仍由实际部署版本、API Key Scope 和 ONES 业务权限共同决定；不因本机验证成功而承诺其他 Key 或部署可用。

## 验证记录

2026-11-11，本机已有凭据通过真实 stdio MCP 进程验证：

- `tools/list` 返回 11 个工具，服务版本为 0.2.0。
- 当前凭据 `active` 为 true；六个新增工具调用全部成功。
- 用户搜索、属性目录的第二页调用成功。
- 原有四个业务查询及本地配置状态查询成功。
- 42 项自动化测试通过，覆盖输入校验、响应差异、字段保留、Scope 失败、凭据遮蔽、版本一致性和 MCP 调用。

验证只读取真实业务数据，输出仅记录成功状态及数量，未执行 ONES 写操作，未保存或输出真实凭据、姓名、邮箱和业务正文。

## 官方文档

- [创建工作项](https://docs.ones.cn/developer/openapi/api/02-create-a-new-issue/)
- [更新工作项](https://docs.ones.cn/developer/openapi/api/04-update-a-issue/)
- [执行工作流](https://docs.ones.cn/developer/openapi/api/02-execute-workflow-for-issue/)
- [添加简单模式实际工时](https://docs.ones.cn/developer/openapi/api/04-add-spent-time-of-issues/)
- [属性选项](https://docs.ones.cn/developer/openapi/api/get-field-options/)
- [工作项状态](https://docs.ones.cn/developer/openapi/api/get-a-list-of-issue-status/)
- [可执行工作流](https://docs.ones.cn/developer/openapi/api/01-get-a-list-of-issue-workflows/)
- [评论列表](https://docs.ones.cn/developer/openapi/api/01-get-a-list-of-issues-comment/)
- [简单模式已登记工时列表](https://docs.ones.cn/developer/openapi/api/03-get-a-list-of-issues-worklog/)
- [简单模式已登记工时详情](https://docs.ones.cn/developer/openapi/api/07-get-spent-time-of-issues/)
- [ONESQL](https://docs.ones.cn/developer/openapi/api/execute-onesql/)
- [个人 API keys](https://docs.ones.cn/developer/openapi/auth/personal-api-keys/)
- [访问令牌详情](https://docs.ones.cn/developer/openapi/api/get-access-token-details/)
- [组织团队列表](https://docs.ones.cn/developer/openapi/api/01-get-organization-teams/)
- [用户搜索](https://docs.ones.cn/developer/openapi/api/01-get-team-user-search-list/)
- [工作项类型](https://docs.ones.cn/developer/openapi/api/get-a-list-of-issue-types/)
- [完整属性目录](https://docs.ones.cn/developer/openapi/api/search-issue-fields/)
- [项目详情表单字段](https://docs.ones.cn/developer/openapi/api/get-issue-form-fields/)
