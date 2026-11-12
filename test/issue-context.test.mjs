import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OnesApi } from '../dist/api.js';
import { createServer } from '../dist/server.js';

const KEY = 'synthetic-issue-context-api-key';
const config = { origin: 'https://ones.example.com', environmentApiKey: KEY };
const args = { teamID: 'team1', issueID: 'issue1' };
const page = (list, hasNextPage = false) => ({ list, pageInfo: { hasNextPage, endCursor: 'next+/=&', totalCount: 3 } });
const success = (data) => ({ result: 'SUCCESS', data });
function fixture(body, status = 200) {
  const requests = [];
  const api = new OnesApi(config, { get: async () => null }, async (url, options) => {
    requests.push({ url, options });
    return Response.json(typeof body === 'function' ? body(url, options) : body, { status });
  });
  return { api, requests };
}

test('field options map filters to the documented POST without assuming a common option shape', async () => {
  const options = [{ uuid: 'option1', value: 'High', color: '#FFFFFF' },
    { uuid: 'user1', name: 'User', avatar: 'avatar-ref', custom: { nested: true } }];
  for (const wrap of [(data) => data, success, (data) => [success(data)]]) {
    const { api, requests } = fixture(wrap(options));
    assert.deepEqual(await api.getFieldOptions({ teamID: 'team1', fieldID: 'field1',
      keyword: '高 & +', optionIDs: ['option1'], includeFields: ['uuid', 'value'], limit: 2, offset: 4 }), { options });
    const { url, options: request } = requests[0];
    assert.equal(url.href, 'https://ones.example.com/openapi/v3alpha/field/options?teamID=team1');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { field_uuid: 'field1', keyword: '高 & +',
      uuids: ['option1'], include_fields: ['uuid', 'value'], limit: 2, offset: 4 });
    assert.equal(request.redirect, 'error');
  }
});

test('field options use offset pagination defaults and preserve empty results and empty ID filters', async () => {
  const { api, requests } = fixture([]);
  assert.deepEqual(await api.getFieldOptions({ teamID: 'team1', fieldID: 'field1' }), { options: [] });
  assert.deepEqual(JSON.parse(requests[0].options.body), { field_uuid: 'field1', limit: 20, offset: 0 });
  await api.getFieldOptions({ teamID: 'team1', fieldID: 'field1', offset: 20, optionIDs: [] });
  assert.deepEqual(JSON.parse(requests[1].options.body), { field_uuid: 'field1', limit: 20, offset: 20, uuids: [] });
});

test('team statuses preserve category and pageInfo without inventing pagination or project scope', async () => {
  const data = page([{ id: 'status1', name: 'Open', category: 'to_do', buildIn: true }], true);
  const { api, requests } = fixture(success(data));
  assert.deepEqual(await api.listIssueStatuses({ teamID: 'team1', projectID: 'ignored', cursor: 'ignored', limit: 1 }), data);
  assert.equal(requests[0].url.href, 'https://ones.example.com/openapi/v2/project/issueStatuses?teamID=team1');
});

test('workflow lookup reads executable actions without executing or modifying a workflow', async () => {
  const workflows = [{ id: 'workflow1', name: 'Close', start: 'open1', end: 'done1', extra: true }];
  const { api, requests } = fixture([success(workflows)]);
  assert.deepEqual(await api.listIssueWorkflows(args), { workflows });
  assert.equal(requests[0].url.pathname, '/openapi/v2/project/issues/issue1');
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), { teamID: 'team1', action: 'executableWorkflow' });
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.body, undefined);
  assert.deepEqual(await fixture(success([])).api.listIssueWorkflows(args), { workflows: [] });
});

test('comments accept the documented lowercase success while keeping incomplete pageInfo', async () => {
  const data = page([{ id: 'comment1', text: 'Comment', owner: { id: 'user1', name: 'User' }, createTime: 1700000000 }], true);
  const { api, requests } = fixture({ result: 'success', data });
  assert.deepEqual(await api.listIssueComments({ ...args, limit: 1, cursor: 'ignored' }), data);
  assert.equal(requests[0].url.href, 'https://ones.example.com/openapi/v2/project/issues/issue1/comments?teamID=team1');
  assert.equal(requests[0].options.method, 'GET');
});

