import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OnesApi } from '../dist/api.js';
import { searchIssues } from '../dist/search.js';
import { createServer } from '../dist/server.js';

const KEY = 'synthetic-search-key';
const item = (id, changes = {}) => ({ id, title: 'Fix Login', project: { id: 'p1' }, issueType: { id: 't1' },
  assignee: { id: 'u1' }, status: { id: 'open1' }, createTime: 10_000_000, updateTime: 20_000_000, ...changes });
const page = (list, next) => ({ list, pageInfo: { hasNextPage: next !== undefined, ...(next === undefined ? {} : { endCursor: next }) } });
function fixture(pages, actor = { active: true, sub: 'u1' }) {
  const requests = [];
  const api = new OnesApi({ origin: 'https://ones.example.com', environmentApiKey: KEY }, { get: async () => null }, async (url, options) => {
    requests.push({ url, options });
    if (url.pathname === '/oauth2/introspect') return Response.json(actor);
    return Response.json({ result: 'SUCCESS', data: typeof pages === 'function' ? pages(url, options) : pages[url.searchParams.get('cursor') ?? 'first'] });
  });
  return { api, requests };
}

test('combined search applies literal title, project/type, user, status and inclusive time filters', async () => {
  const { api, requests } = fixture({ first: page([
    item('match'), item('title', { title: 'Other' }), item('user', { assignee: { id: 'u2' } }),
    item('status', { status: { id: 'done1' } }), item('created', { createTime: 9_000_000 }), item('updated', { updateTime: 21_000_000 }),
    item('project', { project: { id: 'p2' } }), item('type', { issueType: { id: 't2' } }),
  ]) });
  const result = await searchIssues(api, { teamID: 'team1', projectID: 'p1', issueTypeID: 't1', keyword: 'LOGIN',
    assigneeIDs: ['u1', 'u3'], statusIDs: ['open1'], excludeStatusIDs: ['done1'],
    createdAfter: 10, createdBefore: 10, updatedAfter: 20, updatedBefore: 20 });
  assert.deepEqual(result.list.map((entry) => entry.id), ['match']);
  assert.equal(result.scan.scannedCount, 8);
  assert.equal(result.scan.returnedCount, 1);
  assert.equal(result.scan.exhausted, true);
  assert.equal(result.scan.stopReason, 'end');
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), { teamID: 'team1', limit: '100', projectID: 'p1', issueTypeID: 't1' });
});

test('search scans pages past empty matches and preserves an opaque continuation without claiming a total', async () => {
  const { api, requests } = fixture({ first: page([item('first', { title: 'Other' })], 'next+/=&'),
    'next+/=&': page([item('second')], 'last-page'), 'last-page': page([item('third')]) });
  const first = await searchIssues(api, { teamID: 'team1', keyword: 'login', pageSize: 1, maxPages: 2 });
  assert.deepEqual(first.list.map((row) => row.id), ['second']);
  assert.equal(first.scan.scannedCount, 2);
  assert.equal(first.scan.pagesRead, 2);
  assert.equal(first.scan.exhausted, false);
  assert.equal(first.scan.nextCursor, 'last-page');
  assert.equal(first.scan.stopReason, 'pageLimit');
  assert.ok(!('totalCount' in first.scan));
  assert.equal(requests[1].url.searchParams.get('cursor'), 'next+/=&');
  const last = await searchIssues(api, { teamID: 'team1', keyword: 'login', cursor: first.scan.nextCursor, maxPages: 1 });
  assert.deepEqual(last.list.map((row) => row.id), ['third']);
  assert.equal(last.scan.startedFromCursor, true);
  assert.equal(last.scan.exhausted, true);
  assert.equal(last.scan.nextCursor, undefined);
});

test('date filters use an explicit source unit, preserve subsecond bounds and leave raw timestamps unchanged', async () => {
  for (const [sourceTimeUnit, factor] of [['microseconds', 1_000_000], ['milliseconds', 1_000], ['seconds', 1]]) {
    const f = fixture({ first: page([item('inside', { createTime: 1_700_000_000 * factor }),
      item('after', { createTime: (1_700_000_000.5) * factor })]) });
    const result = await searchIssues(f.api, { teamID: 'team1', sourceTimeUnit,
      createdAfter: 1_700_000_000, createdBefore: 1_700_000_000 });
    assert.deepEqual(result.list.map(row => row.id), ['inside']);
    assert.equal(result.list[0].createTime, 1_700_000_000 * factor);
    assert.equal(result.scan.sourceTimeUnit, sourceTimeUnit);
  }
});

test('assignedToMe uses verified identity instead of guessing an owner', async () => {
  const { api, requests } = fixture({ first: page([item('mine'), item('other', { assignee: { id: 'u2' } })]) });
  const result = await searchIssues(api, { teamID: 'team1', assignedToMe: true });
  assert.deepEqual(result.list.map((row) => row.id), ['mine']);
  assert.equal(requests[0].url.pathname, '/oauth2/introspect');
  for (const actor of [{ active: false }, { active: true }]) {
    const f = fixture({}, actor);
    await assert.rejects(searchIssues(f.api, { teamID: 'team1', assignedToMe: true }), { code: 'UNAUTHORIZED' });
    assert.equal(f.requests.length, 1);
  }
});

