import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { lock } from 'proper-lockfile';
import type { SetupClient } from './clients.js';
import { at, object, parseDocument, patchEntry, serversPath } from './document.js';
import { SetupError } from './error.js';

export interface Launch { command: string; args: string[]; environment: Record<string, string> }
interface Snapshot { text: string | null; mode: number }
export interface SetupPlan {
  client: SetupClient; serverName: string; status: 'add' | 'update' | 'unchanged';
  /** Internal snapshots must never be logged: existing configurations may contain secrets. */
  original: Snapshot; updated: string;
}
export interface SetupResult { client: SetupClient; serverName: string; status: 'configured' | 'unchanged'; backup?: string }

export function currentLaunch(env: NodeJS.ProcessEnv = process.env): Launch {
  const environment: Record<string, string> = {};
  for (const name of ['ONES_BASE_URL', 'ONES_API_BASE_URL']) {
    const value = env[name];
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.hash || url.search) throw new Error();
      environment[name] = url.origin;
    } catch { throw new SetupError('ONES_BASE_URL 和 ONES_API_BASE_URL 必须是无用户名、密码或路径的 HTTPS 站点地址。'); }
  }
  // Bind to this exact installation, including when setup was started by npx.
  // Never register an older npm release or depend on a GUI client's shell PATH.
  return { command: process.execPath, args: [fileURLToPath(new URL('../index.js', import.meta.url))], environment };
}

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SetupError('配置目标必须是普通文件。符号链接请使用 --config 指定真实文件。');
    if (stat.size > 5 * 1024 * 1024) throw new SetupError('客户端配置超过 5 MB，请手动配置。');
    const bytes = await readFile(path);
    if (!isUtf8(bytes)) throw new SetupError('客户端配置不是有效 UTF-8，原文件未修改。');
    return { text: bytes.toString('utf8'), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, mode: 0o600 };
    if (error instanceof SetupError) throw error;
    throw new SetupError('无法读取客户端配置，请检查路径和权限。');
  }
}

async function owned(value: unknown, launch: Launch): Promise<boolean> {
  if (!object(value) || ['url', 'httpUrl', 'serverUrl'].some((key) => Object.hasOwn(value, key))) return false;
  const command = Array.isArray(value.command) ? value.command[0] : value.command;
  const args: unknown = Array.isArray(value.command) ? value.command.slice(1) : value.args;
  if (typeof command !== 'string' || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return false;
  if (/^npx(?:\.cmd|\.exe)?$/i.test(basename(command))) {
    return args.length >= 1 && args.length <= 2 && args.some((arg) => /^@suplaser\/onces-mcp(?:@[^\s]+)?$/.test(arg)) &&
      args.every((arg) => arg === '-y' || arg === '--yes' || /^@suplaser\/onces-mcp(?:@[^\s]+)?$/.test(arg));
  }
  if (!/^node(?:\.exe)?$/i.test(basename(command)) || (args.length !== 1 && !(args.length === 2 && args[1] === 'serve'))) return false;
  const script = args[0];
  if (!script) return false;
  if (script === launch.args[0]) return true;
  if (!isAbsolute(script) || basename(script) !== 'index.js' || basename(dirname(script)) !== 'dist') return false;
  try {
    const manifest: unknown = JSON.parse(await readFile(join(dirname(script), '..', 'package.json'), 'utf8'));
    return object(manifest) && manifest.name === '@suplaser/onces-mcp';
  } catch { return false; }
}

export async function planSetup(client: SetupClient, launch: Launch, name = 'ones'): Promise<SetupPlan> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new SetupError('服务名称只能包含 1–64 个字母、数字、下划线或连字符。');
  const original = await snapshot(client.path);
  const source = original.text ?? '';
  const document = parseDocument(source, client);
  const path = serversPath(document, client);
  const table = at(document, path) ?? {};
  if (!object(table)) throw new SetupError('客户端 MCP 配置必须是对象；原文件未修改。');
  const ownNames: string[] = [];
  for (const [key, value] of Object.entries(table)) if (await owned(value, launch)) ownNames.push(key);
  if (ownNames.length > 1) throw new SetupError('已有多个 ONES MCP 条目，请先在客户端保留一个，再运行 setup。');
  const serverName = ownNames[0] ?? name;
  const existing = table[serverName];
  if (existing !== undefined && !await owned(existing, launch)) {
    throw new SetupError('所选服务名称已被其他 MCP 占用，未覆盖。请用 --name 指定其他名称。');
  }
  const native = client.dialect === 'opencode' && path.length > 1;
  const entry: Record<string, unknown> = client.dialect === 'opencode'
    ? { type: 'local', command: [launch.command, ...launch.args],
      ...(existing === undefined ? native ? { disabled: false } : { enabled: true } : {}) }
    : { command: launch.command, args: launch.args, ...(client.dialect === 'vscode' ? { type: 'stdio' } : {}) };
  const envKey = client.dialect === 'opencode' ? 'environment' : 'env';
  if (Object.keys(launch.environment).length) {
    const prior = object(existing) ? existing[envKey] : undefined;
    if (prior !== undefined && !object(prior)) throw new SetupError('现有 ONES 环境变量配置结构无效，未修改。');
    entry[envKey] = { ...(prior ?? {}), ...launch.environment };
  }
  const updated = patchEntry(source, client, [...path, serverName], entry);
  return { client, serverName, original, updated,
    status: updated === source ? 'unchanged' : existing === undefined ? 'add' : 'update' };
}

export async function applySetup(plan: SetupPlan): Promise<SetupResult> {
  if (plan.status === 'unchanged') return { client: plan.client, serverName: plan.serverName, status: 'unchanged' };
  const path = plan.client.path;
  let release: (() => Promise<void>) | undefined;
  let temporary: string | undefined;
  let backup: string | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { release = await lock(path, { realpath: false, retries: 0, stale: 30_000 }); }
    catch { throw new SetupError('另一个进程正在配置此客户端，请稍后重试。'); }
    const check = async () => {
      const current = await snapshot(path);
      if (current.text !== plan.original.text || current.mode !== plan.original.mode) throw new SetupError('配置在预览后已发生变化，未覆盖。请重新运行 setup。');
    };
    await check();
    if (plan.original.text !== null) {
      backup = `${path}.onces-mcp.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID().slice(0, 8)}.bak`;
      const file = await open(backup, 'wx', 0o600);
      try { await file.writeFile(plan.original.text, 'utf8'); await file.sync(); } finally { await file.close(); }
    }
    temporary = join(dirname(path), `.${basename(path)}.onces-mcp.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', plan.original.mode);
    try {
      await file.writeFile(plan.updated, 'utf8');
      // open(mode) applies the process umask; restore the existing file's bits.
      if (process.platform !== 'win32') await file.chmod(plan.original.mode);
      await file.sync();
    } finally { await file.close(); }
    await check();
    await rename(temporary, path);
    temporary = undefined;
    if (await readFile(path, 'utf8') !== plan.updated) throw new SetupError('配置写入后校验失败，请检查原文件旁的 .onces-mcp 备份。');
    return { client: plan.client, serverName: plan.serverName, status: 'configured', ...(backup ? { backup } : {}) };
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError('配置未完成，请检查文件权限；若已生成 .onces-mcp 备份，请保留该备份。');
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await release?.().catch(() => {});
  }
}