test('comments accept direct arrays without inventing page metadata or completeness', async () => {
  const list = [{ id: 'comment1', text: 'Comment', createTime: 1700000000 }];
  for (const wrap of [(data) => data, success, (data) => ({ data })]) {
    assert.deepEqual(await fixture(wrap(list)).api.listIssueComments(args), { list });
    assert.deepEqual(await fixture(wrap([])).api.listIssueComments(args), { list: [] });
  }
});

test('v3alpha reference objects in option results remain intact', async () => {
  const options = [{ __reference_object__: { uuid: 'option1', value: 'High', name: 'High' } }];
  assert.deepEqual(await fixture(options).api.getFieldOptions({ teamID: 'team1', fieldID: 'field1' }), { options });
});

test('worklogs paginate and preserve fractional hours, timestamps and metadata unchanged', async () => {
  const data = page([{ id: 'log1', hours: 1.23456, startTime: 1700000000, description: 'Worked',
    owner: { id: 'user1', name: 'User' }, extra: true }], true);
  const { api, requests } = fixture(success(data));
  const first = await api.listIssueWorklogs({ ...args, limit: 1 });
  assert.deepEqual(first, data);
  await api.listIssueWorklogs({ ...args, limit: 1, cursor: first.pageInfo.endCursor });
  assert.equal(requests[0].url.pathname, '/openapi/v2/project/issues/issue1/workLog/simple/timesSpent');
  assert.deepEqual(Object.fromEntries(requests[1].url.searchParams), { teamID: 'team1', limit: '1', cursor: 'next+/=&' });
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.body, undefined);
});

test('worklog detail uses the worklog ID as a path parameter and wraps the raw record', async () => {
  const worklog = { id: 'log1', hours: 0.5, description: '', startTime: 1700000000, owner: { id: 'user1', name: 'User' } };
  const { api, requests } = fixture(success(worklog));
  assert.deepEqual(await api.getIssueWorklog({ ...args, worklogID: 'log1' }), { worklog });
  assert.equal(requests[0].url.href, 'https://ones.example.com/openapi/v2/project/issues/issue1/workLog/simple/timesSpent/log1?teamID=team1');
});

test('new query inputs reject unsafe paths and unbounded paging before networking', async () => {
  const { api, requests } = fixture({});
  for (const input of [{ fieldID: '../x' }, { limit: 101 }, { offset: -1 }, { offset: 1.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 }, { keyword: 'x'.repeat(257) }, { optionIDs: Array(101).fill('id1') }, { includeFields: [] }]) {
    await assert.rejects(api.getFieldOptions({ teamID: 'team1', fieldID: 'field1', ...input }));
  }
  assert.throws(() => api.listIssueStatuses({ teamID: '../x' }));
  await assert.rejects(api.listIssueWorkflows({ ...args, issueID: '../x' }));
  await assert.rejects(api.listIssueComments({ ...args, issueID: '../x' }));
  assert.throws(() => api.listIssueWorklogs({ ...args, limit: 101 }));
  await assert.rejects(api.getIssueWorklog({ ...args, worklogID: '../x' }));
  assert.equal(requests.length, 0);
});

test('new query schemas reject malformed payloads instead of reporting successful empty data', async () => {
  for (const [method, input, invalid] of [
    ['getFieldOptions', { teamID: 'team1', fieldID: 'field1' }, [{}, [null], ['option']]],
    ['listIssueStatuses', { teamID: 'team1' }, [{}, page([{ id: 's1' }])]],
    ['listIssueWorkflows', args, [{ list: [] }, [{ id: 'w1' }]]],
    ['listIssueComments', args, [{}, page([{ id: 'c1' }])]],
    ['listIssueWorklogs', args, [{}, page([{ id: 'l1', hours: '1' }])]],
    ['getIssueWorklog', { ...args, worklogID: 'log1' }, [{}, { id: 'l1', hours: null }]],
  ]) {
    for (const payload of invalid) await assert.rejects(fixture(success(payload)).api[method](input), { code: 'INVALID_RESPONSE' });
  }
});

