import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import type { AuthCoordinator } from './auth.js';
import { OnesApi, OpenApiError, projectsInput, projectInput, issuesInput, issueInput,
  projectsOutput, projectOutput, issuesOutput, issueOutput,
  issueTypesInput, usersInput, issueFieldsInput, issueFormFieldsInput,
  currentUserOutput, teamsOutput, usersOutput, issueTypesOutput, issueFieldsOutput, issueFormFieldsOutput } from './api.js';

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
  return server;
}
