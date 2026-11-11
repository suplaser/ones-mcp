import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthCoordinator } from './auth.js';
import { OnesApi, OpenApiError, projectsInput, projectInput, issuesInput, issueInput,
  projectsOutput, projectOutput, issuesOutput, issueOutput } from './api.js';

export function createServer(auth: AuthCoordinator, api: OnesApi): McpServer {
  const server = new McpServer({ name: 'ones-mcp', version: '0.1.0' });
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
  return server;
}