test('documented business permission and parameter errors remain safe actionable failures', async () => {
  for (const [remote, code] of [['PermissionDenied', 'FORBIDDEN'], ['AccessDenied', 'FORBIDDEN'],
    ['MissingParameter', 'BAD_REQUEST'], ['InvalidParameter', 'BAD_REQUEST']]) {
    const { api, requests } = fixture({ result: 'FAIL', errorCode: remote, errorMsg: KEY });
    await assert.rejects(api.listIssueComments(args), (error) => error.code === code && !error.message.includes(KEY));
    assert.equal(requests.length, 1);
  }
});

test('all new tools run through MCP with structured output, read-only annotations and credential redaction', async () => {
  const { api, requests } = fixture((url) => {
    if (url.pathname.endsWith('/field/options')) return success([{ uuid: 'option1', value: KEY, api_key: 'hidden' }]);
    if (url.pathname.endsWith('/issueStatuses')) return success(page([{ id: 'status1', name: 'Open' }]));
    if (url.searchParams.has('action')) return success([{ id: 'workflow1', name: 'Close', start: 'status1', end: 'status2' }]);
    if (url.pathname.endsWith('/comments')) return success(page([{ id: 'comment1', text: KEY, access_token: 'hidden' }]));
    const log = { id: 'log1', hours: 0.5, description: KEY };
    return success(url.pathname.endsWith('/log1') ? log : page([log]));
  });
  const server = createServer({}, api);
  const client = new Client({ name: 'issue-context-test', version: '1.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const calls = [
    ['ones_get_field_options', { teamID: 'team1', fieldID: 'field1' }, (data) => assert.equal(data.options[0].value, '[REDACTED]')],
    ['ones_list_issue_statuses', { teamID: 'team1' }, (data) => assert.equal(data.list[0].id, 'status1')],
    ['ones_list_issue_workflows', args, (data) => assert.equal(data.workflows[0].end, 'status2')],
    ['ones_list_issue_comments', args, (data) => assert.equal(data.list[0].text, '[REDACTED]')],
    ['ones_list_issue_worklogs', args, (data) => assert.equal(data.list[0].hours, 0.5)],
    ['ones_get_issue_worklog', { ...args, worklogID: 'log1' }, (data) => assert.equal(data.worklog.hours, 0.5)],
  ];
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tools = (await client.listTools()).tools;
    for (const [name, input, check] of calls) {
      const tool = tools.find((tool) => tool.name === name);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      const result = await client.callTool({ name, arguments: input });
      assert.ok(!result.isError, name);
      check(result.structuredContent);
      assert.ok(!JSON.stringify(result).includes(KEY));
      assert.ok(!JSON.stringify(result).includes('hidden'));
    }
    const before = requests.length;
    const bad = await client.callTool({ name: 'ones_get_field_options', arguments: { teamID: 'team1', fieldID: 'field1', limit: 101 } });
    assert.equal(bad.isError, true);
    assert.equal(requests.length, before);
  } finally { await client.close(); await server.close(); }
});

test('read-only POST does not retry and shares safe cancellation behavior', async () => {
  const controller = new AbortController();
  let count = 0;
  const api = new OnesApi(config, { get: async () => null }, async (_url, options) => {
    count++;
    assert.equal(options.signal.aborted, true);
    throw new Error(KEY);
  });
  controller.abort();
  await assert.rejects(api.getFieldOptions({ teamID: 'team1', fieldID: 'field1' }, controller.signal), { code: 'CANCELLED' });
  assert.equal(count, 0);
  const rate = fixture({ errorMsg: KEY }, 429);
  await assert.rejects(rate.api.getFieldOptions({ teamID: 'team1', fieldID: 'field1' }), { code: 'RATE_LIMITED' });
  assert.equal(rate.requests.length, 1);
});
