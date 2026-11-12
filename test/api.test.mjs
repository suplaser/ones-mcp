import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OnesApi } from '../dist/api.js';
import { createServer } from '../dist/server.js';
import { readConfig } from '../dist/config.js';

const KEY = 'synthetic-personal-api-key';
const config = { origin: 'https://ones.cn', environmentApiKey: undefined };
const page = (list, next = false, cursor = 'next-page') => ({ list, pageInfo: { hasNextPage: next, endCursor: cursor, totalCount: 2 } });
const success = (data) => ({ result: 'SUCCESS', data });
test('cloud API origin is distinct from the existing keychain account; custom deployments stay on their own origin', () => {
  const cloud = readConfig({});
  assert.equal(cloud.origin, 'https://ones.cn');
  assert.equal(cloud.apiOrigin, 'https://sz.ones.cn');
  assert.equal(readConfig({ ONES_BASE_URL: 'https://ones.example.com' }).apiOrigin, 'https://ones.example.com');
  assert.equal(readConfig({ ONES_API_BASE_URL: 'https://api.example.com' }).apiOrigin, 'https://api.example.com');
  assert.throws(() => readConfig({ ONES_API_BASE_URL: 'http://api.example.com' }));
  assert.throws(() => readConfig({ ONES_API_BASE_URL: 'https://user:pass@api.example.com' }));
});
function fixture(body, status = 200) {
  const requests = [];
  const state = { key: KEY };
  const api = new OnesApi(config, { get: async () => state.key }, async (url, options) => {
    requests.push({ url, options });
    return Response.json(typeof body === 'function' ? body(requests.length) : body, { status });
  });
  return { api, requests, state };
}

test('project pagination preserves cursors and totalCount and reads fresh credentials each time', async () => {
  const { api, requests, state } = fixture((n) => success(page([{ id: `p${n}`, name: `Project ${n}` }], n === 1, 'a+/=&')));
  const first = await api.listProjects({ teamID: 'team1', limit: 1 });
  state.key = 'replacement-synthetic-key';
  const second = await api.listProjects({ teamID: 'team1', limit: 1, cursor: first.pageInfo.endCursor });
  assert.equal(first.pageInfo.totalCount, 2);
  assert.equal(first.pageInfo.hasNextPage, true);
  assert.equal(second.list[0].id, 'p2');
  assert.equal(requests[1].url.searchParams.get('cursor'), 'a+/=&');
  assert.equal(requests[0].url.pathname, '/openapi/v2/project/projects');
  assert.equal(requests[0].url.searchParams.get('teamID'), 'team1');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(requests[1].options.headers.Authorization, 'Bearer replacement-synthetic-key');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.redirect, 'error');
});

test('project details unwrap envelopes and preserve business fields', async () => {
  const { api, requests } = fixture(success({ id: 'p1', name: 'Project', owner: { id: 'u1', name: 'User' } }));
  const result = await api.getProject({ teamID: 'team1', projectID: 'p1' });
  assert.equal(result.project.owner.name, 'User');
  assert.equal(requests[0].url.pathname, '/openapi/v2/project/projects/p1');
  assert.equal(requests[0].url.searchParams.get('teamID'), 'team1');
});

test('issue lists pass only documented filters and apply the default page size', async () => {
  const { api, requests } = fixture(success(page([{ id: 'i1', title: 'Issue' }])));
  const result = await api.listIssues({ teamID: 'team1', projectID: 'p1', issueTypeID: 'type1', keyword: 'ignored' });
  assert.equal(result.list[0].title, 'Issue');
  assert.equal(requests[0].url.pathname, '/openapi/v2/project/issues');
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), { teamID: 'team1', limit: '50', projectID: 'p1', issueTypeID: 'type1' });
});

test('issue details accept both documented raw objects and success envelopes', async () => {
  for (const wrap of [(data) => data, success, (data) => [success(data)]]) {
    const { api, requests } = fixture(wrap({ id: 'i1', title: 'Issue', descriptionText: 'Business detail' }));
    assert.equal((await api.getIssue({ teamID: 'team1', issueID: 'i1' })).issue.descriptionText, 'Business detail');
    assert.equal(requests[0].url.pathname, '/openapi/v2/project/issues/i1');
  }
});

test('missing credentials never make network requests', async () => {
  const { api, requests, state } = fixture({});
  state.key = null;
  await assert.rejects(api.listProjects({ teamID: 'team1' }), { code: 'MISSING_API_KEY' });
  assert.equal(requests.length, 0);
});

test('HTTP errors and business failures cannot become successful empty results or leak response messages', async () => {
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'API_ERROR']]) {
    const { api } = fixture({ errorMsg: KEY }, status);
    await assert.rejects(api.listProjects({ teamID: 'team1' }), (error) => error.code === code && !error.message.includes(KEY));
  }
  const { api } = fixture({ result: 'FAIL', errorCode: 'Forbidden', errorMsg: KEY });
  await assert.rejects(api.listProjects({ teamID: 'team1' }), { code: 'FORBIDDEN' });
});

test('malformed success payloads and invalid input are rejected', async () => {
  for (const data of [null, {}, { list: [], pageInfo: {} }, page([{ id: 'p1' }])]) {
    await assert.rejects(fixture(success(data)).api.listProjects({ teamID: 'team1' }), { code: 'INVALID_RESPONSE' });
  }
  const { api, requests } = fixture({});
  assert.throws(() => api.listProjects({ teamID: 'team1', limit: 101 }));
  await assert.rejects(api.getIssue({ teamID: 'team1', issueID: '../escape' }));
  assert.equal(requests.length, 0);
});

test('remote echoes of the active key and secret fields are redacted', async () => {
  const { api } = fixture({ id: 'i1', title: 'Issue', descriptionText: `before ${KEY} after`, apiKey: 'other-secret', nested: { authorization: 'Bearer hidden', status: 'open' } });
  const result = await api.getIssue({ teamID: 'team1', issueID: 'i1' });
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.ok(!JSON.stringify(result).includes('other-secret'));
  assert.equal(result.issue.nested.status, 'open');
});

test('network errors and cancellation return safe actionable codes', async () => {
  const controller = new AbortController();
  const api = new OnesApi(config, { get: async () => KEY }, async () => { throw new Error(KEY); });
  await assert.rejects(api.listProjects({ teamID: 'team1' }), (error) => error.code === 'NETWORK_ERROR' && !error.message.includes(KEY));
  controller.abort();
  await assert.rejects(api.listProjects({ teamID: 'team1' }, controller.signal), { code: 'CANCELLED' });
});

test('MCP queries return structured data and isError for missing credentials', async () => {
  const { api, state } = fixture(success(page([{ id: 'p1', name: 'Project' }])));
  const server = createServer({ status: async () => ({}) }, api);
  const client = new Client({ name: 'query-test', version: '1.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 11);
    assert.ok(tools.filter((tool) => tool.name !== 'ones_auth_status').every((tool) => tool.annotations.readOnlyHint));
    const result = await client.callTool({ name: 'ones_list_projects', arguments: { teamID: 'team1' } });
    assert.equal(result.structuredContent.list[0].id, 'p1');
    state.key = null;
    const missing = await client.callTool({ name: 'ones_list_projects', arguments: { teamID: 'team1' } });
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse(missing.content[0].text).code, 'MISSING_API_KEY');
  } finally { await client.close(); await server.close(); }
});
