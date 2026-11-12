# Open API 覆盖与验证

本项目直接使用用户级个人 API Key。Open API 默认地址为 `https://sz.ones.cn/openapi/v2`；凭据详情位于同一站点的 `/oauth2/introspect`，不带 `/openapi/v2` 前缀。

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
- 属性目录只提供静态元数据，不包含选项和默认值。属性选项接口暂未接入。
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

- [个人 API keys](https://docs.ones.cn/developer/openapi/auth/personal-api-keys/)
- [访问令牌详情](https://docs.ones.cn/developer/openapi/api/get-access-token-details/)
- [组织团队列表](https://docs.ones.cn/developer/openapi/api/01-get-organization-teams/)
- [用户搜索](https://docs.ones.cn/developer/openapi/api/01-get-team-user-search-list/)
- [工作项类型](https://docs.ones.cn/developer/openapi/api/get-a-list-of-issue-types/)
- [完整属性目录](https://docs.ones.cn/developer/openapi/api/search-issue-fields/)
- [项目详情表单字段](https://docs.ones.cn/developer/openapi/api/get-issue-form-fields/)
