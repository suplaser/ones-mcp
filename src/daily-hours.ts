import { z } from 'zod';
import { OnesApi, OpenApiError } from './api.js';

const DAY = 86_400_000;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01') return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}
const date = z.string().refine(validDate, '日期必须为有效的 YYYY-MM-DD（1970 年起）。');
const zone = z.string().min(1).max(128).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, '时区必须是有效的 IANA 时区。');
export const dailyHoursInput = z.strictObject({
  teamID: id, projectID: id.optional(), issueTypeID: id.optional(),
  startDate: date, endDate: date,
  timeZone: zone.default('America/Los_Angeles').describe('登记工时工作日期及今天采用的时区；可显式指定 Asia/Shanghai 等。'),
  calendar: z.enum(['weekdays', 'calendarDays']).default('weekdays').describe('默认只向周一至周五分摊，不自动扣法定节假日；登记工时仍包括周末。'),
  allocationStartDate: date.optional().describe('分摊起算日，默认统计时区的今天，不允许过去日期；独立于展示区间。'),
  userIDs: z.array(id).min(1).max(100).optional().describe('计划按工作项负责人筛选，登记按工时记录 owner.id 筛选；不按工作项负责人漏掉他人项目上的登记。'),
  mineOnly: z.boolean().default(false),
  excludePlannedStatusIDs: z.array(id).min(1).max(100).optional().describe('仅排除这些状态的计划分摊，仍统计其登记工时；不按状态名称猜测已完成。'),
  maxIssuePages: z.number().int().min(1).max(20).default(10),
  maxIssues: z.number().int().min(1).max(500).default(100),
  maxWorklogPagesPerIssue: z.number().int().min(1).max(20).default(10),
}).refine((v) => v.startDate <= v.endDate, '开始日期不能晚于结束日期。')
  .refine((v) => (Date.parse(v.endDate) - Date.parse(v.startDate)) / DAY < 366, '单次最多展示 366 天。')
  .refine((v) => !v.mineOnly || v.userIDs === undefined, 'mineOnly 和 userIDs 不能同时使用。');

const nonnegative = z.number().finite().nonnegative();
const dayOutput = z.object({ date: z.string(), isPlanningDay: z.boolean(), plannedHours: nonnegative,
  registeredHours: nonnegative, plannedIssueCount: z.number().int(), registeredRecordCount: z.number().int() });
const unallocatedReason = z.enum(['unknownAssignee', 'unknownStatus', 'missingEstimate', 'missingSpent', 'invalidHours',
  'missingDueDate', 'invalidDueDate', 'overdue', 'noPlanningDays', 'horizonTooLong']);
const allocation = z.object({ issueID: z.string(), title: z.string(), assigneeID: z.string().optional(),
  estimatedHours: nonnegative, cumulativeRegisteredHours: nonnegative, remainingHours: nonnegative,
  dueDate: z.string(), allocationDays: z.number().int().positive(), dailyHours: nonnegative, plannedHoursInRange: nonnegative });
export const dailyHoursOutput = z.object({
  range: z.object({ startDate: z.string(), endDate: z.string(), timeZone: z.string(), asOfDate: z.string(),
    allocationStartDate: z.string(), calendar: z.enum(['weekdays', 'calendarDays']) }),
  scope: z.object({ teamID: z.string(), projectID: z.string().optional(), issueTypeID: z.string().optional(), userIDs: z.array(z.string()).optional(),
    excludePlannedStatusIDs: z.array(z.string()).optional() }),
  days: z.array(dayOutput),
  totals: z.object({ plannedHoursInRange: nonnegative, registeredHoursInRange: nonnegative,
    remainingHoursKnown: nonnegative, unallocatedRemainingHoursKnown: nonnegative }),
  allocations: z.array(allocation),
  unallocated: z.array(z.object({ issueID: z.string(), title: z.string(), reason: unallocatedReason, remainingHours: nonnegative.optional() })),
  coverage: z.object({ complete: z.boolean(), issueScanComplete: z.boolean(), worklogScanComplete: z.boolean(), planInputsComplete: z.boolean(),
    allKnownRemainingHoursScheduled: z.boolean(), scannedIssues: z.number().int(), includedIssues: z.number().int(),
    issuePagesRead: z.number().int(), worklogPagesRead: z.number().int(), worklogIssuesCompleted: z.number().int(),
    uniqueWorklogsRead: z.number().int(), duplicateIssues: z.number().int(), duplicateWorklogs: z.number().int(),
    invalidWorklogs: z.number().int(), unknownScopeIssues: z.number().int() }),
  problems: z.array(z.object({ code: z.string(), issueID: z.string().optional() })), notes: z.array(z.string()),
});

