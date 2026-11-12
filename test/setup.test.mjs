import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { lock } from 'proper-lockfile';
import { CLIENT_IDS, clientID, resolveClients } from '../dist/setup/clients.js';
import { at, parseDocument, serversPath } from '../dist/setup/document.js';
import { currentLaunch, planSetup, applySetup } from '../dist/setup/install.js';
import { parseSetupArgs } from '../dist/setup/cli.js';

const SENTINEL = 'synthetic-setup-key-must-not-be-written';
const launch = currentLaunch({ ONES_API_KEY: SENTINEL });
const templates = {
  codex: { format: 'toml', dialect: 'codex' },
  'claude-code': { format: 'json', dialect: 'standard' },
  cursor: { format: 'json', dialect: 'standard' },
  gemini: { format: 'json', dialect: 'standard' },
  vscode: { format: 'jsonc', dialect: 'vscode' },
  windsurf: { format: 'json', dialect: 'standard' },
  opencode: { format: 'jsonc', dialect: 'opencode' },
};
async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'onces-setup-test-'));
  try { return await fn(dir); }
  finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    await rm(dir, { recursive: true, force: true });
  }
}
const client = (dir, id = 'cursor') => ({ id, label: id, path: join(dir, id, id === 'codex' ? 'config.toml' : 'config.json'), marker: join(dir, id), detected: false, ...templates[id] });
async function seed(target, text) { await mkdir(dirname(target.path), { recursive: true }); await writeFile(target.path, text); }
const entry = (text, target) => { const doc = parseDocument(text, target); return at(doc, [...serversPath(doc, target), 'ones']); };
async function cli(args, env = {}) {
  const child = spawn(process.execPath, [resolve('dist/index.js'), 'setup', ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  return { code, stdout, stderr };
}

test('current installation is registered with absolute paths and never captures the API key', () => {
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.args[0], resolve('dist/index.js'));
  assert.deepEqual(launch.environment, {});
  assert.ok(!JSON.stringify(launch).includes(SENTINEL));
  assert.deepEqual(currentLaunch({ ONES_BASE_URL: 'https://example.com/', ONES_API_BASE_URL: 'https://api.example.com' }).environment,
    { ONES_BASE_URL: 'https://example.com', ONES_API_BASE_URL: 'https://api.example.com' });
  assert.throws(() => currentLaunch({ ONES_BASE_URL: 'https://user:password@example.com' }));
});

test('client discovery respects native Windows and macOS paths and documented overrides', async () => {
  const windows = await resolveClients({ home: 'C:\\Users\\Example', platform: 'win32', env: {} });
  assert.equal(windows.find((c) => c.id === 'codex').path, 'C:\\Users\\Example\\.codex\\config.toml');
  assert.equal(windows.find((c) => c.id === 'vscode').path, 'C:\\Users\\Example\\AppData\\Roaming\\Code\\User\\mcp.json');
  assert.equal(windows.find((c) => c.id === 'claude-code').path, 'C:\\Users\\Example\\.claude.json');
  const mac = await resolveClients({ home: '/Users/example', platform: 'darwin', env: {} });
  assert.equal(mac.find((c) => c.id === 'vscode').path, '/Users/example/Library/Application Support/Code/User/mcp.json');
  const custom = await resolveClients({ home: '/home/example', platform: 'linux', env: {
    CODEX_HOME: '/custom/codex', CLAUDE_CONFIG_DIR: '/custom/claude', GEMINI_CLI_HOME: '/custom/gemini',
    VSCODE_PORTABLE: '/custom/code', XDG_CONFIG_HOME: '/custom/xdg', OPENCODE_CONFIG: '/custom/oc.jsonc',
  } });
  assert.equal(custom.find((c) => c.id === 'codex').path, '/custom/codex/config.toml');
  assert.equal(custom.find((c) => c.id === 'claude-code').path, '/custom/claude/.claude.json');
  assert.equal(custom.find((c) => c.id === 'gemini').path, '/custom/gemini/.gemini/settings.json');
  assert.equal(custom.find((c) => c.id === 'vscode').path, '/custom/code/user-data/User/mcp.json');
  assert.equal(custom.find((c) => c.id === 'opencode').path, '/custom/oc.jsonc');
});

test('discovery prefers the existing OpenCode JSONC file and distinguishes config-directory detection', async () => temporary(async (dir) => {
  await mkdir(join(dir, '.config', 'opencode'), { recursive: true });
  await writeFile(join(dir, '.config', 'opencode', 'opencode.jsonc'), '{}');
  const clients = await resolveClients({ home: dir, platform: process.platform, env: {} });
  const target = clients.find((c) => c.id === 'opencode');
  assert.equal(target.path, join(dir, '.config', 'opencode', 'opencode.jsonc'));
  assert.equal(target.detected, true);
  assert.equal(clients.find((c) => c.id === 'cursor').detected, false);
}));

test('fresh setup covers every supported client and rerunning is a byte-identical no-op', async () => temporary(async (dir) => {
  for (const id of CLIENT_IDS) {
    const target = client(dir, id);
    const plan = await planSetup(target, launch);
    assert.equal(plan.status, 'add');
    assert.ok(!plan.updated.includes(SENTINEL));
    const result = await applySetup(plan);
    assert.equal(result.status, 'configured');
    assert.equal(result.backup, undefined);
    const text = await readFile(target.path, 'utf8');
    const registered = entry(text, target);
    if (id === 'opencode') { assert.deepEqual(registered.command, [launch.command, ...launch.args]); assert.equal(registered.type, 'local'); }
    else { assert.equal(registered.command, launch.command); assert.deepEqual(registered.args, launch.args); }
    if (id === 'vscode') assert.equal(registered.type, 'stdio');
    const repeat = await planSetup(target, launch);
    assert.equal(repeat.status, 'unchanged');
    await applySetup(repeat);
    assert.equal(await readFile(target.path, 'utf8'), text);
    assert.ok(!(await readdir(dirname(target.path))).some((name) => name.endsWith('.bak') || name.endsWith('.lock')));
  }
}));

test('JSON merge preserves unrelated providers, HTTP authentication, settings and project scopes', async () => temporary(async (dir) => {
  const target = client(dir, 'claude-code');
  const source = { preferences: { theme: 'dark' }, mcpServers: { ONES: { type: 'http', url: 'https://sz.ones.cn/mcp', headers: { Authorization: 'Bearer synthetic-other-key' } } },
    projects: { '/repo': { allowedTools: [] } } };
  await seed(target, JSON.stringify(source, null, 4));
  const plan = await planSetup(target, launch);
  const result = await applySetup(plan);
  assert.equal(await readFile(result.backup, 'utf8'), JSON.stringify(source, null, 4));
  const actual = JSON.parse(await readFile(target.path, 'utf8'));
  delete actual.mcpServers.ones;
  assert.deepEqual(actual, source);
}));

test('JSONC edits retain BOM, comments, trailing commas and unrelated text', async () => temporary(async (dir) => {
  const target = client(dir, 'vscode');
  const text = '\uFEFF{\r\n  // keep this provider\r\n  "servers": { "other": {"command":"other"}, },\r\n  "inputs": [], // keep inputs\r\n}\r\n';
  await seed(target, text);
  const plan = await planSetup(target, launch);
  assert.ok(plan.updated.startsWith('\uFEFF'));
  assert.ok(plan.updated.includes('// keep this provider'));
  assert.ok(plan.updated.includes('// keep inputs'));
  assert.deepEqual(parseDocument(plan.updated, target).inputs, []);
  assert.equal(parseDocument(plan.updated, target).servers.other.command, 'other');
  assert.equal(entry(plan.updated, target).type, 'stdio');
  await applySetup(plan);
}));

test('TOML AST patches handle comments, quoted tables, multiline strings, inline maps and dotted assignments', async () => temporary(async (dir) => {
  const target = client(dir, 'codex');
  const sources = [
    '# settings\nmodel="example"\n[mcp_servers.other]\ncommand="other" # keep\n',
    'mcp_servers = { other = { command = "other" } } # inline\n',
    '[mcp_servers]\nother.command="other"\n',
    'note = """\n[mcp_servers.fake]\ncommand="fake"\n"""\n[mcp_servers.other]\ncommand="other"\n',
    '\uFEFF# quoted\r\n["mcp_servers"."other"]\r\ncommand="other"\r\n',
  ];
  for (const source of sources) {
    await seed(target, source);
    const before = parseDocument(source, target);
    const plan = await planSetup(target, launch);
    const actual = parseDocument(plan.updated, target);
    assert.deepEqual(actual.mcp_servers.other, before.mcp_servers.other);
    assert.equal(actual.note, before.note);
    assert.equal(actual.mcp_servers.ones.command, launch.command);
    assert.ok(plan.updated.includes(source.startsWith('\uFEFF') ? '# quoted' : source.includes('#') ? source.match(/#[^\r\n]*/)[0] : 'other'));
    await applySetup(plan);
    assert.equal((await planSetup(target, launch)).status, 'unchanged');
  }
}));

test('existing ONES aliases are reused and caller tool restrictions, environment and disabled state survive updates', async () => temporary(async (dir) => {
  for (const id of ['codex', 'cursor', 'opencode']) {
    const target = client(dir, id);
    const old = id === 'opencode' ? { type: 'local', command: ['npx', '-y', '@suplaser/onces-mcp@0.1.0'], enabled: false, environment: { KEEP: 'yes' } }
      : { command: 'npx', args: ['-y', '@suplaser/onces-mcp@0.1.0'], enabled: false, env: { KEEP: 'yes' }, disabled_tools: ['ones_get_issue'] };
    const text = id === 'codex' ? '[mcp_servers."my-ones"]\ncommand="npx" # keep launcher comment\nargs=["-y","@suplaser/onces-mcp@0.1.0"]\nenabled=false\ndisabled_tools=["ones_get_issue"]\n[mcp_servers."my-ones".env]\nKEEP="yes"\n'
      : JSON.stringify({ [id === 'opencode' ? 'mcp' : 'mcpServers']: { 'my-ones': old } });
    await seed(target, text);
    const plan = await planSetup(target, launch);
    assert.equal(plan.serverName, 'my-ones');
    const doc = parseDocument(plan.updated, target);
    const table = at(doc, serversPath(doc, target));
    assert.deepEqual(Object.keys(table), ['my-ones']);
    assert.equal(table['my-ones'].enabled, false);
    assert.deepEqual(table['my-ones'][id === 'opencode' ? 'environment' : 'env'], { KEEP: 'yes' });
    if (id !== 'opencode') assert.deepEqual(table['my-ones'].disabled_tools, ['ones_get_issue']);
    if (id === 'codex') assert.ok(plan.updated.includes('# keep launcher comment'));
  }
}));

test('OpenCode native mcp.servers dialect preserves global controls and uses native disable defaults', async () => temporary(async (dir) => {
  const target = client(dir, 'opencode');
  await seed(target, '{"mcp":{"enabled":false,"servers":{"other":{"type":"local","command":["other"]}}}}');
  const plan = await planSetup(target, launch);
  const doc = parseDocument(plan.updated, target);
  assert.equal(doc.mcp.enabled, false);
  assert.equal(doc.mcp.servers.ones.disabled, false);
  assert.equal(doc.mcp.servers.other.command[0], 'other');
}));

test('custom ONES origins merge into existing TOML environment tables without losing comments or values', async () => temporary(async (dir) => {
  const target = client(dir, 'codex');
  const source = '# keep settings\n[mcp_servers.ones]\ncommand="npx"\nargs=["@suplaser/onces-mcp"]\n[mcp_servers.ones.env]\nKEEP="yes" # keep this comment\nONES_BASE_URL="https://old.example.com"\n';
  await seed(target, source);
  const custom = currentLaunch({ ONES_BASE_URL: 'https://ones.example.com', ONES_API_BASE_URL: 'https://api.example.com', ONES_API_KEY: SENTINEL });
  const plan = await planSetup(target, custom);
  assert.deepEqual(entry(plan.updated, target).env, { KEEP: 'yes', ONES_BASE_URL: 'https://ones.example.com', ONES_API_BASE_URL: 'https://api.example.com' });
  assert.ok(plan.updated.includes('# keep this comment'));
  assert.ok(!plan.updated.includes(SENTINEL));
  await applySetup(plan);
  assert.equal((await planSetup(target, custom)).status, 'unchanged');
}));

test('empty and comments-only documents can be configured without discarding their preamble', async () => temporary(async (dir) => {
  for (const id of ['codex', 'vscode', 'cursor']) {
    const target = client(dir, id);
    const text = id === 'codex' ? '# keep preamble\n' : id === 'vscode' ? '// keep preamble\n' : '\uFEFF\n';
    await seed(target, text);
    const plan = await planSetup(target, launch);
    if (id !== 'cursor') assert.ok(plan.updated.includes('keep preamble'));
    else assert.ok(plan.updated.startsWith('\uFEFF'));
    await applySetup(plan);
    assert.equal((await planSetup(target, launch)).status, 'unchanged');
  }
}));

test('malformed documents, duplicate keys, non-object tables and name collisions are never overwritten', async () => temporary(async (dir) => {
  const target = client(dir);
  for (const source of ['{bad', '[]', '{"mcpServers":null}', '{"mcpServers":{},"mcpServers":{}}',
    '{"mcpServers":{"ones":{"command":"other","args":[]}}}',
    '{"mcpServers":{"a":{"command":"npx","args":["@suplaser/onces-mcp"]},"b":{"command":"npx","args":["@suplaser/onces-mcp"]}}}']) {
    await seed(target, source);
    await assert.rejects(planSetup(target, launch));
    assert.equal(await readFile(target.path, 'utf8'), source);
    assert.deepEqual(await readdir(dirname(target.path)), ['config.json']);
  }
  const toml = client(dir, 'codex');
  await seed(toml, 'model="x"\nmodel="y"');
  await assert.rejects(planSetup(toml, launch));
}));

test('changing a config after preview aborts instead of losing concurrent edits', async () => temporary(async (dir) => {
  const target = client(dir);
  await seed(target, '{}');
  const plan = await planSetup(target, launch);
  await writeFile(target.path, '{"changed":true}');
  await assert.rejects(applySetup(plan), /变化/);
  assert.equal(await readFile(target.path, 'utf8'), '{"changed":true}');
  assert.deepEqual(await readdir(dirname(target.path)), ['config.json']);
}));

test('the per-file transaction lock prevents a second setup writer', async () => temporary(async (dir) => {
  const target = client(dir);
  await seed(target, '{}');
  const plan = await planSetup(target, launch);
  const release = await lock(target.path, { realpath: false });
  try { await assert.rejects(applySetup(plan), /另一个进程/); }
  finally { await release(); }
  assert.equal(await readFile(target.path, 'utf8'), '{}');
}));

test('invalid UTF-8 and symlink targets cannot be silently rewritten', async () => temporary(async (dir) => {
  const target = client(dir);
  await mkdir(dirname(target.path));
  const bytes = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
  await writeFile(target.path, bytes);
  await assert.rejects(planSetup(target, launch), /UTF-8/);
  assert.deepEqual(await readFile(target.path), bytes);
  if (process.platform !== 'win32') {
    const link = { ...target, path: join(dir, 'link.json') };
    await symlink(target.path, link.path);
    await assert.rejects(planSetup(link, launch), /普通文件/);
  }
}));

test('Unix permission bits survive updates and backups are private', { skip: process.platform === 'win32' }, async () => temporary(async (dir) => {
  const target = client(dir);
  await seed(target, '{}');
  await chmod(target.path, 0o666);
  const result = await applySetup(await planSetup(target, launch));
  assert.equal((await stat(target.path)).mode & 0o777, 0o666);
  assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
}));

test('CLI options accept multiple clients and REA-style aliases while requiring explicit automation targets', () => {
  assert.deepEqual(parseSetupArgs(['--client', 'codex,claude_code', '--client', 'cursor', '--yes']).clients, ['codex', 'claude-code', 'cursor']);
  assert.equal(clientID('gemini_cli'), 'gemini');
  for (const args of [['--yes'], ['--all', '--client', 'codex'], ['--client', 'unknown'], ['--config', 'x.json'], ['--client'], ['--name', 'invalid.name']]) assert.throws(() => parseSetupArgs(args));
});

test('real CLI dry-run is noninteractive, needs no API key and creates no config or backup', async () => temporary(async (dir) => {
  const path = join(dir, 'absent', 'config.toml');
  const result = await cli(['--client', 'codex', '--config', path, '--dry-run'], { ONES_API_KEY: SENTINEL });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /仅预览/);
  assert.ok(!result.stderr.includes(SENTINEL));
  assert.deepEqual(await readdir(dir), []);
}));

test('real CLI installs, backs up once, is repeatable, and leaves other services intact', async () => temporary(async (dir) => {
  const target = client(dir, 'vscode');
  const original = '{// keep\n"servers":{"other":{"command":"other"}}}';
  await seed(target, original);
  const args = ['--client', 'vscode', '--config', target.path, '--yes'];
  const result = await cli(args, { ONES_API_KEY: SENTINEL });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
  assert.equal(parseDocument(await readFile(target.path, 'utf8'), target).servers.other.command, 'other');
  const files = await readdir(dirname(target.path));
  assert.equal(files.filter((name) => name.endsWith('.bak')).length, 1);
  assert.equal((await cli(args)).code, 0);
  assert.deepEqual(await readdir(dirname(target.path)), files);
}));

test('real CLI help and noninteractive confirmation do not read credentials or write configs', async () => temporary(async (dir) => {
  const help = await cli(['--help'], { ONES_BASE_URL: 'not-a-valid-url', ONES_API_KEY: SENTINEL });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--dry-run/);
  const target = join(dir, 'config.json');
  const denied = await cli(['--client', 'cursor', '--config', target], { ONES_API_KEY: SENTINEL });
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /--yes/);
  assert.deepEqual(await readdir(dir), []);
  assert.ok(!denied.stderr.includes(SENTINEL));
}));
