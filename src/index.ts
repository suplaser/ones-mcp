#!/usr/bin/env node
import { confirm, password } from '@inquirer/prompts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthCoordinator } from './auth.js';
import { readConfig } from './config.js';
import { SystemCredentialStore } from './credentials.js';
import { LocalDesktop } from './desktop.js';
import { createServer } from './server.js';
import { FileSetupLock } from './setup-lock.js';
import { apiKeyPromptOptions, overwriteApiKeyPromptOptions } from './prompt.js';
import { configureApiKey } from './login.js';
import { OnesApi } from './api.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = readConfig();
  const store = new SystemCredentialStore(config.origin);
  const desktop = new LocalDesktop();
  const log = (message: string) => process.stderr.write(`[ones-mcp] ${message}\n`);
  const auth = new AuthCoordinator(config, store, desktop, new FileSetupLock(config.origin), log);

  if (args[0] === 'auth' && args[1] === 'status' && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await auth.status(), null, 2)}\n`);
    return;
  }
  if (args[0] === 'auth' && args[1] === 'login' &&
      args.slice(2).every((arg) => arg === '--no-browser' || arg === '--replace')) {
    if (!process.stdin.isTTY) {
      throw new Error('请在独立的交互终端执行 ones-mcp auth login，不能在 MCP 通信管道输入 API Key。');
    }
    const context = { input: process.stdin, output: process.stderr };
    await configureApiKey(config, store, desktop, {
      confirmOverwrite: (source) => confirm({
        ...overwriteApiKeyPromptOptions,
        ...(source === 'environment' ? {
          message: '已存在 ONES_API_KEY 环境变量，是否配置新的系统凭据？（不会修改环境变量）',
        } : {}),
      }, context),
      readApiKey: () => password(apiKeyPromptOptions, context),
    }, !args.includes('--no-browser'), log);
    return;
  }
  if (args.length && !(args.length === 1 && args[0] === 'serve')) {
    throw new Error('用法：onces-mcp [serve | auth login [--no-browser] [--replace] | auth status]');
  }
  const server = createServer(auth, new OnesApi(config, store));
  await server.connect(new StdioServerTransport());
  // Complete MCP initialization without waiting for interactive key entry.
  void auth.ensureSetup().catch(() => log('自动配置未完成，请检查系统凭据库，或手动运行 ones-mcp auth login。'));
}

main().catch(() => {
  // Never echo native store errors, arguments, environment variables, or key input.
  process.stderr.write('[ones-mcp] 操作未完成。请检查命令、ONES_BASE_URL、ONES_API_BASE_URL 和系统凭据库；输入可用 Ctrl+C 取消。\n');
  process.exitCode = 1;
});