type Entity = { id: string; [key: string]: unknown };
type Page<T> = { list: T[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null | undefined } };
function entityID(value: unknown): string | null | undefined {
  if (value === null) return null;
  return value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : undefined;
}
function dateInZone(stamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(stamp);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function planningDay(stamp: number, calendar: 'weekdays' | 'calendarDays'): boolean {
  const weekday = new Date(stamp).getUTCDay();
  return calendar === 'calendarDays' || (weekday !== 0 && weekday !== 6);
}
// Calendar-date arithmetic uses UTC labels, not local elapsed hours. DST must
// not shorten or lengthen either the number of dates or the denominator.
function labels(start: string, end: string): string[] {
  const result: string[] = [];
  for (let stamp = Date.parse(start); stamp <= Date.parse(end); stamp += DAY) result.push(new Date(stamp).toISOString().slice(0, 10));
  return result;
}
const rounded = (value: number) => Math.round(value * 1e8) / 1e8;

export async function dailyHours(api: OnesApi, input: z.input<typeof dailyHoursInput>, signal?: AbortSignal, now = Date.now()) {
  const parsed = dailyHoursInput.parse(input);
  const asOfDate = dateInZone(now, parsed.timeZone), allocationStartDate = parsed.allocationStartDate ?? asOfDate;
  if (allocationStartDate < asOfDate) throw new OpenApiError('BAD_REQUEST', '分摊起算日不能早于今天；当前快照不能重建历史计划。');
  const budget = AbortSignal.timeout(25_000), combined = signal ? AbortSignal.any([signal, budget]) : budget;
  const checkCancel = () => { if (signal?.aborted) throw new OpenApiError('CANCELLED', '工时汇总已取消。'); };
  checkCancel();
  let userIDs = parsed.userIDs;
  if (parsed.mineOnly) {
    const actor = await api.getCurrentUser(combined);
    if (!actor.active || !actor.userID) throw new OpenApiError('UNAUTHORIZED', '无法核验当前用户，未使用“我”的工时范围。');
    userIDs = [actor.userID];
  }
  const problems: z.infer<typeof dailyHoursOutput>['problems'] = [];
  const coverage: z.infer<typeof dailyHoursOutput>['coverage'] = { complete: false, issueScanComplete: false,
    worklogScanComplete: true, planInputsComplete: true, allKnownRemainingHoursScheduled: false,
    scannedIssues: 0, includedIssues: 0, issuePagesRead: 0, worklogPagesRead: 0, worklogIssuesCompleted: 0,
    uniqueWorklogsRead: 0, duplicateIssues: 0, duplicateWorklogs: 0, invalidWorklogs: 0, unknownScopeIssues: 0 };
  const addProblem = (code: string, issueID?: string) => problems.push({ code, ...(issueID === undefined ? {} : { issueID }) });
  async function collect<T extends Entity>(fetchPage: (cursor?: string) => Promise<Page<T>>, maxPages: number,
    kind: 'issues' | 'worklogs', issueID?: string): Promise<{ list: T[]; complete: boolean }> {
    const list: T[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let n = 0; n < maxPages; n++) {
      checkCancel();
      if (budget.aborted) { addProblem('TIME_BUDGET', issueID); return { list, complete: false }; }
      let result: Page<T>;
      try { result = await fetchPage(cursor); } catch (error) {
        checkCancel();
        if (kind === 'issues' && list.length === 0 && !budget.aborted) throw error;
        addProblem(budget.aborted ? 'TIME_BUDGET' : error instanceof OpenApiError ? error.code : 'QUERY_FAILED', issueID);
        return { list, complete: false };
      }
      if (kind === 'issues') coverage.issuePagesRead++; else coverage.worklogPagesRead++;
      let added = 0;
      for (const item of result.list) {
        if (kind === 'issues') coverage.scannedIssues++;
        if (seen.has(item.id)) { if (kind === 'issues') coverage.duplicateIssues++; else coverage.duplicateWorklogs++; continue; }
        if (kind === 'issues' && list.length === parsed.maxIssues) {
          addProblem('ISSUE_LIMIT'); return { list, complete: false };
        }
        seen.add(item.id); list.push(item); added++;
      }
      if (!result.pageInfo.hasNextPage) return { list, complete: true };
      const next = result.pageInfo.endCursor;
      if (!next || cursors.has(next) || (result.list.length > 0 && added === 0)) {
        addProblem('PAGINATION_UNAVAILABLE', issueID); return { list, complete: false };
      }
      cursors.add(next); cursor = next;
    }
    addProblem(kind === 'issues' ? 'ISSUE_PAGE_LIMIT' : 'WORKLOG_PAGE_LIMIT', issueID);
    return { list, complete: false };
  }
  const source = await collect((cursor) => api.listIssues({ teamID: parsed.teamID, limit: 100,
    ...(parsed.projectID === undefined ? {} : { projectID: parsed.projectID }),
    ...(parsed.issueTypeID === undefined ? {} : { issueTypeID: parsed.issueTypeID }),
    ...(cursor === undefined ? {} : { cursor }) }, combined), parsed.maxIssuePages, 'issues');
  coverage.issueScanComplete = source.complete;
  const days = labels(parsed.startDate, parsed.endDate).map((date) => ({ date, isPlanningDay: planningDay(Date.parse(date), parsed.calendar),
    plannedHours: 0, registeredHours: 0, plannedIssueCount: 0, registeredRecordCount: 0 }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const allocations: z.infer<typeof dailyHoursOutput>['allocations'] = [], unallocated: z.infer<typeof dailyHoursOutput>['unallocated'] = [];
  let remainingHoursKnown = 0, unallocatedRemainingHoursKnown = 0;
  const included: typeof source.list = [];
  for (const issue of source.list) {
    const filters = [[parsed.projectID, entityID(issue.project)], [parsed.issueTypeID, entityID(issue.issueType)]];
    if (filters.some(([filter, actual]) => filter !== undefined && actual !== undefined && filter !== actual)) continue;
    if (filters.some(([filter, actual]) => filter !== undefined && actual === undefined)) {
      coverage.unknownScopeIssues++; addProblem('UNKNOWN_ISSUE_SCOPE', issue.id); continue;
    }
    included.push(issue);
    const owner = entityID(issue.assignee), status = entityID(issue.status);
    if (userIDs !== undefined && owner !== undefined && (owner === null || !userIDs.includes(owner))) continue;
    if (parsed.excludePlannedStatusIDs !== undefined && status !== undefined && status !== null && parsed.excludePlannedStatusIDs.includes(status)) continue;
    let remaining: number | undefined;
    const exclude = (reason: z.infer<typeof unallocatedReason>) => {
      unallocated.push({ issueID: issue.id, title: issue.title, reason, ...(remaining === undefined ? {} : { remainingHours: rounded(remaining) }) });
      if (remaining !== undefined) unallocatedRemainingHoursKnown += remaining;
    };
    if (userIDs !== undefined && owner === undefined) { coverage.planInputsComplete = false; exclude('unknownAssignee'); continue; }
    if (parsed.excludePlannedStatusIDs !== undefined && status === undefined) { coverage.planInputsComplete = false; exclude('unknownStatus'); continue; }
    const estimate = issue.timeEstimatedHour, spent = issue.timeSpentHour;
    if (estimate === undefined || estimate === null) { coverage.planInputsComplete = false; exclude('missingEstimate'); continue; }
    if (spent === undefined || spent === null) { coverage.planInputsComplete = false; exclude('missingSpent'); continue; }
    if (typeof estimate !== 'number' || typeof spent !== 'number' || !Number.isFinite(estimate) || !Number.isFinite(spent) || estimate < 0 || spent < 0) {
      coverage.planInputsComplete = false; exclude('invalidHours'); continue;
    }
    remaining = Math.max(estimate - spent, 0); remainingHoursKnown += remaining;
    if (remaining === 0) continue;
    const dueDate = issue.dueDate;
    if (dueDate === undefined || dueDate === null || dueDate === '') { exclude('missingDueDate'); continue; }
    if (typeof dueDate !== 'string' || !validDate(dueDate)) { exclude('invalidDueDate'); continue; }
    if (dueDate < allocationStartDate) { exclude('overdue'); continue; }
    if ((Date.parse(dueDate) - Date.parse(allocationStartDate)) / DAY > 3660) { exclude('horizonTooLong'); continue; }
    const allocationDays = labels(allocationStartDate, dueDate).filter((date) => planningDay(Date.parse(date), parsed.calendar)).length;
    if (!allocationDays) { exclude('noPlanningDays'); continue; }
    const daily = remaining / allocationDays;
    let inRange = 0;
    for (const day of days) if (day.isPlanningDay && day.date >= allocationStartDate && day.date <= dueDate) {
      day.plannedHours += daily; day.plannedIssueCount++; inRange += daily;
    }
    allocations.push({ issueID: issue.id, title: issue.title, ...(typeof owner === 'string' ? { assigneeID: owner } : {}),
      estimatedHours: estimate, cumulativeRegisteredHours: spent, remainingHours: rounded(remaining), dueDate,
      allocationDays, dailyHours: rounded(daily), plannedHoursInRange: rounded(inRange) });
  }
  coverage.includedIssues = included.length;
  for (const issue of included) {
    checkCancel();
    if (budget.aborted) { coverage.worklogScanComplete = false; addProblem('TIME_BUDGET'); break; }
    const records = await collect((cursor) => api.listIssueWorklogs({ teamID: parsed.teamID, issueID: issue.id, limit: 100,
      ...(cursor === undefined ? {} : { cursor }) }, combined), parsed.maxWorklogPagesPerIssue, 'worklogs', issue.id);
    if (records.complete) coverage.worklogIssuesCompleted++; else coverage.worklogScanComplete = false;
    for (const record of records.list) {
      coverage.uniqueWorklogsRead++;
      const owner = entityID(record.owner);
      if (userIDs !== undefined && owner !== undefined && (owner === null || !userIDs.includes(owner))) continue;
      const hours = record.hours, startTime = record.startTime;
      if ((userIDs !== undefined && owner === undefined) || typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 ||
          typeof startTime !== 'number' || !Number.isInteger(startTime) || startTime < 0 || startTime > 253402300799) {
        coverage.invalidWorklogs++; coverage.worklogScanComplete = false; addProblem('UNUSABLE_WORKLOG', issue.id); continue;
      }
      const day = byDate.get(dateInZone(startTime * 1000, parsed.timeZone));
      if (day) { day.registeredHours += hours; day.registeredRecordCount++; }
    }
  }
  checkCancel();
  coverage.complete = coverage.issueScanComplete && coverage.worklogScanComplete && coverage.planInputsComplete && coverage.unknownScopeIssues === 0;
  coverage.allKnownRemainingHoursScheduled = coverage.issueScanComplete && coverage.planInputsComplete && coverage.unknownScopeIssues === 0 && unallocated.length === 0;
  const plannedHoursInRange = rounded(days.reduce((sum, day) => sum + day.plannedHours, 0));
  const registeredHoursInRange = rounded(days.reduce((sum, day) => sum + day.registeredHours, 0));
  for (const day of days) { day.plannedHours = rounded(day.plannedHours); day.registeredHours = rounded(day.registeredHours); }
  return {
    range: { startDate: parsed.startDate, endDate: parsed.endDate, timeZone: parsed.timeZone, asOfDate, allocationStartDate, calendar: parsed.calendar },
    scope: { teamID: parsed.teamID, ...(parsed.projectID === undefined ? {} : { projectID: parsed.projectID }),
      ...(parsed.issueTypeID === undefined ? {} : { issueTypeID: parsed.issueTypeID }), ...(userIDs === undefined ? {} : { userIDs }),
      ...(parsed.excludePlannedStatusIDs === undefined ? {} : { excludePlannedStatusIDs: parsed.excludePlannedStatusIDs }) },
    days, totals: { plannedHoursInRange, registeredHoursInRange,
      remainingHoursKnown: rounded(remainingHoursKnown), unallocatedRemainingHoursKnown: rounded(unallocatedRemainingHoursKnown) },
    allocations, unallocated, coverage, problems,
    notes: ['只读当前快照预测，不重建历史计划；展示范围不会改变分摊分母。',
      '计划采用工作项自身 max(timeEstimatedHour-timeSpentHour,0)，不使用 total 聚合字段或 timeRemainingHour，不重复扣减；不按名称猜测完成状态。',
      '按负责人筛选计划、按登记人筛选实际工时；累计已登记工时扣减不限展示日期或登记人。登记按 startTime 所在时区日期归属，整条记录计入当天。',
      '默认周一至周五分摊，不自动扣法定节假日；周末登记工时照常汇总。到期日包含当天；缺少到期日、逾期或无有效分摊日单列。',
      '统计仅覆盖当前权限可见工作项的简单工时模式；来源可能并发变化。complete=false 时每日数值仅为已读可判定部分，不能当作完整总数。',
      '小时数仅在输出时保留八位小数，分摊及合计中间值不舍入；展示行之和可能有末位舍入差。'],
  };
}
