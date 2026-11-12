import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OnesApi } from '../dist/api.js';
import { createServer } from '../dist/server.js';
import { mutationCommand } from '../dist/mutation-schema.js';

const KEY = 'synthetic-mutation-secret';
const create = { teamID: 'team1', requestID: 'request-create-1', projectID: 'project1', issueTypeID: 'type1', assignee: 'user1',
  title: 'New issue', fieldValues: [{ fieldID: 'custom01', type: 2, value: 'Description' }], watchers: [] };
const update = { teamID: 'team1', requestID: 'request-update-1', issueID: 'issue1', title: 'Updated title' };
const workflow = { teamID: 'team1', requestID: 'request-workflow-1', issueID: 'issue1', workflowID: 'flow1' };
const worklog = { teamID: 'team1', requestID: 'request-worklog-1', issueID: 'issue1', hours: 0.12345,
  startTime: 1700000000, owner: { id: 'user1' }, description: 'Worked' };
const success = (data) => ({ result: 'SUCCESS', ...(data === undefined ? {} : { data }) });
const codeOf = (result) => JSON.parse(result.content[0].text).code;

async function fixture({ decision = { action: 'accept', content: { confirm: true } }, supportsForm = true,
  onReview, mutationResponse, beforeRequest } = {}) {
  const requests = [], reviews = [];
  const state = { key: KEY, version: 1, workflowAvailable: true, active: true, userID: 'user1',
    commentText: 'Original comment', commentVisible: true, worklogHours: 1.5 };
  const api = new OnesApi({ origin: 'https://ones.example.com', environmentApiKey: undefined }, { get: async () => state.key }, async (url, options) => {
    await beforeRequest?.(url, options, state);
    requests.push({ url, options });
    if (options.method !== 'GET') {
      if (mutationResponse) return mutationResponse(url, options);
      if (url.searchParams.get('action') === 'executeWorkflow') return Response.json(success());
      if (options.method === 'DELETE' || /\/comments(?:\/[^/]+)?$/.test(url.pathname) || /\/times(?:Estimated|Remaining)$/.test(url.pathname)) return Response.json(success());
      const body = JSON.parse(options.body);
      if (/\/timesSpent(?:\/[^/]+)?$/.test(url.pathname)) return Response.json(success({ id: 'log1', hours: body.hours, startTime: body.startTime, owner: { id: 'user1', name: 'User' } }));
      return Response.json(success({ id: url.pathname.endsWith('/issue1') ? 'issue1' : 'created1', title: body.title, number: 42 }));
    }
    if (url.pathname === '/oauth2/introspect') return Response.json({ active: state.active, sub: state.userID, scope: 'read:project:issue write:project:issue' });
    if (url.searchParams.get('action') === 'executableWorkflow') return Response.json(success(state.workflowAvailable ? [{ id: 'flow1', name: 'Close', start: 'open1', end: 'done1' }] : []));
    if (url.pathname.includes('/projects/')) return Response.json(success({ id: 'project1', name: 'Project' }));
    if (url.pathname.endsWith('/comments')) return Response.json(success({ list: state.commentVisible ? [{ id: 'comment1', text: state.commentText }] : [], pageInfo: { hasNextPage: true, endCursor: 'other' } }));
    if (url.pathname.endsWith('/timesSpent/log1')) return Response.json(success({ id: 'log1', hours: state.worklogHours, description: 'Original work', startTime: 1700000000 }));
    return Response.json(success({ id: 'issue1', title: 'Current title', updateTime: state.version, status: { id: 'open1', name: 'Open' } }));
  });
  const server = createServer({}, api);
  const client = new Client({ name: 'mutation-review-test', version: '1.0' }, { capabilities: supportsForm ? { elicitation: { form: {} } } : {} });
  if (supportsForm) client.setRequestHandler(ElicitRequestSchema, async (request) => {
    reviews.push(request);
    assert.equal(request.params.mode, 'form');
    assert.equal(request.params.requestedSchema.properties.confirm.default, false);
    assert.equal(requests.filter((r) => r.options.method !== 'GET').length, 0, 'write must not precede review');
    await onReview?.({ request, state, requests });
    return typeof decision === 'function' ? decision() : decision;
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { api, server, client, requests, reviews, state,
    writes: () => requests.filter((r) => r.options.method !== 'GET'),
    call: (name, args) => client.callTool({ name, arguments: args }),
    close: async () => { await client.close(); await server.close(); },
  };
}

test('all mutation tools advertise writes and confirmation while 18 tools remain read-only', async () => {
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools;
    assert.equal(tools.length, 30);
    assert.ok(tools.slice(0, 19).every((tool) => tool.annotations.readOnlyHint));
    for (const tool of tools.slice(19)) {
      assert.equal(tool.annotations.readOnlyHint, false);
      assert.equal(tool.annotations.destructiveHint, true);
      assert.equal(tool.annotations.idempotentHint, false);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(!Object.hasOwn(tool.inputSchema.properties, 'confirmed'));
    }
  } finally { await f.close(); }
});

for (const [tool, input, method, path] of [
  ['ones_create_issue', create, 'POST', '/project/issues'],
  ['ones_update_issue', update, 'PUT', '/project/issues/issue1'],
  ['ones_execute_issue_workflow', workflow, 'POST', '/project/issues/issue1'],
  ['ones_add_issue_worklog', worklog, 'POST', '/project/issues/issue1/workLog/simple/timesSpent'],
]) {
  test(`${tool} sends exactly the method, target and body shown in the user review`, async () => {
    let reviewed;
    const f = await fixture({ onReview: ({ request }) => {
      const text = request.params.message;
      assert.ok(text.includes('user1'));
      assert.ok(!text.includes(KEY));
      reviewed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } });
    try {
      const result = await f.call(tool, input);
      assert.ok(!result.isError, result.content[0].text);
      assert.equal(result.structuredContent.status, 'completed');
      assert.equal(f.reviews.length, 1);
      assert.equal(f.writes().length, 1);
      const request = f.writes()[0];
      assert.equal(request.options.method, method);
      assert.equal(request.url.pathname, `/openapi/v2${path}`);
      assert.equal(request.url.href, reviewed.request.url);
      assert.equal(request.options.method, reviewed.request.method);
      assert.deepEqual(JSON.parse(request.options.body), reviewed.request.body);
      assert.equal(request.options.redirect, 'error');
      assert.equal(request.options.headers.Authorization, `Bearer ${KEY}`);
      if (tool === 'ones_execute_issue_workflow') {
        assert.equal(request.url.searchParams.get('action'), 'executeWorkflow');
        assert.deepEqual(JSON.parse(request.options.body), { id: 'flow1' });
      }
      if (tool === 'ones_add_issue_worklog') assert.equal(result.structuredContent.result.worklog.hours, 0.12345);
    } finally { await f.close(); }
  });
}

test('unsupported clients cannot write, but can request a read-only preview', async () => {
  const f = await fixture({ supportsForm: false });
  try {
    const denied = await f.call('ones_create_issue', create);
    assert.equal(codeOf(denied), 'CONFIRMATION_UNAVAILABLE');
    assert.equal(f.requests.length, 0);
    const preview = await f.call('ones_create_issue', { ...create, previewOnly: true });
    assert.equal(preview.structuredContent.status, 'preview');
    assert.equal(preview.structuredContent.preview.request.body.title, create.title);
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

for (const decision of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirm: false } },
  { action: 'accept' }, { action: 'accept', content: {} }, { action: 'accept', content: { confirm: 'true' } }]) {
  test(`confirmation ${JSON.stringify(decision)} never authorizes a write`, async () => {
    const f = await fixture({ decision });
    try {
      const result = await f.call('ones_create_issue', create);
      assert.ok(result.isError || result.structuredContent.status === 'cancelled');
      assert.equal(f.writes().length, 0);
      await f.call('ones_create_issue', create);
      assert.equal(f.reviews.length, 1, 'replaying a rejected request must not prompt again');
    } finally { await f.close(); }
  });
}

test('previewOnly does not prompt and does not consume the later execution request ID', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('ones_create_issue', { ...create, previewOnly: true })).structuredContent.status, 'preview');
    assert.equal(f.reviews.length, 0);
    assert.equal(f.writes().length, 0);
    assert.equal((await f.call('ones_create_issue', create)).structuredContent.status, 'completed');
    assert.equal(f.reviews.length, 1);
    assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

