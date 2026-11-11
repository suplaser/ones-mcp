import { normalizeApiKey, PERSONAL_API_KEYS_URL } from './config.js';
import type { AppConfig } from './config.js';
import { resolveCredential } from './credentials.js';
import type { CredentialStore, ResolvedCredential } from './credentials.js';
import type { Desktop } from './desktop.js';

export interface LoginPrompts {
  confirmOverwrite(source: ResolvedCredential['source']): Promise<boolean>;
  readApiKey(): Promise<string>;
}

export async function configureApiKey(
  config: AppConfig,
  store: CredentialStore,
  desktop: Desktop,
  prompts: LoginPrompts,
  openBrowser: boolean,
  log: (message: string) => void,
): Promise<'saved' | 'kept'> {
  const current = await resolveCredential(config, store);
  if (current) {
    if (!await prompts.confirmOverwrite(current.source)) {
      log('已保留原有凭据，未进行覆盖。');
      return 'kept';
    }
    if (current.source === 'environment') {
      log('本次只更新系统凭据库，不修改 ONES_API_KEY 环境变量；该环境变量仍优先于系统凭据。');
    }
  }
  log(`请在此页面创建个人 API Key：${PERSONAL_API_KEYS_URL}`);
  if (openBrowser) {
    try { await desktop.openBrowser(PERSONAL_API_KEYS_URL); }
    catch { log('无法自动打开浏览器，请手动打开上面的地址。'); }
  }
  const input = await prompts.readApiKey();
  await store.set(normalizeApiKey(input));
  log('API Key 已安全保存到系统凭据库。MCP 下次检查即可读取，无需重启。');
  log('目前仅完成本地保存，尚未验证 ONES API 权限。');
  return 'saved';
}
