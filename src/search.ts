import { z } from 'zod';
import { OnesApi, OpenApiError, issuesOutput } from './api.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const ids = z.array(id).min(1).max(100);
const seconds = z.number().int().min(0).max(253402300799).describe('Unix 秒，包含给定的边界时间点；不接受毫秒或微秒输入。');
export const searchIssuesInput = z.strictObject({
  teamID: id, projectID: id.optional(), issueTypeID: id.optional(),
  keyword: z.string().trim().min(1).max(256).optional().describe('标题按字面包含匹配，不区分大小写；不执行 SQL 或正则。'),
  assigneeIDs: ids.optional(), assignedToMe: z.boolean().default(false),
  statusIDs: ids.optional(), excludeStatusIDs: ids.optional(),
  createdAfter: seconds.optional(), createdBefore: seconds.optional(),
  updatedAfter: seconds.optional(), updatedBefore: seconds.optional(),
  sourceTimeUnit: z.enum(['microseconds', 'milliseconds', 'seconds']).default('microseconds')
    .describe('列表 createTime/updateTime 的原始单位；当前部署为微秒。筛选边界始终使用 Unix 秒，不按数值大小猜测单位。'),
  cursor: z.string().min(1).max(4096).optional().describe('上批 scan.nextCursor；续查时保持其他筛选条件一致。'),
  pageSize: z.number().int().min(1).max(100).default(100),
  maxPages: z.number().int().min(1).max(10).default(3),
}).refine((input) => !input.assignedToMe || input.assigneeIDs === undefined, 'assignedToMe 和 assigneeIDs 不能同时使用。')
  .refine((input) => input.createdAfter === undefined || input.createdBefore === undefined || input.createdAfter <= input.createdBefore, '创建时间范围无效。')
  .refine((input) => input.updatedAfter === undefined || input.updatedBefore === undefined || input.updatedAfter <= input.updatedBefore, '更新时间范围无效。');

export const searchIssuesOutput = z.object({
  list: issuesOutput.shape.list,
  scan: z.object({ scannedCount: z.number().int(), returnedCount: z.number().int(), unknownFieldCount: z.number().int(),
    duplicateCount: z.number().int(), pagesRead: z.number().int(), startedFromCursor: z.boolean(), exhausted: z.boolean(),
    sourceTimeUnit: z.enum(['microseconds', 'milliseconds', 'seconds']),
    nextCursor: z.string().optional(), stopReason: z.enum(['end', 'pageLimit', 'timeBudget', 'paginationUnavailable']) }),
});

// A missing filtered field must not be interpreted as an empty field or a
// match. Missing values are reported separately so completeness is visible.
function entityID(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id;
  return undefined;
}
function within(value: unknown, factor: number, lower?: number, upper?: number): boolean | undefined {
  if (lower === undefined && upper === undefined) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const unixSeconds = value / factor;
  return (lower === undefined || unixSeconds >= lower) && (upper === undefined || unixSeconds <= upper);
}
export async function searchIssues(api: OnesApi, input: z.input<typeof searchIssuesInput>, signal?: AbortSignal) {
  const parsed = searchIssuesInput.parse(input);
  const timeFactor = { microseconds: 1_000_000, milliseconds: 1_000, seconds: 1 }[parsed.sourceTimeUnit];
  const budget = AbortSignal.timeout(25_000);
  const combined = signal ? AbortSignal.any([signal, budget]) : budget;
  let assignees = parsed.assigneeIDs;
  if (parsed.assignedToMe) {
    const actor = await api.getCurrentUser(combined);
    if (!actor.active || !actor.userID) throw new OpenApiError('UNAUTHORIZED', '无法核验当前用户，未将“我负责”作为有效筛选条件。');
    assignees = [actor.userID];
  }
  const list: z.infer<typeof issuesOutput>['list'] = [];
  const seen = new Set<string>(), cursors = new Set<string>();
  let cursor = parsed.cursor;
  if (cursor) cursors.add(cursor);
  const scan: z.infer<typeof searchIssuesOutput>['scan'] = {
    scannedCount: 0, returnedCount: 0, unknownFieldCount: 0, duplicateCount: 0, pagesRead: 0,
    startedFromCursor: cursor !== undefined, exhausted: false, stopReason: 'pageLimit', sourceTimeUnit: parsed.sourceTimeUnit,
  };
  for (let page = 0; page < parsed.maxPages; page++) {
    if (signal?.aborted) throw new OpenApiError('CANCELLED', '检索已取消。');
    if (budget.aborted) { scan.stopReason = 'timeBudget'; break; }
    let result;
    try {
      result = await api.listIssues({ teamID: parsed.teamID, limit: parsed.pageSize,
        ...(parsed.projectID === undefined ? {} : { projectID: parsed.projectID }),
        ...(parsed.issueTypeID === undefined ? {} : { issueTypeID: parsed.issueTypeID }),
        ...(cursor === undefined ? {} : { cursor }) }, combined);
    } catch (error) {
      if (signal?.aborted) throw new OpenApiError('CANCELLED', '检索已取消。');
      if (budget.aborted && scan.pagesRead > 0) { scan.stopReason = 'timeBudget'; break; }
      throw error;
    }
    scan.pagesRead++;
    let newItems = 0;
    for (const item of result.list) {
      scan.scannedCount++;
      if (seen.has(item.id)) { scan.duplicateCount++; continue; }
      seen.add(item.id);
      newItems++;
      const owner = entityID(item.assignee), status = entityID(item.status);
      const predicates: Array<boolean | undefined> = [
        parsed.projectID === undefined ? true : entityID(item.project) === undefined ? undefined : entityID(item.project) === parsed.projectID,
        parsed.issueTypeID === undefined ? true : entityID(item.issueType) === undefined ? undefined : entityID(item.issueType) === parsed.issueTypeID,
        parsed.keyword === undefined || item.title.toLowerCase().includes(parsed.keyword.toLowerCase()),
        assignees === undefined ? true : owner === undefined ? undefined : owner !== null && assignees.includes(owner),
        parsed.statusIDs === undefined ? true : status === undefined ? undefined : status !== null && parsed.statusIDs.includes(status),
        parsed.excludeStatusIDs === undefined ? true : status === undefined ? undefined : status === null || !parsed.excludeStatusIDs.includes(status),
        within(item.createTime, timeFactor, parsed.createdAfter, parsed.createdBefore),
        within(item.updateTime, timeFactor, parsed.updatedAfter, parsed.updatedBefore),
      ];
      if (predicates.includes(false)) continue;
      if (predicates.includes(undefined)) { scan.unknownFieldCount++; continue; }
      list.push(item);
    }
    if (!result.pageInfo.hasNextPage) { scan.exhausted = true; scan.stopReason = 'end'; cursor = undefined; break; }
    if (result.list.length > 0 && newItems === 0) { scan.stopReason = 'paginationUnavailable'; cursor = undefined; break; }
    const next = result.pageInfo.endCursor;
    if (!next || cursors.has(next)) { scan.stopReason = 'paginationUnavailable'; cursor = undefined; break; }
    cursor = next;
    cursors.add(next);
  }
  if (cursor !== undefined) scan.nextCursor = cursor;
  scan.returnedCount = list.length;
  return { list, scan };
}
