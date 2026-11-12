import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { access } from 'node:fs/promises';
import { SetupError } from './error.js';

export const CLIENT_IDS = ['codex', 'claude-code', 'cursor', 'gemini', 'vscode', 'windsurf', 'opencode'] as const;
export type ClientID = typeof CLIENT_IDS[number];
export interface SetupClient {
  id: ClientID;
  label: string;
  path: string;
  marker: string;
  format: 'json' | 'jsonc' | 'toml';
  dialect: 'standard' | 'vscode' | 'opencode' | 'codex';
  detected: boolean;
}
export interface ClientContext { home: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv }

export function clientID(value: string): ClientID {
  const name = value.toLowerCase().replaceAll('_', '-');
  const id = name === 'gemini-cli' ? 'gemini' : name;
  if (!CLIENT_IDS.includes(id as ClientID)) throw new SetupError(`不支持该客户端。可选：${CLIENT_IDS.join(', ')}。`);
  return id as ClientID;
}

export async function resolveClients(context: ClientContext = { home: homedir(), platform: process.platform, env: process.env }): Promise<SetupClient[]> {
  const { home, platform, env } = context;
  const p = platform === 'win32' ? win32 : posix;
  const absolute = (value: string) => {
    if (!p.isAbsolute(value)) throw new SetupError('客户端配置目录环境变量必须使用绝对路径。');
    return p.normalize(value);
  };
  const xdg = absolute(env.XDG_CONFIG_HOME || p.join(home, '.config'));
  const roaming = absolute(env.APPDATA || p.join(home, 'AppData', 'Roaming'));
  const codex = absolute(env.CODEX_HOME || p.join(home, '.codex'));
  const claude = absolute(env.CLAUDE_CONFIG_DIR || home);
  const gemini = absolute(env.GEMINI_CLI_HOME || home);
  const code = env.VSCODE_PORTABLE ? p.join(absolute(env.VSCODE_PORTABLE), 'user-data')
    : env.VSCODE_APPDATA ? p.join(absolute(env.VSCODE_APPDATA), 'Code')
    : platform === 'win32' ? p.join(roaming, 'Code')
    : platform === 'darwin' ? p.join(home, 'Library', 'Application Support', 'Code') : p.join(xdg, 'Code');
  const opencode = absolute(env.OPENCODE_CONFIG_DIR || p.join(xdg, 'opencode'));
  const exists = async (path: string) => {
    try { await access(path); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new SetupError('无法检查客户端配置目录，请检查目录权限。');
    }
  };
  const ocJsonc = p.join(opencode, 'opencode.jsonc');
  // An explicit file override takes precedence. Otherwise retain an existing
  // JSONC file rather than creating a second file that could shadow it.
  const ocFile = env.OPENCODE_CONFIG ? absolute(env.OPENCODE_CONFIG)
    : await exists(ocJsonc) ? ocJsonc : p.join(opencode, 'opencode.json');
  const definitions: Omit<SetupClient, 'detected'>[] = [
    { id: 'codex', label: 'Codex', path: p.join(codex, 'config.toml'), marker: codex, format: 'toml', dialect: 'codex' },
    { id: 'claude-code', label: 'Claude Code', path: p.join(claude, '.claude.json'), marker: env.CLAUDE_CONFIG_DIR ? claude : p.join(home, '.claude'), format: 'json', dialect: 'standard' },
    { id: 'cursor', label: 'Cursor', path: p.join(home, '.cursor', 'mcp.json'), marker: p.join(home, '.cursor'), format: 'json', dialect: 'standard' },
    { id: 'gemini', label: 'Gemini CLI', path: p.join(gemini, '.gemini', 'settings.json'), marker: p.join(gemini, '.gemini'), format: 'json', dialect: 'standard' },
    { id: 'vscode', label: 'VS Code', path: p.join(code, 'User', 'mcp.json'), marker: code, format: 'jsonc', dialect: 'vscode' },
    { id: 'windsurf', label: 'Windsurf', path: p.join(home, '.codeium', 'windsurf', 'mcp_config.json'), marker: p.join(home, '.codeium', 'windsurf'), format: 'json', dialect: 'standard' },
    { id: 'opencode', label: 'OpenCode', path: ocFile, marker: opencode, format: ocFile.endsWith('.jsonc') ? 'jsonc' : 'json', dialect: 'opencode' },
  ];
  return Promise.all(definitions.map(async (client) => ({ ...client, detected: await exists(client.path) || await exists(client.marker) })));
}
