import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OnesApi } from '../dist/api.js';
import { createServer } from '../dist/server.js';

const KEY = 'synthetic-metadata-api-key';
const config = { origin: 'https://ones.cn', apiOrigin: 'https://sz.ones.cn', environmentApiKey: KEY };
const page = (list, hasNextPage = false) => ({ list, pageInfo: { hasNextPage, endCursor: 'next+/=', totalCount: 20 } });
function fixture(body) {
  const requests = [];
  const api = new OnesApi(config, { get: async () => { throw new Error('Environment must take precedence'); } }, async (url, options) => {
    requests.push({ url, options });
    return Response.json(typeof body === 'function' ? body(url) : body);
  });
  return { api, requests };
}
const success = (data) => ({ result: 'SUCCESS', data });

test('identity uses the root introspection endpoint and returns only identity, scopes and expiry', async () => {
  const { api, requests } = fixture({ active: true, sub: 'u1', org_id: 'org1', scope: 'read:account:teams,read:project:issue read:account:teams', exp: 2_000_000_000,
    access_token: KEY, api_key: 'unrelated-hidden-key', extra: 'must-not-escape' });
  const result = await api.getCurrentUser();
  assert.deepEqual(result, { active: true, userID: 'u1', organizationID: 'org1', scopes: ['read:account:teams', 'read:project:issue'], expiresAt: 2_000_000_000 });
  assert.equal(requests[0].url.href, 'https://sz.ones.cn/oauth2/introspect');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('inactive introspection never invents user identity or scopes', async () => {
  assert.deepEqual(await fixture({ active: false }).api.getCurrentUser(), { active: false, scopes: [] });
  await assert.rejects(fixture({ sub: 'u1' }).api.getCurrentUser(), { code: 'INVALID_RESPONSE' });
});

test('teams require no team ID and preserve team information without inventing pagination', async () => {
  const { api, requests } = fixture(success({ teams: [{ id: 'team1', name: 'Team', status: 1, owner: 'u1' }] }));
  assert.deepEqual(await api.listTeams(), { teams: [{ id: 'team1', name: 'Team', status: 1, owner: 'u1' }] });
  assert.equal(requests[0].url.href, 'https://sz.ones.cn/openapi/v2/account/teams');
  assert.deepEqual(await fixture(success({ teams: [] })).api.listTeams(), { teams: [] });
  await assert.rejects(fixture(success({})).api.listTeams(), { code: 'INVALID_RESPONSE' });
});

test('user search accepts documented data-only envelopes, safely encodes keywords and paginates', async () => {
  const { api, requests } = fixture({ data: page([{ id: 'u1', name: 'User', status: 'normal' }], true) });
  const first = await api.searchUsers({ teamID: 'team1', keyword: '张 + user@example.com' });
  await api.searchUsers({ teamID: 'team1', keyword: '张 + user@example.com', cursor: first.pageInfo.endCursor });
  assert.equal(requests[0].url.pathname, '/openapi/v2/account/users/search');
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), { teamID: 'team1', limit: '50', keyword: '张 + user@example.com' });
  assert.equal(requests[1].url.searchParams.get('cursor'), 'next+/=');
  assert.equal(first.pageInfo.totalCount, 20);
});

test('issue types preserve server roles and project metadata and send only documented parameters', async () => {
  const { api, requests } = fixture(success(page([{ id: 'type1', name: 'Custom defect', testRole: 'none', project: { id: 'p1', name: 'Project' } }])));
  const result = await api.listIssueTypes({ teamID: 'team1', projectID: 'ignored', limit: 1 });
  assert.equal(result.list[0].testRole, 'none');
  assert.equal(result.list[0].project.id, 'p1');
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), { teamID: 'team1' });
  assert.equal(requests[0].url.pathname, '/openapi/v2/project/issueTypes');
});

test('field search uses the complete catalog and preserves metadata and pagination', async () => {
  const fields = [{ id: 'customField1', name: 'Custom', required: false, readonly: true, fieldType: 'cascade_single_option', canBeFilter: true, setting: { selectable_level: 'leaf' } }];
  const { api, requests } = fixture(success(page(fields, true)));
  const result = await api.searchIssueFields({ teamID: 'team1', keyword: '属性 & 地区' });
  assert.equal(requests[0].url.pathname, '/openapi/v2/project/searchIssueFields');
  assert.equal(requests[0].url.searchParams.get('limit'), '500');
  assert.equal(requests[0].url.searchParams.get('keyword'), '属性 & 地区');
  assert.deepEqual(result.list, fields);
  await api.searchIssueFields({ teamID: 'team1', keyword: '属性 & 地区', cursor: result.pageInfo.endCursor, limit: 1 });
  assert.equal(requests[1].url.searchParams.get('cursor'), 'next+/=');
  assert.equal(result.pageInfo.totalCount, 20);
});

