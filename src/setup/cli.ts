import { checkbox, confirm } from '@inquirer/prompts';
import { resolve } from 'node:path';
import { CLIENT_IDS, clientID, resolveClients, type ClientID } from './clients.js';
import { applySetup, currentLaunch, planSetup } from './install.js';
import { SetupError } from './error.js';

export const SETUP_HELP = `为 agent 客户端配置 ONES MCP

用法：onces-mcp setup [选项]

  --client <客户端>   指定一个或多个客户端，可用逗号分隔或重复传入
  --all               选择已发现配置目录的客户端
  --yes, -y           不询问是否应用（必须配合 --client 或 --all）
  --dry-run           仅预览，不写入配置或备份
  --config <路径>     指定配置文件，必须同时选择单个 --client
  --name <名称>       首次添加时的服务名称，默认 ones
  --help, -h          查看帮助

支持：${CLIENT_IDS.join(', ')}
默认交互选择客户端；仅修改用户级 MCP 配置，已有其他服务和权限设置会保留。
启动命令绑定本次 setup 所在的安装目录；请保留该目录，迁移或更新后重新运行 setup。
`;

export interface SetupOptions { clients: ClientID[]; all: boolean; yes: boolean; dryRun: boolean; help: boolean; config?: string; name: string }
export function parseSetupArgs(args: string[]): SetupOptions {
  const options: SetupOptions = { clients: [], all: false, yes: false, dryRun: false, help: false, name: 'ones' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--client' || arg === '--config' || arg === '--name') {
      const value = args[++i];
      if (!value || value.startsWith('-') || /[\x00-\x1f]/.test(value)) throw new SetupError('setup 选项缺少有效参数，请运行 setup --help。');
      if (arg === '--client') options.clients.push(...value.split(',').map(clientID));
      else if (arg === '--config') options.config = resolve(value);
      else options.name = value;
    } else throw new SetupError('未知 setup 选项，请运行 setup --help。');
  }
  options.clients = [...new Set(options.clients)];
  if (options.help) return options;
  if (options.all && options.clients.length) throw new SetupError('--all 和 --client 不能同时使用。');
  if (options.config && (options.clients.length !== 1 || options.all)) throw new SetupError('--config 必须配合单个 --client。');
  if (options.yes && !options.all && !options.clients.length) throw new SetupError('--yes 必须配合 --client 或 --all，避免修改未选择的客户端。');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.name)) throw new SetupError('服务名称只能包含 1–64 个字母、数字、下划线或连字符。');
  return options;
}

export async function runSetup(args: string[]): Promise<void> {
  const options = parseSetupArgs(args);
  if (options.help) { process.stdout.write(SETUP_HELP); return; }
  const log = (message: string) => process.stderr.write(`${message}\n`);
  const clients = await resolveClients();
  const context = { input: process.stdin, output: process.stderr };
  let selected = options.clients;
  if (options.all) selected = clients.filter((client) => client.detected).map((client) => client.id);
  else if (!selected.length) {
    if (options.dryRun) selected = clients.filter((client) => client.detected).map((client) => client.id);
    else {
      if (!process.stdin.isTTY) throw new SetupError('请在交互终端运行 setup，或指定 --client <客户端> --yes。');
      selected = await checkbox({
        message: '选择要配置 ONES MCP 的客户端（空格选择，Enter 确认）：',
        choices: clients.map((client) => ({ name: `${client.label}${client.detected ? '（发现配置目录）' : ''}`, value: client.id, checked: client.detected })),
        validate: (value) => value.length > 0 || '请至少选择一个客户端。',
      }, context);
    }
  }
  if (!selected.length) throw new SetupError('未发现客户端配置目录，请使用 --client 指定要配置的客户端。');
  const launch = currentLaunch();
  // Resolve and validate every selected document before applying any changes.
  const plans = [];
  for (const id of selected) {
    const client = clients.find((candidate) => candidate.id === id)!;
    const target = options.config ? { ...client, path: options.config,
      format: client.id === 'opencode' && options.config.endsWith('.jsonc') ? 'jsonc' as const : client.format } : client;
    try { plans.push(await planSetup(target, launch, options.name)); }
    catch (error) { throw new SetupError(`${client.label}：${error instanceof SetupError ? error.message : '无法准备配置。'}`); }
  }
  log('ONES MCP 配置计划：');
  for (const plan of plans) log(`  ${plan.client.label}：${{ add: '新增', update: '更新', unchanged: '已是当前配置' }[plan.status]} ${plan.serverName}\n    ${plan.client.path}`);
  if (options.dryRun) { log('仅预览，未修改配置或创建备份。'); return; }
  if (plans.every((plan) => plan.status === 'unchanged')) { log('配置已是当前版本，无需修改。'); return; }
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new SetupError('未修改配置。非交互调用请先预览，再使用 --yes 应用。');
    if (!await confirm({ message: '应用以上配置？已有文件会先备份。', default: true }, context)) { log('已取消，未修改配置。'); return; }
  }
  for (const plan of plans) {
    try {
      const result = await applySetup(plan);
      log(`${plan.client.label}：${result.status === 'unchanged' ? '无需修改' : '配置完成'}${result.backup ? `\n  备份：${result.backup}` : ''}`);
    } catch (error) { throw new SetupError(`${plan.client.label}：${error instanceof SetupError ? error.message : '配置失败。'} 已完成的其他客户端配置会保留。`); }
  }
  log('请重启或重新连接所选客户端以加载 ONES MCP。缺少 API Key 时，服务会使用独立的配置引导。');
}
