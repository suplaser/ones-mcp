import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AppConfig } from './config.js';
import { resolveCredential, type CredentialStore } from './credentials.js';
import { stableJson, type MutationCommand, type PreparedMutation } from './mutation-schema.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const teamInput = { teamID: id.describe('团队 ID，可从 ONES 项目页面 URL 获取。') };
export const pageInput = {
  ...teamInput,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(4096).optional().describe('上一页 pageInfo.endCursor；首次查询不传。'),
};
export const projectsInput = z.object(pageInput);
export const projectInput = z.object({ ...teamInput, projectID: id });
export const issuesInput = z.object({ ...pageInput, projectID: id.optional(), issueTypeID: id.optional() });
export const issueInput = z.object({ ...teamInput, issueID: id.describe('工作项内部 ID，不是显示编号。') });
export const issueTypesInput = z.object(teamInput);
export const usersInput = z.object({ ...pageInput, keyword: z.string().max(256).optional().describe('按用户名、邮箱或工号搜索；不传时返回用户列表。') });
export const issueFieldsInput = z.object({ ...pageInput,
  limit: z.number().int().min(1).max(500).default(500),
  keyword: z.string().max(256).optional().describe('仅按属性名称搜索；不传时查询完整属性目录。'),
});
export const issueFormFieldsInput = z.object({ ...teamInput, projectID: id,
  issueTypeIDs: z.array(id).max(100).optional().describe('可选工作项类型 ID；不传或为空时查询项目全部类型的详情表单字段并集。'),
});
export const fieldOptionsInput = z.object({ ...teamInput, fieldID: id,
  keyword: z.string().max(256).optional(),
  optionIDs: z.array(id).max(100).optional().describe('可选的选项 UUID 列表，对应官方 uuids 参数。'),
  includeFields: z.array(z.string().min(1).max(128)).min(1).max(100).optional().describe('可选的返回字段名；各属性类型支持的字段不同。'),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
export const issueStatusesInput = z.object(teamInput);
export const issueWorkflowsInput = issueInput;
// These endpoints expose pageInfo but only document teamID as a query
// parameter. Do not invent cursor/limit support from the response alone.
export const issueCommentsInput = issueInput;
export const issueWorklogsInput = z.object({ ...pageInput, issueID: id });
export const issueWorklogInput = z.object({ ...teamInput, issueID: id, worklogID: id });

const pageInfo = z.object({
  hasNextPage: z.boolean(), endCursor: z.string().nullable().optional(),
  startCursor: z.string().nullable().optional(), count: z.number().optional(), totalCount: z.number().optional(),
}).passthrough();
const project = z.object({ id: z.string(), name: z.string() }).passthrough();
const issue = z.object({ id: z.string(), title: z.string() }).passthrough();
export const projectsOutput = z.object({ list: z.array(project), pageInfo }).passthrough();
export const issuesOutput = z.object({ list: z.array(issue), pageInfo }).passthrough();
export const projectOutput = z.object({ project });
export const issueOutput = z.object({ issue });
const namedEntity = z.object({ id: z.string(), name: z.string() }).passthrough();
const field = namedEntity.extend({
  required: z.boolean().optional(), readonly: z.boolean().optional(),
  fieldType: z.string().optional(), fieldTypeName: z.string().optional(), valueType: z.string().optional(),
}).passthrough();
export const teamsOutput = z.object({ teams: z.array(namedEntity) });
export const usersOutput = z.object({ list: z.array(namedEntity), pageInfo }).passthrough();
export const issueTypesOutput = z.object({ list: z.array(namedEntity), pageInfo }).passthrough();
export const issueFieldsOutput = z.object({ list: z.array(field), pageInfo }).passthrough();
export const issueFormFieldsOutput = z.object({ fields: z.array(field) });
const fieldOption = z.record(z.string(), z.unknown());
export const fieldOptionsOutput = z.object({ options: z.array(fieldOption) });
export const issueStatusesOutput = z.object({ list: z.array(namedEntity), pageInfo }).passthrough();
const workflow = namedEntity.extend({ start: z.string().optional(), end: z.string().optional() }).passthrough();
export const issueWorkflowsOutput = z.object({ workflows: z.array(workflow) });
const comment = z.object({ id: z.string(), text: z.string(), createTime: z.number().int().optional(),
  owner: namedEntity.optional() }).passthrough();
export const issueCommentsOutput = z.object({ list: z.array(comment), pageInfo: pageInfo.optional() }).passthrough();
const worklog = z.object({ id: z.string(), hours: z.number(), description: z.string().optional(),
  startTime: z.number().int().optional(), owner: namedEntity.optional() }).passthrough();
export const issueWorklogsOutput = z.object({ list: z.array(worklog), pageInfo }).passthrough();
export const issueWorklogOutput = z.object({ worklog });
const credentialDetails = z.object({
  active: z.boolean(), sub: z.string().optional(), org_id: z.string().optional(),
  scope: z.string().optional(), exp: z.number().int().optional(),
});
export const currentUserOutput = z.object({
  active: z.boolean(), userID: z.string().optional(), organizationID: z.string().optional(),
  scopes: z.array(z.string()), expiresAt: z.number().int().optional(),
});

export class OpenApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function failure(status: number, code?: string): OpenApiError {
  if (status === 401 || code === 'Unauthorized') return new OpenApiError('UNAUTHORIZED', 'API Key 未被接受或已失效。请运行 auth login，确认使用用户级个人 API Key。');
  if (status === 403 || code === 'Forbidden' || code === 'PermissionDenied' || code === 'AccessDenied') return new OpenApiError('FORBIDDEN', '当前 API Key 无权执行此查询，请检查 API Key Scope、团队及项目访问权限。');
  if (status === 404 || code === 'NotFound') return new OpenApiError('NOT_FOUND', '资源或 Open API 地址不存在，请检查站点、团队 ID 和资源 ID。');
  if (status === 429) return new OpenApiError('RATE_LIMITED', '请求受到限流，请稍后重试。');
  if (status === 400 || code === 'InvalidParameter' || code === 'MissingParameter') return new OpenApiError('BAD_REQUEST', 'ONES 拒绝了查询参数，请检查团队、资源 ID 和分页参数。');
  return new OpenApiError('API_ERROR', 'ONES Open API 查询失败，未返回可用数据。');
}

// Never return the active credential, even if a remote server echoes it.
function redact(value: unknown, key: string): unknown {
  if (typeof value === 'string') return value.split(key).join('[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [
    name.split(key).join('[REDACTED]'),
    /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(name) ? '[REDACTED]' : redact(item, key),
  ]));
  return value;
}