test('detail form lookup uses the documented read-only POST and maps project/type IDs exactly', async () => {
  const fields = [{ id: 'customDesc1', name: 'Description', required: true, readonly: false, fieldType: 'desc' }];
  const { api, requests } = fixture(success(fields));
  assert.deepEqual(await api.getIssueFormFields({ teamID: 'team1', projectID: 'p1', issueTypeIDs: ['type1', 'type2'] }), { fields });
  assert.equal(requests[0].url.pathname, '/openapi/v2/project/issueFormFields');
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), { teamID: 'team1' });
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].options.body), { project_uuid: 'p1', issue_type_uuids: ['type1', 'type2'] });
  await api.getIssueFormFields({ teamID: 'team1', projectID: 'p1' });
  assert.deepEqual(JSON.parse(requests[1].options.body), { project_uuid: 'p1' });
});

test('empty form results stay empty and do not fall back to fixed field IDs', async () => {
  const { api, requests } = fixture(success([]));
  assert.deepEqual(await api.getIssueFormFields({ teamID: 'team1', projectID: 'p1', issueTypeIDs: [] }), { fields: [] });
  assert.deepEqual(JSON.parse(requests[0].options.body).issue_type_uuids, []);
  await assert.rejects(fixture(success({ list: [] })).api.getIssueFormFields({ teamID: 'team1', projectID: 'p1' }), { code: 'INVALID_RESPONSE' });
});

test('invalid metadata parameters are rejected before networking', async () => {
  const { api, requests } = fixture({});
  assert.throws(() => api.searchIssueFields({ teamID: 'team1', limit: 501 }));
  assert.throws(() => api.searchUsers({ teamID: 'team1', keyword: 'x'.repeat(257) }));
  await assert.rejects(api.getIssueFormFields({ teamID: 'team1', projectID: '../p1' }));
  await assert.rejects(api.getIssueFormFields({ teamID: 'team1', projectID: 'p1', issueTypeIDs: Array(101).fill('type1') }));
  assert.equal(requests.length, 0);
});

test('all metadata tools execute through MCP with structured output and advertise read-only behavior', async () => {
  const { api } = fixture((url) => {
    if (url.pathname === '/oauth2/introspect') return { active: true, sub: 'u1', scope: 'read:account:teams' };
    if (url.pathname.endsWith('/teams')) return success({ teams: [{ id: 'team1', name: 'Team' }] });
    if (url.pathname.endsWith('/issueFormFields')) return success([{ id: 'custom1', name: 'Custom', required: false }]);
    return success(page([{ id: 'item1', name: 'Item' }]));
  });
  const server = createServer({}, api);
  const client = new Client({ name: 'metadata-test', version: '1.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const calls = [
    ['ones_get_current_user', {}, (data) => assert.equal(data.userID, 'u1')],
    ['ones_list_teams', {}, (data) => assert.equal(data.teams[0].id, 'team1')],
    ['ones_search_users', { teamID: 'team1' }, (data) => assert.equal(data.list[0].id, 'item1')],
    ['ones_list_issue_types', { teamID: 'team1' }, (data) => assert.equal(data.list[0].id, 'item1')],
    ['ones_search_issue_fields', { teamID: 'team1' }, (data) => assert.equal(data.list[0].id, 'item1')],
    ['ones_get_issue_form_fields', { teamID: 'team1', projectID: 'p1' }, (data) => assert.equal(data.fields[0].id, 'custom1')],
  ];
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(client.getServerVersion().version, manifest.version);
    const tools = (await client.listTools()).tools;
    for (const [name, args, check] of calls) {
      const tool = tools.find((tool) => tool.name === name);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, name);
      check(result.structuredContent);
      assert.ok(!JSON.stringify(result).includes(KEY));
    }
  } finally { await client.close(); await server.close(); }
});

test('a remote metadata permission failure remains an MCP error without echoing credentials', async () => {
  const { api } = fixture({ result: 'FAIL', errorCode: 'Forbidden', errorMsg: KEY });
  const server = createServer({}, api);
  const client = new Client({ name: 'permission-test', version: '1.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({ name: 'ones_list_teams', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, 'FORBIDDEN');
    assert.ok(!JSON.stringify(result).includes(KEY));
  } finally { await client.close(); await server.close(); }
});
