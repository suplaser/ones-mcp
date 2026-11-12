import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuthCoordinator } from '../dist/auth.js';
import { normalizeApiKey, PERSONAL_API_KEYS_URL, readConfig } from '../dist/config.js';
import { buildWindowsLoginCommand } from '../dist/desktop.js';
import { createServer } from '../dist/server.js';
import { OnesApi } from '../dist/api.js';
import { FileSetupLock } from '../dist/setup-lock.js';

const SENTINEL = 'synthetic-test-key-never-a-real-credential';

function fixture({ saved = null, environment, browserFails = false, terminalFails = false } = {}) {
  const calls = { browser: [], terminal: 0, releases: 0, locks: 0, storeReads: 0, logs: [] };
  const state = { saved };
  const store = {
    get: async () => { calls.storeReads++; return state.saved; },
    set: async (key) => { state.saved = key; },
  };
  const desktop = {
    openBrowser: async (url) => { calls.browser.push(url); if (browserFails) throw new Error(SENTINEL); },
    openLoginTerminal: async () => { calls.terminal++; if (terminalFails) throw new Error(SENTINEL); return 123; },
  };
  const lock = { acquire: async () => {
    calls.locks++;
    return { handoff: async () => {}, release: async () => { calls.releases++; } };
  } };
  const config = { origin: 'https://ones.cn', environmentApiKey: environment };
  return { auth: new AuthCoordinator(config, store, desktop, lock, (message) => calls.logs.push(message)), calls, state };
}

test('missing key opens exactly one browser and terminal, then sees a newly saved key', async () => {
  const { auth, calls, state } = fixture();
  await Promise.all([auth.ensureSetup(), auth.ensureSetup(), auth.ensureSetup()]);
  assert.deepEqual(calls.browser, [PERSONAL_API_KEYS_URL]);
  assert.equal(calls.terminal, 1);
  assert.equal((await auth.status()).setup, 'waiting-for-input');
  state.saved = SENTINEL;
  const status = await auth.status();
  assert.equal(status.configured, true);
  assert.equal(status.source, 'system-keychain');
  assert.equal(status.setup, 'not-needed');
  assert.equal(status.verified, false);
  assert.ok(!JSON.stringify(status).includes(SENTINEL));
});

test('saved key skips onboarding', async () => {
  const { auth, calls } = fixture({ saved: SENTINEL });
  await auth.ensureSetup();
  assert.equal(calls.terminal, 0);
  assert.equal(calls.locks, 0);
  assert.equal((await auth.status()).configured, true);
});

test('environment key avoids keychain reads and onboarding', async () => {
  const { auth, calls } = fixture({ environment: SENTINEL });
  await auth.ensureSetup();
  assert.equal((await auth.status()).source, 'environment');
  assert.equal(calls.storeReads, 0);
  assert.equal(calls.terminal, 0);
});

test('terminal failure releases the setup lease and never logs exception contents', async () => {
  const { auth, calls } = fixture({ terminalFails: true });
  await auth.ensureSetup();
  assert.equal(calls.releases, 1);
  assert.equal((await auth.status()).setup, 'manual-required');
  assert.equal(calls.browser.length, 0);
  assert.ok(!calls.logs.join('').includes(SENTINEL));
});

test('browser failure keeps the separate input terminal available', async () => {
  const { auth, calls } = fixture({ browserFails: true });
  await auth.ensureSetup();
  assert.equal(calls.terminal, 1);
  assert.equal(calls.releases, 0);
  assert.equal((await auth.status()).setup, 'waiting-for-input');
  assert.ok(!calls.logs.join('').includes(SENTINEL));
});

