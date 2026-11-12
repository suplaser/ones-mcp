import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import type { AuthCoordinator } from './auth.js';
import { registerMutationTools } from './mutations.js';
import { searchIssues, searchIssuesInput, searchIssuesOutput } from './search.js';
import { dailyHours, dailyHoursInput, dailyHoursOutput } from './daily-hours.js';
import { OnesApi, OpenApiError, projectsInput, projectInput, issuesInput, issueInput,
  projectsOutput, projectOutput, issuesOutput, issueOutput,
  issueTypesInput, usersInput, issueFieldsInput, issueFormFieldsInput,
  currentUserOutput, teamsOutput, usersOutput, issueTypesOutput, issueFieldsOutput, issueFormFieldsOutput,
  fieldOptionsInput, fieldOptionsOutput, issueStatusesInput, issueStatusesOutput,
  issueWorkflowsInput, issueWorkflowsOutput, issueCommentsInput, issueCommentsOutput,
  issueWorklogsInput, issueWorklogsOutput, issueWorklogInput, issueWorklogOutput } from './api.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export function createServer(auth: AuthCoordinator, api: OnesApi): McpServer {
  const server = new McpServer({ name: 'ones-mcp', version });
  server.registerTool('ones_auth_status', {
    title: 'ONES API Key 配置状态',
    description: '检查本地个人 API Key 是否已配置。仅返回状态，不返回 Key；不代表远端权限验证成功。缺少 Key 时服务启动会打开设置页和独立输入终端。',
    inputSchema: {},
    outputSchema: {
      configured: z.boolean(), source: z.enum(['environment', 'system-keychain']).nullable(),
      verified: z.literal(false),
      setup: z.enum(['not-needed', 'not-started', 'waiting-for-input', 'manual-required']),
      message: z.string(), settingsUrl: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      const status = await auth.status();
      return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: { ...status } };
    } catch {
      return { isError: true, content: [{ type: 'text', text: '无法读取本地 API Key 状态，请检查系统凭据库。' }] };
    }
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const run = async (query: () => Promise<Record<string, unknown>>) => {
    try {
      const data = await query();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      const safe = error instanceof OpenApiError ? error : new OpenApiError('QUERY_FAILED', '查询未完成，请检查查询参数和服务配置。');
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: safe.code, message: safe.message }) }] };
    }
  };
  server.registerTool('ones_list_projects', {
    title: '查询 ONES 项目列表',
    description: '按团队查询当前 API Key 可访问的项目。每次返回一页（最多 100 条）；hasNextPage 为 true 时，用 endCursor 作为 cursor 继续查询，不能将单页视为完整列表。',
    inputSchema: projectsInput, outputSchema: projectsOutput, annotations,
  }, (input, extra) => run(() => api.listProjects(input, extra.signal)));
  server.registerTool('ones_get_project', {
    title: '查询 ONES 项目详情', description: '根据团队 ID 和项目内部 ID 读取项目详情，包括接口实际返回的负责人、状态和计划日期等信息。',
    inputSchema: projectInput, outputSchema: projectOutput, annotations,
  }, (input, extra) => run(() => api.getProject(input, extra.signal)));
  server.registerTool('ones_list_issues', {
    title: '查询 ONES 工作项列表',
    description: '按团队查询工作项，可传 projectID 与 issueTypeID 配合筛选。每次返回一页；hasNextPage 为 true 时，用 endCursor 作为 cursor 继续。仅支持列出的参数，不提供关键词或负责人筛选。',
    inputSchema: issuesInput, outputSchema: issuesOutput, annotations,
  }, (input, extra) => run(() => api.listIssues(input, extra.signal)));
  server.registerTool('ones_get_issue', {
    title: '查询 ONES 工作项详情', description: '根据团队 ID 和工作项内部 ID 读取详情。issueID 需使用列表返回的 id，不能使用工作项显示编号。返回字段受 API Key 权限限制。',
    inputSchema: issueInput, outputSchema: issueOutput, annotations,
  }, (input, extra) => run(() => api.getIssue(input, extra.signal)));
  server.registerTool('ones_get_current_user', {
    title: '查询 ONES 当前用户身份与权限',
    description: '远端核验当前凭据是否 active，读取其用户 ID、组织 ID、Scope 和过期时间（Unix 秒，保留服务端原值）。不返回 Key，也不包含用户姓名；需要查找姓名时使用 ones_search_users。active 为 false 时凭据不可用。Scope 列表不代表每个资源都可访问。',
    inputSchema: {}, outputSchema: currentUserOutput, annotations,
  }, (_, extra) => run(() => api.getCurrentUser(extra.signal)));
  server.registerTool('ones_list_teams', {
    title: '查询 ONES 可访问团队',
    description: '查询当前凭据所属组织中用户有权访问的团队，不需要提供团队 ID。后续查询使用返回的团队 id。接口不提供分页。',
    inputSchema: {}, outputSchema: teamsOutput, annotations,
  }, (_, extra) => run(() => api.listTeams(extra.signal)));
  server.registerTool('ones_search_users', {
    title: '搜索 ONES 团队用户',
    description: '按用户名、邮箱或工号搜索团队用户，返回真实用户 ID 以便识别负责人。每次返回一页，hasNextPage 为 true 时用 endCursor 继续；无关键词时查询用户列表。',
    inputSchema: usersInput, outputSchema: usersOutput, annotations,
  }, (input, extra) => run(() => api.searchUsers(input, extra.signal)));
  server.registerTool('ones_list_issue_types', {
    title: '查询 ONES 工作项类型',
    description: '查询团队工作项类型及真实 ID。testRole 若存在则以接口返回为准，不按名称猜测测试角色。官方接口只声明 teamID 参数；保留原始 pageInfo，不承诺结果适用于每个项目。',
    inputSchema: issueTypesInput, outputSchema: issueTypesOutput, annotations,
  }, (input, extra) => run(() => api.listIssueTypes(input, extra.signal)));
  server.registerTool('ones_search_issue_fields', {
    title: '搜索 ONES 完整工作项属性目录',
    description: '查询团队完整工作项属性元数据，可按属性名称搜索；每页最多 500 条，hasNextPage 为 true 时用 endCursor 继续。required 是团队属性定义，不是项目新建表单的完整必填规则。此接口不返回选项值或默认值。',
    inputSchema: issueFieldsInput, outputSchema: issueFieldsOutput, annotations,
  }, (input, extra) => run(() => api.searchIssueFields(input, extra.signal)));
  server.registerTool('ones_get_issue_form_fields', {
    title: '查询 ONES 项目详情表单字段',
    description: '只读查询指定项目、指定工作项类型的详情表单字段并集。使用 POST 查询，不写入业务数据。不传类型时返回全部类型的并集；不分页。不包含新建表单、步骤表单、隐藏字段或编号字段，required 是团队属性定义，不能据此保证满足创建工作项的全部必填规则。',
    inputSchema: issueFormFieldsInput, outputSchema: issueFormFieldsOutput, annotations,
  }, (input, extra) => run(() => api.getIssueFormFields(input, extra.signal)));
  server.registerTool('ones_get_field_options', {
    title: '查询 ONES 属性选项',
    description: '通过 v3alpha 只读 POST 查询属性选项。先从属性目录获取 fieldID，可传关键词、选项 UUID 和返回字段筛选。按官方文档传入 offset/limit，每次最多请求 100 条；部分部署会忽略 offset，需核对重复选项并停止翻页。接口不提供总数或 hasNextPage，不将一批结果当作完整目录。不同属性类型可能含 __reference_object__ 包装；保留原始字段，不补造默认值。',
    inputSchema: fieldOptionsInput, outputSchema: fieldOptionsOutput, annotations,
  }, (input, extra) => run(() => api.getFieldOptions(input, extra.signal)));
  server.registerTool('ones_list_issue_statuses', {
    title: '查询 ONES 工作项状态',
    description: '查询团队级工作项状态及类别，保留服务端 pageInfo。官方仅声明 teamID 参数，不提供自定义翻页参数；不能假设包含每个项目全部可用状态，状态列表也不代表当前工作项允许的流转。',
    inputSchema: issueStatusesInput, outputSchema: issueStatusesOutput, annotations,
  }, (input, extra) => run(() => api.listIssueStatuses(input, extra.signal)));
  server.registerTool('ones_list_issue_workflows', {
    title: '查询 ONES 工作项可执行工作流',
    description: '根据工作项内部 ID 查询当前可执行的工作流及起止状态 ID。只读取可用动作，不执行工作流、不修改状态；不分页。',
    inputSchema: issueWorkflowsInput, outputSchema: issueWorkflowsOutput, annotations,
  }, (input, extra) => run(() => api.listIssueWorkflows(input, extra.signal)));
  server.registerTool('ones_list_issue_comments', {
    title: '查询 ONES 工作项评论',
    description: '根据工作项内部 ID 读取评论、评论者及创建时间，兼容直接返回数组的部署。若接口返回 pageInfo 则原样保留；官方仅声明 teamID 参数，不支持自行指定分页。hasNextPage 为 true 或未提供 pageInfo 时，不承诺已读取全部评论。',
    inputSchema: issueCommentsInput, outputSchema: issueCommentsOutput, annotations,
  }, (input, extra) => run(() => api.listIssueComments(input, extra.signal)));
  server.registerTool('ones_list_issue_worklogs', {
    title: '查询 ONES 工作项已登记工时',
    description: '查询简单工时模式下工作项已登记工时列表，支持 limit/cursor 翻页。hours 为接口返回的小时数，保留小数；这是实际登记记录，不是预估工时或剩余工时，不将一页的合计当作全部工时。汇总工时模式需使用其他接口。',
    inputSchema: issueWorklogsInput, outputSchema: issueWorklogsOutput, annotations,
  }, (input, extra) => run(() => api.listIssueWorklogs(input, extra.signal)));
  server.registerTool('ones_get_issue_worklog', {
    title: '查询 ONES 已登记工时详情',
    description: '根据团队、工作项内部 ID 及工时列表返回的 worklogID，读取简单工时模式的登记记录。hours 保留接口原始小时数，startTime 为 Unix 秒；不修改记录。',
    inputSchema: issueWorklogInput, outputSchema: issueWorklogOutput, annotations,
  }, (input, extra) => run(() => api.getIssueWorklog(input, extra.signal)));
  server.registerTool('ones_search_issues', {
    title: '组合筛选 ONES 工作项',
    description: '通过工作项列表游标分页扫描并本地组合筛选标题、负责人、状态、创建/更新时间（Unix 秒，包含给定边界时间点）；条件之间为 AND，ID 数组内部为 OR，assignedToMe 可查我负责的工作项。列表时间单位由 sourceTimeUnit 指定，当前部署为微秒。每次默认最多 3 页、可设 1–10 页，每页最多 100 条，约 25 秒预算。scan 仅统计本次扫描；exhausted 表示扫描到来源末页，续查使用 nextCursor 并保持条件。不能把一批匹配数当总数；unknownFieldCount 表示缺字段而无法判定的记录，当前部署缺少 updateTime。不是 ONESQL，不执行任意查询语句。',
    inputSchema: searchIssuesInput, outputSchema: searchIssuesOutput, annotations,
  }, (input, extra) => run(() => searchIssues(api, input, extra.signal)));
  server.registerTool('ones_get_daily_hours', {
    title: '查询 ONES 每日计划与登记工时',
    description: '只读汇总日期范围内每天的计划分摊和登记工时。计划=max(工作项自身预估-累计已登记,0)，默认从统计时区今天至到期日（含）按周一至周五平均，不扣法定节假日；分母独立于展示范围。登记按 startTime 工作日期汇总，用户筛选对计划使用负责人、对登记使用记录 owner，仍扫描其他负责人工作项。逾期、无到期日等单列，不把缺失值当零；不重建历史计划。默认时区 America/Los_Angeles，可显式选择。每次最多 366 天、25 秒读取预算；coverage.complete=false 表示部分统计，不能当作总数。支持简单工时模式，需要可见工作项和工时的读取权限。',
    inputSchema: dailyHoursInput, outputSchema: dailyHoursOutput, annotations,
  }, (input, extra) => run(() => dailyHours(api, input, extra.signal)));
  registerMutationTools(server, api);
  return server;
}
