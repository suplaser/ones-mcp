import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OnesApi } from '../dist/api.js';
import { dailyHours, dailyHoursOutput } from '../dist/daily-hours.js';
import { createServer } from '../dist/server.js';

const KEY = 'synthetic-daily-hours-key';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const base = { teamID: 'team1', startDate: '2026-11-12', endDate: '2026-11-16', timeZone: 'UTC' };
const issue = (id, changes = {}) => ({ id, title: 'Task', project: { id: 'p1' }, issueType: { id: 't1' },
  assignee: { id: 'u1' }, status: { id: 'open1' }, timeEstimatedHour: 14, timeSpentHour: 2,
  totalTimeEstimatedHour: 999, totalTimeSpentHour: 999, timeRemainingHour: 999, dueDate: '2026-11-16', ...changes });
const log = (id, date, hours = 1, owner = 'u1') => ({ id, hours, startTime: Date.parse(date) / 1000,
  owner: { id: owner, name: 'User' } });
const page = (list, endCursor) => ({ list, pageInfo: { hasNextPage: endCursor !== undefined,
  ...(endCursor === undefined ? {} : { endCursor }) } });
function fixture(issues, logs = {}, actor = { active: true, sub: 'u1' }) {
  const requests = [];
  const api = new OnesApi({ origin: 'https://ones.example.com', environmentApiKey: KEY }, { get: async () => null }, async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    if (url.pathname === '/oauth2/introspect') return Response.json(actor);
    if (url.pathname === '/openapi/v2/project/issues') {
      const result = typeof issues === 'function' ? issues(url, options) : Array.isArray(issues) ? page(issues) : issues[url.searchParams.get('cursor') ?? 'first'];
      return Response.json({ result: 'SUCCESS', data: result });
    }
    const issueID = url.pathname.split('/')[5];
    const result = typeof logs === 'function' ? logs(issueID, url, options)
      : Array.isArray(logs[issueID]) ? page(logs[issueID]) : logs[issueID]?.[url.searchParams.get('cursor') ?? 'first'] ?? page([]);
    if (result instanceof Response) return result;
    return Response.json({ result: 'SUCCESS', data: result });
  });
  return { api, requests, run: (input = {}, now = NOW, signal) => dailyHours(api, { ...base, ...input }, signal, now) };
}

test('weekday forecast deducts lifetime own spent hours once and counts weekend registrations by work date', async () => {
  const f = fixture([issue('i1')], { i1: [log('old', '2026-10-01T00:00:00Z', 2),
    log('thu', '2026-11-12T18:00:00Z', 1.5), log('sat', '2026-11-14T10:00:00Z', 2.25)] });
  const result = await f.run();
  assert.deepEqual(result.days.map(d => d.plannedHours), [4, 4, 0, 0, 4]);
  assert.deepEqual(result.days.map(d => d.registeredHours), [1.5, 0, 2.25, 0, 0]);
  assert.equal(result.totals.remainingHoursKnown, 12);
  assert.equal(result.totals.registeredHoursInRange, 3.75);
  assert.equal(result.allocations[0].allocationDays, 3);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.allKnownRemainingHoursScheduled, true);
  assert.ok(dailyHoursOutput.safeParse(result).success);
});

test('display clipping never changes daily rates or the full denominator through the due date', async () => {
  const f = fixture([issue('i1')]);
  const early = await f.run({ endDate: '2026-11-13' });
  const late = await f.run({ startDate: '2026-11-16', endDate: '2026-11-16' });
  assert.equal(early.allocations[0].allocationDays, 3);
  assert.equal(late.allocations[0].allocationDays, 3);
  assert.equal(late.days[0].plannedHours, early.days[0].plannedHours);
  assert.equal(early.totals.plannedHoursInRange, 8);
  assert.equal(late.totals.plannedHoursInRange, 4);
  const future = await f.run({ allocationStartDate: '2026-11-13' });
  assert.deepEqual(future.days.map(d => d.plannedHours), [0, 6, 0, 0, 6]);
});