test('missing fields are counted as unknown while null assignees remain known nonmatches', async () => {
  const f = fixture({ first: page([item('missing', { assignee: undefined }), item('null', { assignee: null }),
    item('known-false', { assignee: undefined, title: 'Other' }), item('valid')]) });
  const result = await searchIssues(f.api, { teamID: 'team1', assigneeIDs: ['u1'], keyword: 'login' });
  assert.deepEqual(result.list.map((row) => row.id), ['valid']);
  assert.equal(result.scan.unknownFieldCount, 1);
  const missingDates = fixture({ first: page([item('unknown-date', { createTime: undefined }), item('date')]) });
  assert.equal((await searchIssues(missingDates.api, { teamID: 'team1', createdAfter: 0 })).scan.unknownFieldCount, 1);
});

test('repeated cursors, missing cursors and entirely repeated pages stop bounded scanning', async () => {
  for (const pages of [
    { first: page([item('i1')], 'repeat'), repeat: page([item('i2')], 'repeat') },
    { first: { list: [item('i1')], pageInfo: { hasNextPage: true } } },
    { first: page([item('i1')], 'second'), second: page([item('i1')], 'third') },
  ]) {
    const f = fixture(pages);
    const result = await searchIssues(f.api, { teamID: 'team1', maxPages: 10 });
    assert.equal(result.scan.exhausted, false);
    assert.equal(result.scan.stopReason, 'paginationUnavailable');
    assert.equal(result.scan.nextCursor, undefined);
    assert.ok(f.requests.length <= 2);
  }
});

test('duplicate records are returned once within the scan and separately counted', async () => {
  const f = fixture({ first: page([item('i1')], 'second'), second: page([item('i1'), item('i2')]) });
  const result = await searchIssues(f.api, { teamID: 'team1' });
  assert.deepEqual(result.list.map((row) => row.id), ['i1', 'i2']);
  assert.equal(result.scan.duplicateCount, 1);
  assert.equal(result.scan.scannedCount, 3);
});

test('quotes and query-looking text are literal local keywords and are never sent as SQL', async () => {
  const needle = `' OR 1=1; -- \\`;
  const f = fixture({ first: page([item('i1', { title: needle }), item('i2')]) });
  const result = await searchIssues(f.api, { teamID: 'team1', keyword: needle });
  assert.deepEqual(result.list.map((row) => row.id), ['i1']);
  assert.ok(f.requests.every(({ url, options }) => options.method === 'GET' && options.body === undefined && !url.href.includes('onesql')));
});

test('invalid scan bounds, ranges, arbitrary SQL and incompatible user filters are rejected before requests', async () => {
  const f = fixture({});
  for (const input of [{ maxPages: 11 }, { maxPages: 0 }, { pageSize: 101 }, { keyword: ' ' },
    { assignedToMe: true, assigneeIDs: ['u1'] }, { createdAfter: 2, createdBefore: 1 },
    { updatedAfter: 2, updatedBefore: 1 }, { createdAfter: 1700000000000 }, { query: 'select * from issue' }]) {
    await assert.rejects(searchIssues(f.api, { teamID: 'team1', ...input }));
  }
  assert.equal(f.requests.length, 0);
});

test('cancellation never becomes a successful partial search', async () => {
  const f = fixture({ first: page([item('i1')]) });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchIssues(f.api, { teamID: 'team1' }, controller.signal), { code: 'CANCELLED' });
  assert.equal(f.requests.length, 0);
});

test('a spent time budget returns completed pages and the last unconsumed source cursor', async (context) => {
  const controller = new AbortController(), originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, 'timeout', (ms) => ms === 25000 ? controller.signal : originalTimeout(ms));
  const f = fixture((url) => {
    if (url.searchParams.has('cursor')) { controller.abort(); throw new Error(KEY); }
    return page([item('i1')], 'next-page');
  });
  try {
    const result = await searchIssues(f.api, { teamID: 'team1' });
    assert.equal(result.scan.stopReason, 'timeBudget');
    assert.equal(result.scan.exhausted, false);
    assert.equal(result.scan.nextCursor, 'next-page');
    assert.deepEqual(result.list.map((row) => row.id), ['i1']);
  } finally { context.mock.restoreAll(); }
});

test('combined search executes through MCP with validated structured output and credential redaction', async () => {
  const f = fixture({ first: page([item('i1', { descriptionText: KEY, access_token: 'hidden' })]) });
  const server = createServer({}, f.api), client = new Client({ name: 'search-test', version: '1.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tool = (await client.listTools()).tools.find((tool) => tool.name === 'ones_search_issues');
    assert.equal(tool.annotations.readOnlyHint, true);
    const result = await client.callTool({ name: 'ones_search_issues', arguments: { teamID: 'team1', keyword: 'login' } });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.scan.exhausted, true);
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.ok(!JSON.stringify(result).includes('hidden'));
  } finally { await client.close(); await server.close(); }
});
