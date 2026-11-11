import { z } from 'zod';
import type { AppConfig } from './config.js';
import { resolveCredential, type CredentialStore } from './credentials.js';

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

export class OpenApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function failure(status: number, code?: string): OpenApiError {
  if (status === 401 || code === 'Unauthorized') return new OpenApiError('UNAUTHORIZED', 'API Key 未被接受或已失效。请运行 auth login，确认使用用户级个人 API Key。');
  if (status === 403 || code === 'Forbidden') return new OpenApiError('FORBIDDEN', '当前 API Key 无权执行此查询，请检查 API Key Scope、团队及项目访问权限。');
  if (status === 404 || code === 'NotFound') return new OpenApiError('NOT_FOUND', '资源或 Open API 地址不存在，请检查站点、团队 ID 和资源 ID。');
  if (status === 429) return new OpenApiError('RATE_LIMITED', '请求受到限流，请稍后重试。');
  if (status === 400) return new OpenApiError('BAD_REQUEST', 'ONES 拒绝了查询参数，请检查团队、资源 ID 和分页游标。');
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

  private async get<T>(path: string, query: Record<string, string | number | undefined>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    let key: string;
    try {
      const credential = await resolveCredential(this.config, this.store);
      if (!credential) throw new OpenApiError('MISSING_API_KEY', '尚未配置个人 API Key，请在独立终端运行 auth login，完成后重试。');
      key = credential.key;
    } catch (error) {
      if (error instanceof OpenApiError) throw error;
      throw new OpenApiError('CREDENTIAL_ERROR', '无法读取系统凭据库，请检查凭据配置。');
    }
    const url = new URL(`/openapi/v2${path}`, this.config.apiOrigin ?? this.config.origin);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    const timeout = AbortSignal.timeout(30_000);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const response = await this.fetcher(url, {
        method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        redirect: 'error', signal: combined,
      });
      if (!response.ok) throw failure(response.status);
      let data: unknown = await response.json();
      // Official examples also show a single envelope wrapped in an array.
      if (Array.isArray(data) && data.length === 1 && data[0]?.result) data = data[0];
      if (data && typeof data === 'object' && 'result' in data) {
        const envelope = data as Record<string, unknown>;
        if (envelope.result !== 'SUCCESS') throw failure(200, typeof envelope.errorCode === 'string' ? envelope.errorCode : undefined);
        data = envelope.data;
      }
      const parsed = schema.safeParse(redact(data, key));
      if (!parsed.success) throw new OpenApiError('INVALID_RESPONSE', 'ONES 返回的数据结构与 Open API 文档不符，未将其作为有效结果返回。');
      return parsed.data;
    } catch (error) {
      if (error instanceof OpenApiError) throw error;
      if (signal?.aborted) throw new OpenApiError('CANCELLED', '查询已取消。');
      if (timeout.aborted) throw new OpenApiError('TIMEOUT', 'ONES 查询超时，请稍后重试。');
      if (error instanceof SyntaxError) throw new OpenApiError('INVALID_RESPONSE', 'ONES 返回了无法解析的响应。');
      throw new OpenApiError('NETWORK_ERROR', '无法连接 ONES Open API，请检查网络和 ONES_API_BASE_URL。');
    }
  }

  listProjects(input: z.input<typeof projectsInput>, signal?: AbortSignal) {
    return this.get('/project/projects', projectsInput.parse(input), projectsOutput, signal);
  }
  async getProject(input: z.input<typeof projectInput>, signal?: AbortSignal) {
    const { teamID, projectID } = projectInput.parse(input);
    return { project: await this.get(`/project/projects/${encodeURIComponent(projectID)}`, { teamID }, project, signal) };
  }
  listIssues(input: z.input<typeof issuesInput>, signal?: AbortSignal) {
    return this.get('/project/issues', issuesInput.parse(input), issuesOutput, signal);
  }
  async getIssue(input: z.input<typeof issueInput>, signal?: AbortSignal) {
    const { teamID, issueID } = issueInput.parse(input);
    return { issue: await this.get(`/project/issues/${encodeURIComponent(issueID)}`, { teamID }, issue, signal) };
  }
}