test('concurrent and later request replays share one confirmation and one write', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([f.call('ones_create_issue', create), f.call('ones_create_issue', create)]);
    assert.deepEqual(a, b);
    assert.deepEqual(await f.call('ones_create_issue', create), a);
    assert.equal(f.reviews.length, 1);
    assert.equal(f.writes().length, 1);
    assert.equal(codeOf(await f.call('ones_create_issue', { ...create, title: 'Different title' })), 'REQUEST_ID_CONFLICT');
    assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

test('request IDs also prevent reuse across different operations', async () => {
  const f = await fixture();
  try {
    await f.call('ones_create_issue', create);
    assert.equal(codeOf(await f.call('ones_update_issue', { ...update, requestID: create.requestID })), 'REQUEST_ID_CONFLICT');
    assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

test('changed credentials after approval cannot change the account used for the write', async () => {
  const f = await fixture({ onReview: ({ state }) => { state.key = 'replacement-synthetic-key'; } });
  try {
    assert.equal(codeOf(await f.call('ones_create_issue', create)), 'CREDENTIAL_CHANGED');
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('work item changes during review stop updates before writing', async () => {
  const f = await fixture({ onReview: ({ state }) => { state.version++; } });
  try {
    assert.equal(codeOf(await f.call('ones_update_issue', update)), 'TARGET_CHANGED');
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('a workflow must be executable before review and still executable after approval', async () => {
  const before = await fixture();
  before.state.workflowAvailable = false;
  try {
    assert.equal(codeOf(await before.call('ones_execute_issue_workflow', workflow)), 'WORKFLOW_UNAVAILABLE');
    assert.equal(before.reviews.length, 0);
    assert.equal(before.writes().length, 0);
  } finally { await before.close(); }
  const after = await fixture({ onReview: ({ state }) => { state.workflowAvailable = false; } });
  try {
    assert.equal(codeOf(await after.call('ones_execute_issue_workflow', workflow)), 'WORKFLOW_UNAVAILABLE');
    assert.equal(after.writes().length, 0);
  } finally { await after.close(); }
});

test('strict mutation schemas reject forged approval, missing values, duplicate fields and unsafe paths', async () => {
  const f = await fixture();
  try {
    for (const [tool, input] of [
      ['ones_create_issue', { ...create, confirmed: true }],
      ['ones_create_issue', { ...create, fieldValues: [{ fieldID: 'custom01' }] }],
      ['ones_create_issue', { ...create, fieldValues: [create.fieldValues[0], create.fieldValues[0]] }],
      ['ones_create_issue', { ...create, title: ' ' }],
      ['ones_create_issue', { ...create, assignee: 'too-long-user-id' }],
      ['ones_update_issue', { ...update, issueID: '../escape' }],
      ['ones_update_issue', { ...update, title: undefined }],
      ['ones_update_issue', { ...update, fieldValues: [{ fieldID: 'field005', value: 'done' }] }],
      ['ones_update_issue', { ...update, fieldValues: [{ fieldID: 'custom01', type: 12, value: 'done' }] }],
      ['ones_add_issue_worklog', { ...worklog, hours: 0 }],
      ['ones_add_issue_worklog', { ...worklog, hours: 0.123456 }],
      ['ones_add_issue_worklog', { ...worklog, startTime: 1700000000000 }],
      ['ones_add_issue_worklog', { ...worklog, owner: { id: 'user1', name: 'Unverified' } }],
    ]) assert.equal((await f.call(tool, input)).isError, true, tool);
    assert.equal(f.requests.length, 0);
    assert.equal(f.reviews.length, 0);
  } finally { await f.close(); }
});

test('explicit null clears stay explicit and omitted update fields are never filled in', async () => {
  const f = await fixture({ mutationResponse: () => Response.json(success({ id: 'issue1', title: 'Current title' })) });
  try {
    const input = { ...update, title: undefined, fieldValues: [{ fieldID: 'custom01', value: null }] };
    assert.equal((await f.call('ones_update_issue', input)).structuredContent.status, 'completed');
    assert.deepEqual(JSON.parse(f.writes()[0].options.body), { fieldValues: [{ fieldID: 'custom01', value: null }] });
  } finally { await f.close(); }
});

test('workflow step payloads preserve explicit replacement, comments, resources and hours', async () => {
  const f = await fixture();
  try {
    const input = { ...workflow, linkedWikiPages: [], comment: [{ contentType: 1, text: 'Reviewed' }], resources: [{ id: 'res1' }],
      timeEstimatedHour: { hours: 2 }, timeSpentHour: [{ owner: 'user1', startTime: 1700000000, hours: 1 }],
      fieldValues: [{ fieldID: 'custom01', value: 'value' }] };
    assert.equal((await f.call('ones_execute_issue_workflow', input)).structuredContent.status, 'completed');
    const body = JSON.parse(f.writes()[0].options.body);
    assert.deepEqual(body.linkedWikiPages, []);
    assert.deepEqual(body.timeSpentHour, input.timeSpentHour);
    assert.deepEqual(body.fieldValues, input.fieldValues);
  } finally { await f.close(); }
});

for (const [reason, response] of [
  ['network failure', () => { throw new Error(KEY); }],
  ['HTTP 500', () => Response.json({ message: KEY }, { status: 500 })],
  ['invalid JSON', () => new Response('invalid-json')],
  ['malformed success', () => Response.json(success({ id: 'created1' }))],
  ['missing success flag', () => Response.json({ id: 'created1', title: 'Title' })],
]) {
  test(`${reason} after dispatch reports unknown outcome and cannot be replayed`, async () => {
    const f = await fixture({ mutationResponse: response });
    try {
      const first = await f.call('ones_create_issue', create);
      assert.equal(codeOf(first), 'WRITE_OUTCOME_UNKNOWN');
      assert.ok(!JSON.stringify(first).includes(KEY));
      assert.deepEqual(await f.call('ones_create_issue', create), first);
      assert.equal(f.writes().length, 1);
      assert.equal(f.reviews.length, 1);
    } finally { await f.close(); }
  });
}

test('explicit permission rejection is distinct from uncertain network results', async () => {
  const f = await fixture({ mutationResponse: () => Response.json({ result: 'FAIL', errorCode: 'Forbidden', errorMsg: KEY }) });
  try {
    const result = await f.call('ones_create_issue', create);
    assert.equal(codeOf(result), 'FORBIDDEN');
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

test('a caller or reviewer cannot change the prepared request, and a prepared request executes at most once', async () => {
  const f = await fixture();
  try {
    const command = mutationCommand('createIssue', structuredClone(create));
    const plan = await f.api.prepareMutation(command);
    command.body.title = 'Caller changed';
    plan.preview.request.body.title = 'Reviewer changed';
    await plan.execute();
    assert.equal(JSON.parse(f.writes()[0].options.body).title, create.title);
    await assert.rejects(plan.execute(), { code: 'ALREADY_EXECUTED' });
    assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

test('cancelled requests never dispatch even after a prepared preview exists', async () => {
  const f = await fixture();
  try {
    const plan = await f.api.prepareMutation(mutationCommand('addWorklog', worklog));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(plan.execute(controller.signal), { code: 'CANCELLED' });
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('inactive or unidentified credentials cannot reach confirmation', async () => {
  for (const patch of [{ active: false }, { userID: undefined }]) {
    const f = await fixture();
    Object.assign(f.state, patch);
    try {
      assert.equal(codeOf(await f.call('ones_create_issue', create)), 'UNAUTHORIZED');
      assert.equal(f.reviews.length, 0);
      assert.equal(f.writes().length, 0);
    } finally { await f.close(); }
  }
});

test('a confirmation failure or an expired review cannot authorize a write', async (context) => {
  const failed = await fixture({ decision: () => { throw new Error(KEY); } });
  try {
    const result = await failed.call('ones_create_issue', create);
    assert.equal(codeOf(result), 'CONFIRMATION_FAILED');
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.equal(failed.writes().length, 0);
  } finally { await failed.close(); }
  const realNow = Date.now.bind(Date);
  const expired = await fixture({ onReview: () => context.mock.method(Date, 'now', () => realNow() + 300001) });
  try {
    assert.equal(codeOf(await expired.call('ones_create_issue', create)), 'CONFIRMATION_EXPIRED');
    assert.equal(expired.writes().length, 0);
  } finally { context.mock.restoreAll(); await expired.close(); }
});

test('an oversized preview is refused before asking the user to approve incomplete content', async () => {
  const f = await fixture();
  try {
    const large = { ...create, fieldValues: [{ fieldID: 'custom01', value: 'x'.repeat(65536) }] };
    assert.equal(codeOf(await f.call('ones_create_issue', large)), 'PREVIEW_TOO_LARGE');
    assert.equal(f.reviews.length, 0);
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('cancellation after a dispatched write is uncertain and is not retried', async () => {
  const f = await fixture({ mutationResponse: () => { throw new DOMException('Aborted', 'AbortError'); } });
  try {
    const plan = await f.api.prepareMutation(mutationCommand('createIssue', create));
    await assert.rejects(plan.execute(), { code: 'WRITE_OUTCOME_UNKNOWN' });
    assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

test('a success response for the wrong work item is an unknown outcome', async () => {
  const f = await fixture({ mutationResponse: () => Response.json(success({ id: 'different', title: 'Changed' })) });
  try {
    assert.equal(codeOf(await f.call('ones_update_issue', update)), 'WRITE_OUTCOME_UNKNOWN');
    assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

const maintenanceCases = [
  ['ones_send_issue_comment', { issueID: 'issue1', text: 'New comment', repliedMessageID: 'comment1' }, 'POST', '/comments', { text: 'New comment', repliedMessageID: 'comment1' }],
  ['ones_update_issue_comment', { issueID: 'issue1', commentID: 'comment1', text: 'Edited comment' }, 'PUT', '/comments/comment1', { text: 'Edited comment' }],
  ['ones_delete_issue_comment', { issueID: 'issue1', commentID: 'comment1' }, 'DELETE', '/comments/comment1', undefined],
  ['ones_update_issue_worklog', { ...worklog, worklogID: 'log1', description: '' }, 'PUT', '/workLog/simple/timesSpent/log1',
    { hours: worklog.hours, startTime: worklog.startTime, owner: worklog.owner, description: '' }],
  ['ones_delete_issue_worklog', { issueID: 'issue1', worklogID: 'log1' }, 'DELETE', '/workLog/simple/timesSpent/log1', undefined],
  ['ones_set_issue_estimated_hours', { issueID: 'issue1', hours: 0 }, 'POST', '/workLog/simple/timesEstimated', { hours: 0 }],
  ['ones_set_issue_remaining_hours', { issueID: 'issue1', hours: 1.23456 }, 'POST', '/workLog/simple/timesRemaining', { hours: 1.23456 }],
];
for (const [name, args, method, suffix, expectedBody] of maintenanceCases) {
  test(`${name} reviews its original target, sends the exact approved request and deduplicates`, async () => {
    let reviewed;
    const f = await fixture({ onReview: ({ request }) => {
      const message = request.params.message;
      reviewed = JSON.parse(message.slice(message.indexOf('{'), message.lastIndexOf('}') + 1));
    } });
    const input = { ...args, teamID: 'team1', requestID: 'maintenance-request-1' };
    try {
      const result = await f.call(name, input);
      assert.equal(result.structuredContent?.status, 'completed', result.content[0].text);
      assert.equal(f.writes().length, 1);
      assert.equal(f.reviews.length, 1);
      const sent = f.writes()[0];
      assert.equal(sent.options.method, method);
      assert.equal(sent.url.pathname, `/openapi/v2/project/issues/issue1${suffix}`);
      assert.deepEqual(sent.options.body === undefined ? undefined : JSON.parse(sent.options.body), expectedBody);
      assert.deepEqual(reviewed.request.body, expectedBody);
      assert.equal(reviewed.request.url, sent.url.href);
      if (method === 'DELETE') assert.equal(sent.options.headers['Content-Type'], undefined);
      if ('commentID' in input || 'repliedMessageID' in input) assert.equal(reviewed.target.comment.text, 'Original comment');
      if ('worklogID' in input) assert.equal(reviewed.target.worklog.hours, 1.5);
      assert.deepEqual(await f.call(name, input), result);
      assert.equal(f.writes().length, 1);
    } finally { await f.close(); }
  });
  test(`${name} cannot write after the user declines`, async () => {
    const f = await fixture({ decision: { action: 'decline' } });
    try {
      const result = await f.call(name, { ...args, teamID: 'team1', requestID: 'maintenance-request-1' });
      assert.equal(result.structuredContent?.status, 'cancelled', result.content[0].text);
      assert.equal(f.writes().length, 0);
    } finally { await f.close(); }
  });
}

test('comment editing, deletion and replies refuse targets missing from incomplete lists', async () => {
  for (const [name, args] of maintenanceCases.filter(([name]) => name.includes('comment'))) {
    const f = await fixture();
    f.state.commentVisible = false;
    try {
      const result = await f.call(name, { ...args, teamID: 'team1', requestID: 'comment-missing-request' });
      assert.equal(codeOf(result), 'COMMENT_UNVERIFIED');
      assert.equal(f.reviews.length, 0);
      assert.equal(f.writes().length, 0);
    } finally { await f.close(); }
  }
});

test('changed comments and worklog records stop approved edits and deletions', async () => {
  for (const [name, args] of maintenanceCases.filter(([name]) => /(?:update|delete)_issue_(?:comment|worklog)/.test(name))) {
    const f = await fixture({ onReview: ({ state }) => { state.commentText = 'Changed remotely'; state.worklogHours++; } });
    try {
      assert.equal(codeOf(await f.call(name, { ...args, teamID: 'team1', requestID: 'changed-target-request' })), 'TARGET_CHANGED');
      assert.equal(f.writes().length, 0);
    } finally { await f.close(); }
  }
});

test('comment and worklog maintenance validate bounded text, exact replacement fields and zero-hour semantics', async () => {
  const f = await fixture();
  try {
    for (const [name, input] of [
      ['ones_send_issue_comment', { issueID: 'issue1', text: 'x'.repeat(129) }],
      ['ones_send_issue_comment', { issueID: 'issue1', text: ' ' }],
      ['ones_update_issue_comment', { issueID: 'issue1', commentID: '../escape', text: 'Valid' }],
      ['ones_delete_issue_comment', { issueID: 'issue1', commentID: 'comment1', confirmed: true }],
      ['ones_update_issue_worklog', { ...worklog, worklogID: 'log1', description: undefined }],
      ['ones_update_issue_worklog', { ...worklog, worklogID: 'log1', hours: 0 }],
      ['ones_set_issue_estimated_hours', { issueID: 'issue1', hours: -1 }],
      ['ones_set_issue_remaining_hours', { issueID: 'issue1', hours: 0.123456 }],
    ]) assert.equal((await f.call(name, { ...input, teamID: 'team1', requestID: 'invalid-maintenance-request' })).isError, true);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('DELETE failures after dispatch remain unknown and cannot be replayed', async () => {
  const f = await fixture({ mutationResponse: () => { throw new Error(KEY); } });
  try {
    const input = { teamID: 'team1', issueID: 'issue1', commentID: 'comment1', requestID: 'delete-unknown-request' };
    const result = await f.call('ones_delete_issue_comment', input);
    assert.equal(codeOf(result), 'WRITE_OUTCOME_UNKNOWN');
    assert.deepEqual(await f.call('ones_delete_issue_comment', input), result);
    assert.equal(f.writes().length, 1);
    assert.ok(!JSON.stringify(result).includes(KEY));
  } finally { await f.close(); }
});