test('fractional distributions do not compound per-day rounding into totals', async () => {
  const result = await fixture([issue('thirds', { timeEstimatedHour: 3, timeSpentHour: 2 })]).run();
  assert.deepEqual(result.days.map(d => d.plannedHours), [0.33333333, 0.33333333, 0, 0, 0.33333333]);
  assert.equal(result.totals.plannedHoursInRange, 1);
  assert.equal(result.allocations[0].plannedHoursInRange, 1);
});

test('past display dates show registrations without fabricating historical plans', async () => {
  const result = await fixture([issue('i1')], { i1: [log('past', '2026-11-10T10:00:00Z', 3)] })
    .run({ startDate: '2026-11-09', endDate: '2026-11-13' });
  assert.deepEqual(result.days.map(d => d.plannedHours), [0, 0, 0, 4, 4]);
  assert.equal(result.days[1].registeredHours, 3);
});

test('user scope applies to assignees for plans and log owners across all assignees for registrations', async () => {
  const f = fixture([issue('mine'), issue('other', { assignee: { id: 'u2' } })], {
    mine: [log('not-mine', '2026-11-12T00:00:00Z', 8, 'u2')],
    other: [log('mine-on-other', '2026-11-12T00:00:00Z', 2, 'u1')],
  });
  const result = await f.run({ mineOnly: true });
  assert.deepEqual(result.allocations.map(a => a.issueID), ['mine']);
  assert.equal(result.totals.registeredHoursInRange, 2);
  assert.deepEqual(result.scope.userIDs, ['u1']);
  assert.equal(f.requests.filter(r => r.url.pathname.includes('timesSpent')).length, 2);
  assert.ok(f.requests.filter(r => r.url.pathname.endsWith('/issues')).every(r => !r.url.searchParams.has('assignee')));
  await assert.rejects(fixture([], {}, { active: false }).run({ mineOnly: true }), { code: 'UNAUTHORIZED' });
});

test('timezone determines today and log dates at boundaries without DST affecting calendar-day arithmetic', async () => {
  const f = fixture([issue('i1', { dueDate: '2026-11-13' })], { i1: [
    log('before', '2026-11-12T07:59:59Z', 2), log('after', '2026-11-12T08:00:00Z', 3),
  ] });
  const result = await f.run({ timeZone: 'America/Los_Angeles', startDate: '2026-11-11', endDate: '2026-11-13' });
  assert.deepEqual(result.days.map(d => d.registeredHours), [2, 3, 0]);
  const beforeMidnight = await f.run({ timeZone: 'America/Los_Angeles' }, Date.parse('2026-11-12T07:00:00Z'));
  assert.equal(beforeMidnight.range.asOfDate, '2026-11-11');
  const dst = fixture([issue('i1', { dueDate: '2026-11-02' })]);
  const dstResult = await dst.run({ startDate: '2026-10-30', endDate: '2026-11-02', timeZone: 'America/Los_Angeles', calendar: 'calendarDays' }, Date.parse('2026-10-30T12:00:00Z'));
  assert.deepEqual(dstResult.days.map(d => d.plannedHours), [3, 3, 3, 3]);
  const shanghai = await f.run({ timeZone: 'Asia/Shanghai' });
  assert.equal(shanghai.days[0].registeredHours, 5);
  assert.equal(shanghai.days[1].registeredHours, 0);
});

test('no due date, invalid due date, overdue and weekend-only forecasts retain separate unallocated hours', async () => {
  const f = fixture([issue('missing', { dueDate: null }), issue('invalid', { dueDate: '2026-02-30' }),
    issue('overdue', { dueDate: '2026-11-11' }), issue('weekend', { dueDate: '2026-11-15' })]);
  const result = await f.run({ allocationStartDate: '2026-11-14' });
  assert.deepEqual(result.unallocated.map(i => i.reason), ['missingDueDate', 'invalidDueDate', 'overdue', 'noPlanningDays']);
  assert.equal(result.totals.remainingHoursKnown, 48);
  assert.equal(result.totals.unallocatedRemainingHoursKnown, 48);
  assert.equal(result.coverage.allKnownRemainingHoursScheduled, false);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.totals.plannedHoursInRange, 0);
});