test('MCP tool discovery and calls return status without key material', async () => {
  const { auth } = fixture({ saved: SENTINEL });
  const server = createServer(auth, new OnesApi(readConfig({ ONES_API_KEY: SENTINEL }), { get: async () => null }));
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [
      'ones_auth_status', 'ones_list_projects', 'ones_get_project', 'ones_list_issues', 'ones_get_issue',
      'ones_get_current_user', 'ones_list_teams', 'ones_search_users', 'ones_list_issue_types',
      'ones_search_issue_fields', 'ones_get_issue_form_fields',
      'ones_get_field_options', 'ones_list_issue_statuses', 'ones_list_issue_workflows',
      'ones_list_issue_comments', 'ones_list_issue_worklogs', 'ones_get_issue_worklog',
      'ones_search_issues', 'ones_get_daily_hours',
      'ones_create_issue', 'ones_update_issue', 'ones_execute_issue_workflow', 'ones_add_issue_worklog',
      'ones_send_issue_comment', 'ones_update_issue_comment', 'ones_delete_issue_comment', 'ones_update_issue_worklog',
      'ones_delete_issue_worklog', 'ones_set_issue_estimated_hours', 'ones_set_issue_remaining_hours',
    ]);
    const result = await client.callTool({ name: 'ones_auth_status', arguments: {} });
    assert.equal(result.structuredContent.configured, true);
    assert.ok(!JSON.stringify(result).includes(SENTINEL));
  } finally { await client.close(); await server.close(); }
});

test('real stdio server initializes and answers tools/list with no stdout contamination', { timeout: 15_000 }, async () => {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/index.js')],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), ONES_API_KEY: SENTINEL },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 30);
    const result = await client.callTool({ name: 'ones_auth_status', arguments: {} });
    assert.equal(result.structuredContent.source, 'environment');
    assert.ok(!JSON.stringify(result).includes(SENTINEL));
  } finally { await client.close(); }
  assert.ok(!stderr.includes(SENTINEL));
});

test('concurrent instances coordinate setup through a guarded lease and recover dead owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'onces-mcp-lock-test-'));
  try {
    const locks = [new FileSetupLock('https://ones.cn', directory), new FileSetupLock('https://ones.cn', directory)];
    const leases = await Promise.all(locks.map((lock) => lock.acquire()));
    assert.equal(leases.filter(Boolean).length, 1);
    await leases.find(Boolean).release();
    const lease = await locks[0].acquire();
    assert.ok(lease);
    await lease.release();
    const record = (await readdir(directory)).find((name) => name.endsWith('.lock'));
    assert.equal(record, undefined);
    // A known exited child PID would be reusable; use an impossible signed OS PID instead.
    const staleName = `setup-${(await import('node:crypto')).createHash('sha256').update('https://ones.cn').digest('hex').slice(0, 16)}.lock`;
    await writeFile(join(directory, staleName), JSON.stringify({ id: randomUUID(), pid: 2_147_483_647 }));
    const recovered = await locks[0].acquire();
    assert.ok(recovered);
    await recovered.release();
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows terminal command preserves spaces and escapes PowerShell quotes', () => {
  const command = buildWindowsLoginCommand("C:\\Program Files\\Node's\\node.exe", "E:\\source's directory\\index.js");
  assert.ok(command.includes("& 'C:\\Program Files\\Node''s\\node.exe' 'E:\\source''s directory\\index.js' auth login --no-browser"));
  assert.ok(!command.includes(SENTINEL));
});

test('key input rejects empty, multiline, and authorization header values', () => {
  for (const value of ['', '   ', 'first\nsecond', 'Bearer abc', 'abc def']) {
    assert.throws(() => normalizeApiKey(value));
  }
  assert.equal(normalizeApiKey(`  ${SENTINEL}  `), SENTINEL);
  assert.throws(() => readConfig({ ONES_BASE_URL: 'https://user:password@example.com' }));
  assert.throws(() => readConfig({ ONES_BASE_URL: 'http://example.com' }));
});

test('Windows system credential adapter saves and reads an isolated synthetic key', {
  skip: process.platform !== 'win32',
}, async () => {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const { SystemCredentialStore } = await import('../dist/credentials.js');
  const origin = `https://test-${randomUUID()}.invalid`;
  const store = new SystemCredentialStore(origin);
  const entry = new AsyncEntry('ones-mcp.personal-api-key', origin);
  try {
    assert.equal(await store.get(), null);
    await store.set(SENTINEL);
    assert.equal(await store.get(), SENTINEL);
  } finally {
    await entry.deleteCredential();
  }
});