export class OnesApi {
  constructor(private readonly config: AppConfig, private readonly store: CredentialStore,
    private readonly fetcher: typeof fetch = fetch) {}

  private async request<T>(path: string, query: Record<string, string | number | undefined>, schema: z.ZodType<T>, signal?: AbortSignal,
    options: { body?: Record<string, unknown>; root?: boolean; method?: 'POST' | 'PUT' | 'DELETE'; mutation?: boolean; credentialHash?: string } = {}): Promise<T> {
    const key = await this.credential();
    if (options.credentialHash !== undefined && this.credentialHash(key) !== options.credentialHash) {
      throw new OpenApiError('CREDENTIAL_CHANGED', '确认期间凭据已更换，未发送写入。请重新预览并由用户确认。');
    }
    const url = new URL(`${options.root ? '' : '/openapi/v2'}${path}`, this.config.apiOrigin ?? this.config.origin);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    const timeout = AbortSignal.timeout(30_000);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let dispatched = false;
    try {
      if (combined.aborted) throw new OpenApiError('CANCELLED', '操作已取消，未发送请求。');
      dispatched = true;
      const response = await this.fetcher(url, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: 'error', signal: combined,
      });
      if (!response.ok) throw failure(response.status);
      let data: unknown = await response.json();
      let successEnvelope = false;
      // Official examples also show a single envelope wrapped in an array.
      if (Array.isArray(data) && data.length === 1 && data[0]?.result) data = data[0];
      if (data && typeof data === 'object' && 'result' in data) {
        const envelope = data as Record<string, unknown>;
        // The official comment-list example also uses lowercase success.
        if (envelope.result !== 'SUCCESS' && envelope.result !== 'success') throw failure(200, typeof envelope.errorCode === 'string' ? envelope.errorCode : undefined);
        successEnvelope = true;
        data = envelope.data;
      } else if (data && typeof data === 'object' && Object.keys(data).length === 1 && 'data' in data) {
        // Some account endpoints document a data-only wrapper without result.
        data = data.data;
      }
      if (options.mutation && !successEnvelope) throw new OpenApiError('INVALID_RESPONSE', '写入响应缺少明确的成功标志。');
      const parsed = schema.safeParse(redact(data, key));
      if (!parsed.success) throw new OpenApiError('INVALID_RESPONSE', 'ONES 返回的数据结构与 Open API 文档不符，未将其作为有效结果返回。');
      return parsed.data;
    } catch (error) {
      if (options.mutation && dispatched && !(error instanceof OpenApiError &&
          ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'BAD_REQUEST'].includes(error.code))) {
        throw new OpenApiError('WRITE_OUTCOME_UNKNOWN', '写入已发送但结果无法确认，可能已生效。不要自动重试或更换 requestID 重试；请先查询 ONES 核实结果，再由用户决定后续操作。');
      }
      if (error instanceof OpenApiError) throw error;
      if (signal?.aborted) throw new OpenApiError('CANCELLED', '查询已取消。');
      if (timeout.aborted) throw new OpenApiError('TIMEOUT', 'ONES 查询超时，请稍后重试。');
      if (error instanceof SyntaxError) throw new OpenApiError('INVALID_RESPONSE', 'ONES 返回了无法解析的响应。');
      throw new OpenApiError('NETWORK_ERROR', '无法连接 ONES Open API，请检查网络和 ONES_API_BASE_URL。');
    }
  }

  private async credential(): Promise<string> {
    try {
      const credential = await resolveCredential(this.config, this.store);
      if (!credential) throw new OpenApiError('MISSING_API_KEY', '尚未配置个人 API Key，请在独立终端运行 auth login，完成后重试。');
      return credential.key;
    } catch (error) {
      if (error instanceof OpenApiError) throw error;
      throw new OpenApiError('CREDENTIAL_ERROR', '无法读取系统凭据库，请检查凭据配置。');
    }
  }
  private credentialHash(key: string): string { return createHash('sha256').update(key).digest('hex'); }

  async prepareMutation(command: MutationCommand, signal?: AbortSignal): Promise<PreparedMutation> {
    // Snapshot before any await; neither caller edits nor preview edits can
    // change the exact request that will be approved and sent.
    const snapshot = JSON.parse(JSON.stringify(command)) as MutationCommand;
    const credentialHash = this.credentialHash(await this.credential());
    const actor = await this.getCurrentUser(signal);
    if (!actor.active || !actor.userID) throw new OpenApiError('UNAUTHORIZED', '当前凭据不可用或无法核验用户身份，未准备写入。');
    const target: Record<string, unknown> = {};
    let issueSnapshot: string | undefined;
    if (snapshot.issueID !== undefined) {
      const { issue } = await this.getIssue({ teamID: snapshot.teamID, issueID: snapshot.issueID }, signal);
      if (issue.id !== snapshot.issueID) throw new OpenApiError('TARGET_UNVERIFIED', '读取到的工作项与目标 ID 不符，未准备写入。');
      target.issue = issue;
      issueSnapshot = stableJson(issue);
    } else if (snapshot.projectID !== undefined) {
      target.project = (await this.getProject({ teamID: snapshot.teamID, projectID: snapshot.projectID }, signal)).project;
      if ((target.project as { id: string }).id !== snapshot.projectID) throw new OpenApiError('TARGET_UNVERIFIED', '读取到的项目与目标 ID 不符，未准备写入。');
      if (snapshot.parentID !== undefined) {
        target.parent = (await this.getIssue({ teamID: snapshot.teamID, issueID: snapshot.parentID }, signal)).issue;
      }
    }
    let workflowSnapshot: string | undefined;
    const readChild = async (childSignal?: AbortSignal): Promise<Record<string, unknown> | undefined> => {
      const commentID = snapshot.commentID ?? snapshot.repliedMessageID;
      if (commentID !== undefined) {
        const selected = (await this.listIssueComments({ teamID: snapshot.teamID, issueID: snapshot.issueID! }, childSignal)).list
          .find((item) => item.id === commentID);
        if (!selected) throw new OpenApiError('COMMENT_UNVERIFIED', '当前评论列表中未能核验目标评论，可能受权限或分页限制；未发送写入。');
        return selected;
      }
      if (snapshot.worklogID !== undefined) {
        const record = (await this.getIssueWorklog({ teamID: snapshot.teamID, issueID: snapshot.issueID!, worklogID: snapshot.worklogID }, childSignal)).worklog;
        if (record.id !== snapshot.worklogID) throw new OpenApiError('TARGET_UNVERIFIED', '读取到的工时记录与目标 ID 不符，未准备写入。');
        return record;
      }
      return undefined;
    };
    const child = await readChild(signal);
    const childSnapshot = child === undefined ? undefined : stableJson(child);
    if (child !== undefined) target[snapshot.worklogID === undefined ? 'comment' : 'worklog'] = child;
    if (snapshot.operation === 'executeWorkflow') {
      const selected = (await this.listIssueWorkflows({ teamID: snapshot.teamID, issueID: snapshot.issueID! }, signal))
        .workflows.find((item) => item.id === snapshot.workflowID);
      if (!selected) throw new OpenApiError('WORKFLOW_UNAVAILABLE', '所选工作流当前不可执行，未请求写入。请先查询可执行工作流。');
      target.workflow = selected;
      workflowSnapshot = stableJson(selected);
    }
    if (this.credentialHash(await this.credential()) !== credentialHash) throw new OpenApiError('CREDENTIAL_CHANGED', '准备期间凭据已更换，请重新预览。');
    const url = new URL(`/openapi/v2${snapshot.path}`, this.config.apiOrigin ?? this.config.origin);
    for (const [name, value] of Object.entries(snapshot.query)) url.searchParams.set(name, value);
    const notes = ['仅在用户通过客户端确认表单明确批准后发送本次请求；修改参数必须重新确认。'];
    if (snapshot.operation === 'createIssue') notes.push('详情表单字段不代表完整新建必填规则；关注者可能收到 ONES 通知。');
    if (snapshot.operation === 'updateIssue') notes.push('仅更新列出的属性；value 为 null 表示主动清空该属性。');
    if (snapshot.operation === 'executeWorkflow') notes.push('该工作流可能执行 ONES 配置的后置动作。linkedWikiPages=[] 会清空 Wiki 关联，非空数组为全量替换；工时单位为小时。');
    if (snapshot.operation === 'addWorklog') notes.push('这是简单模式下实际工时登记，hours 单位为小时，startTime 为 Unix 秒；不会修改预估工时。');
    if (snapshot.operation === 'sendComment' || snapshot.operation === 'updateComment') notes.push('发送或替换完整评论正文；可能触发 ONES 通知。本工具按官方声明将正文限制为 128 字符。');
    if (snapshot.operation === 'deleteComment') notes.push('将删除上方列出的这条评论；本工具不提供恢复。');
    if (snapshot.operation === 'updateWorklog') notes.push('完整替换此条实际工时的小时数、开始时间、登记人和描述；description 为空字符串表示主动清空描述。');
    if (snapshot.operation === 'deleteWorklog') notes.push('将删除上方列出的这条实际工时记录，影响工时合计；本工具不提供恢复。');
    if (snapshot.operation === 'setEstimated') notes.push('设置简单模式预估工时（小时），0 表示设置为零；不登记实际工时。');
    if (snapshot.operation === 'setRemaining') notes.push('设置简单模式剩余工时（小时），0 表示设置为零；不登记实际工时。');
    let consumed = false;
    const preview = {
      operation: snapshot.operation, requestID: snapshot.requestID, site: this.config.origin,
      actor: { ...actor }, target: structuredClone(target),
      request: { method: snapshot.method, url: url.href,
        ...(snapshot.method === 'DELETE' ? {} : { body: structuredClone(snapshot.body) }) }, notes,
    };
    return { preview, execute: async (executionSignal) => {
      if (consumed) throw new OpenApiError('ALREADY_EXECUTED', '本次预览已被使用，未重复发送写入。');
      consumed = true;
      if (executionSignal?.aborted) throw new OpenApiError('CANCELLED', '操作已取消，未发送写入。');
      if (snapshot.issueID !== undefined) {
        const current = (await this.getIssue({ teamID: snapshot.teamID, issueID: snapshot.issueID }, executionSignal)).issue;
        if (stableJson(current) !== issueSnapshot) throw new OpenApiError('TARGET_CHANGED', '确认期间工作项已变化，未发送写入。请重新读取并由用户确认。');
      }
      if (snapshot.operation === 'executeWorkflow') {
        const current = (await this.listIssueWorkflows({ teamID: snapshot.teamID, issueID: snapshot.issueID! }, executionSignal))
          .workflows.find((item) => item.id === snapshot.workflowID);
        if (!current || stableJson(current) !== workflowSnapshot) throw new OpenApiError('WORKFLOW_UNAVAILABLE', '确认期间工作流已变化，未执行流转。');
      }
      if (childSnapshot !== undefined && stableJson(await readChild(executionSignal)) !== childSnapshot) {
        throw new OpenApiError('TARGET_CHANGED', '确认期间目标评论或工时记录已变化，未发送写入。');
      }
      if (['executeWorkflow', 'sendComment', 'updateComment', 'deleteComment', 'deleteWorklog', 'setEstimated', 'setRemaining'].includes(snapshot.operation)) {
        await this.request(snapshot.path, snapshot.query, z.union([z.undefined(), z.record(z.string(), z.unknown())]), executionSignal,
          { ...(snapshot.method === 'DELETE' ? {} : { body: snapshot.body }), method: snapshot.method, mutation: true, credentialHash });
        return { operation: snapshot.operation, completed: true, issueID: snapshot.issueID,
          ...(snapshot.operation === 'executeWorkflow' ? { executed: true } : {}),
          ...(snapshot.workflowID === undefined ? {} : { workflowID: snapshot.workflowID }),
          ...(snapshot.commentID === undefined ? {} : { commentID: snapshot.commentID }),
          ...(snapshot.worklogID === undefined ? {} : { worklogID: snapshot.worklogID }) };
      }
      const isWorklog = snapshot.operation === 'addWorklog' || snapshot.operation === 'updateWorklog';
      const schema: z.ZodType<Record<string, unknown>> = isWorklog ? worklog : issue;
      const result = await this.request(snapshot.path, snapshot.query, schema, executionSignal,
        { body: snapshot.body, method: snapshot.method, mutation: true, credentialHash });
      if ((snapshot.operation === 'updateIssue' && result.id !== snapshot.issueID) ||
          (snapshot.operation === 'updateWorklog' && result.id !== snapshot.worklogID)) {
        throw new OpenApiError('WRITE_OUTCOME_UNKNOWN', '写入响应的工作项 ID 与目标不符，结果无法确认。请先查询核实，不要自动重试。');
      }
      return isWorklog ? { worklog: result } : { issue: result };
    } };
  }

  listProjects(input: z.input<typeof projectsInput>, signal?: AbortSignal) {
    return this.request('/project/projects', projectsInput.parse(input), projectsOutput, signal);
  }
  async getProject(input: z.input<typeof projectInput>, signal?: AbortSignal) {
    const { teamID, projectID } = projectInput.parse(input);
    return { project: await this.request(`/project/projects/${encodeURIComponent(projectID)}`, { teamID }, project, signal) };
  }
  listIssues(input: z.input<typeof issuesInput>, signal?: AbortSignal) {
    return this.request('/project/issues', issuesInput.parse(input), issuesOutput, signal);
  }
  async getIssue(input: z.input<typeof issueInput>, signal?: AbortSignal) {
    const { teamID, issueID } = issueInput.parse(input);
    return { issue: await this.request(`/project/issues/${encodeURIComponent(issueID)}`, { teamID }, issue, signal) };
  }

  async getCurrentUser(signal?: AbortSignal): Promise<z.infer<typeof currentUserOutput>> {
    const data = await this.request('/oauth2/introspect', {}, credentialDetails, signal, { root: true });
    // Explicit projection prevents credentials or unrelated OAuth fields from
    // entering MCP results, even if a server adds extra response properties.
    return {
      active: data.active,
      ...(data.sub === undefined ? {} : { userID: data.sub }),
      ...(data.org_id === undefined ? {} : { organizationID: data.org_id }),
      scopes: [...new Set((data.scope ?? '').split(/[,\s]+/).filter(Boolean))],
      ...(data.exp === undefined ? {} : { expiresAt: data.exp }),
    };
  }
  listTeams(signal?: AbortSignal) {
    return this.request('/account/teams', {}, teamsOutput, signal);
  }
  searchUsers(input: z.input<typeof usersInput>, signal?: AbortSignal) {
    return this.request('/account/users/search', usersInput.parse(input), usersOutput, signal);
  }
  listIssueTypes(input: z.input<typeof issueTypesInput>, signal?: AbortSignal) {
    return this.request('/project/issueTypes', issueTypesInput.parse(input), issueTypesOutput, signal);
  }
  searchIssueFields(input: z.input<typeof issueFieldsInput>, signal?: AbortSignal) {
    return this.request('/project/searchIssueFields', issueFieldsInput.parse(input), issueFieldsOutput, signal);
  }
  async getIssueFormFields(input: z.input<typeof issueFormFieldsInput>, signal?: AbortSignal) {
    const { teamID, projectID, issueTypeIDs } = issueFormFieldsInput.parse(input);
    const fields = await this.request('/project/issueFormFields', { teamID }, z.array(field), signal, {
      body: { project_uuid: projectID, ...(issueTypeIDs === undefined ? {} : { issue_type_uuids: issueTypeIDs }) },
    });
    return { fields };
  }
  async getFieldOptions(input: z.input<typeof fieldOptionsInput>, signal?: AbortSignal) {
    const { teamID, fieldID, keyword, optionIDs, includeFields, limit, offset } = fieldOptionsInput.parse(input);
    const options = await this.request('/openapi/v3alpha/field/options', { teamID }, z.array(fieldOption), signal, {
      root: true,
      body: { field_uuid: fieldID, limit, offset,
        ...(keyword === undefined ? {} : { keyword }),
        ...(optionIDs === undefined ? {} : { uuids: optionIDs }),
        ...(includeFields === undefined ? {} : { include_fields: includeFields }) },
    });
    return { options };
  }
  listIssueStatuses(input: z.input<typeof issueStatusesInput>, signal?: AbortSignal) {
    return this.request('/project/issueStatuses', issueStatusesInput.parse(input), issueStatusesOutput, signal);
  }
  async listIssueWorkflows(input: z.input<typeof issueWorkflowsInput>, signal?: AbortSignal) {
    const { teamID, issueID } = issueWorkflowsInput.parse(input);
    const workflows = await this.request(`/project/issues/${encodeURIComponent(issueID)}`, { teamID, action: 'executableWorkflow' }, z.array(workflow), signal);
    return { workflows };
  }
  async listIssueComments(input: z.input<typeof issueCommentsInput>, signal?: AbortSignal) {
    const { teamID, issueID } = issueCommentsInput.parse(input);
    const data = await this.request(`/project/issues/${encodeURIComponent(issueID)}/comments`, { teamID },
      z.union([z.array(comment), issueCommentsOutput]), signal);
    // Some deployments return an unpaged array. Absence of pageInfo is not
    // evidence of completeness: leave it absent instead of fabricating it.
    return Array.isArray(data) ? { list: data } : data;
  }
  listIssueWorklogs(input: z.input<typeof issueWorklogsInput>, signal?: AbortSignal) {
    const { issueID, ...query } = issueWorklogsInput.parse(input);
    return this.request(`/project/issues/${encodeURIComponent(issueID)}/workLog/simple/timesSpent`, query, issueWorklogsOutput, signal);
  }
  async getIssueWorklog(input: z.input<typeof issueWorklogInput>, signal?: AbortSignal) {
    const { teamID, issueID, worklogID } = issueWorklogInput.parse(input);
    return { worklog: await this.request(`/project/issues/${encodeURIComponent(issueID)}/workLog/simple/timesSpent/${encodeURIComponent(worklogID)}`, { teamID }, worklog, signal) };
  }
}