test('missing estimates, spent hours and ownership are unknown instead of zero; overspent work never goes negative', async () => {
  const f = fixture([issue('estimate', { timeEstimatedHour: undefined }), issue('spent', { timeSpentHour: null }),
    issue('invalid', { timeSpentHour: -1 }), issue('overspent', { timeSpentHour: 20 }),
    issue('owner', { assignee: undefined }), issue('normal')]);
  const result = await f.run({ userIDs: ['u1'] });
  assert.deepEqual(result.unallocated.map(i => i.reason), ['missingEstimate', 'missingSpent', 'invalidHours', 'unknownAssignee']);
  assert.equal(result.coverage.planInputsComplete, false);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.totals.remainingHoursKnown, 12);
  assert.equal(result.allocations.length, 1);
});

test('explicit plan status exclusions never remove corresponding registered hours', async () => {
  const f = fixture([issue('closed', { status: { id: 'done' } }), issue('unknown', { status: undefined })], {
    closed: [log('closed-log', '2026-11-12T10:00:00Z', 2)],
  });
  const result = await f.run({ excludePlannedStatusIDs: ['done'] });
  assert.equal(result.totals.plannedHoursInRange, 0);
  assert.equal(result.totals.registeredHoursInRange, 2);
  assert.equal(result.unallocated[0].reason, 'unknownStatus');
  assert.equal(result.coverage.complete, false);
});

test('issue and worklog pagination exhaust all pages, deduplicate records and retain partial coverage on limits', async () => {
  const f = fixture({ first: page([issue('i1')], 'issues+/='), 'issues+/=': page([issue('i1'), issue('i2')]) }, {
    i1: { first: page([log('l1', '2026-11-12T00:00:00Z', 1)], 'logs+/='),
      'logs+/=': page([log('l1', '2026-11-12T00:00:00Z', 1), log('l2', '2026-11-12T00:00:00Z', 2)]) },
  });
  const full = await f.run();
  assert.equal(full.coverage.complete, true);
  assert.equal(full.coverage.duplicateIssues, 1);
  assert.equal(full.coverage.duplicateWorklogs, 1);
  assert.equal(full.totals.registeredHoursInRange, 3);
  const issueLimited = await f.run({ maxIssuePages: 1 });
  assert.equal(issueLimited.coverage.complete, false);
  assert.equal(issueLimited.coverage.issueScanComplete, false);
  assert.ok(issueLimited.problems.some(p => p.code === 'ISSUE_PAGE_LIMIT'));
  const logLimited = await f.run({ maxWorklogPagesPerIssue: 1 });
  assert.equal(logLimited.coverage.worklogScanComplete, false);
  assert.equal(logLimited.totals.registeredHoursInRange, 1);
  const capped = await fixture([issue('i1'), issue('i2')]).run({ maxIssues: 1 });
  assert.equal(capped.coverage.includedIssues, 1);
  assert.ok(capped.problems.some(p => p.code === 'ISSUE_LIMIT'));
});

test('broken pagination and per-issue permissions cannot produce a complete zero report', async () => {
  const repeated = fixture({ first: page([issue('i1')], 'same'), same: page([issue('i1')], 'same') });
  assert.ok((await repeated.run()).problems.some(p => p.code === 'PAGINATION_UNAVAILABLE'));
  const missing = fixture([issue('i1')], { i1: { first: { list: [], pageInfo: { hasNextPage: true } } } });
  assert.equal((await missing.run()).coverage.complete, false);
  const forbidden = fixture([issue('i1')], () => Response.json({ errorMsg: KEY }, { status: 403 }));
  const result = await forbidden.run();
  assert.equal(result.coverage.worklogScanComplete, false);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.problems[0].code, 'FORBIDDEN');
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('project/type scope is checked locally and unknown scope prevents completeness', async () => {
  const f = fixture([issue('wrong', { project: { id: 'p2' } }), issue('missing', { project: undefined }), issue('valid')]);
  const result = await f.run({ projectID: 'p1', issueTypeID: 't1' });
  assert.equal(result.coverage.includedIssues, 1);
  assert.equal(result.coverage.unknownScopeIssues, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(f.requests[0].url.searchParams.get('projectID'), 'p1');
  assert.equal(f.requests[0].url.searchParams.get('issueTypeID'), 't1');
});

test('malformed worklog dates, hours or filtered ownership count as unknown instead of silently vanishing', async () => {
  const f = fixture([issue('i1')], { i1: [
    { ...log('milliseconds', '2026-11-12T00:00:00Z'), startTime: Date.parse('2026-11-12T00:00:00Z') },
    { ...log('owner', '2026-11-12T00:00:00Z'), owner: undefined },
    { ...log('hours', '2026-11-12T00:00:00Z'), hours: -1 },
  ] });
  const result = await f.run({ userIDs: ['u1'] });
  assert.equal(result.coverage.invalidWorklogs, 3);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.totals.registeredHoursInRange, 0);
});

test('invalid dates, excessive ranges and historical allocation starts fail before requests', async () => {
  const f = fixture([]);
  for (const input of [{ startDate: '2026-02-30' }, { startDate: '2026-11-17' }, { endDate: '2027-11-13' },
    { allocationStartDate: '2026-11-11' }, { timeZone: 'Invalid/Zone' }, { mineOnly: true, userIDs: ['u1'] },
    { maxIssuePages: 21 }, { maxWorklogPagesPerIssue: 21 }, { maxIssues: 501 }, { confirmed: true }]) {
    await assert.rejects(f.run(input));
  }
  assert.equal(f.requests.length, 0);
});

test('cancellation aborts instead of returning a successful partial report', async () => {
  const f = fixture([]), controller = new AbortController(); controller.abort();
  await assert.rejects(f.run({}, NOW, controller.signal), { code: 'CANCELLED' });
  assert.equal(f.requests.length, 0);
  const during = new AbortController();
  const active = fixture([issue('i1')], () => { during.abort(); throw new Error(KEY); });
  await assert.rejects(active.run({}, NOW, during.signal), { code: 'CANCELLED' });
});

test('time budget exposes incomplete actuals while preserving the independently calculated current forecast', async (context) => {
  const controller = new AbortController(), original = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, 'timeout', ms => ms === 25000 ? controller.signal : original(ms));
  const f = fixture([issue('i1'), issue('i2')], () => { controller.abort(); throw new Error(KEY); });
  try {
    const result = await f.run();
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.worklogScanComplete, false);
    assert.equal(result.totals.plannedHoursInRange, 24);
    assert.ok(result.problems.some(p => p.code === 'TIME_BUDGET'));
  } finally { context.mock.restoreAll(); }
});

test('daily hours are exposed as a read-only MCP tool with validated output and redacted credentials', async () => {
  const f = fixture([issue('i1', { title: KEY })]), server = createServer({}, f.api);
  const client = new Client({ name: 'daily-hours-test', version: '1.0' }), [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tool = (await client.listTools()).tools.find(t => t.name === 'ones_get_daily_hours');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    const result = await client.callTool({ name: 'ones_get_daily_hours', arguments: base });
    assert.ok(!result.isError, result.content[0].text);
    assert.ok(dailyHoursOutput.safeParse(result.structuredContent).success);
    assert.ok(!JSON.stringify(result).includes(KEY));
  } finally { await client.close(); await server.close(); }
});
