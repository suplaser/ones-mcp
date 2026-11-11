import { normalizeApiKey } from './config.js';
import type { AppConfig } from './config.js';

export interface CredentialStore {
  get(): Promise<string | null>;
  set(apiKey: string): Promise<void>;
}

export class SystemCredentialStore implements CredentialStore {
  constructor(private readonly origin: string) {}

  private async entry() {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry('ones-mcp.personal-api-key', this.origin);
  }

  async get(): Promise<string | null> {
    try {
      return await (await this.entry()).getPassword();
    } catch {
      throw new Error('无法读取系统凭据库。请检查凭据库是否可用，或使用 ONES_API_KEY 进程环境变量。');
    }
  }

  async set(apiKey: string): Promise<void> {
    const normalized = normalizeApiKey(apiKey);
    try {
      const entry = await this.entry();
      await entry.setPassword(normalized);
      if (await entry.getPassword() !== normalized) {
        throw new Error('Credential readback failed');
      }
    } catch {
      throw new Error('API Key 保存失败；未回退到明文文件。请检查系统凭据库。');
    }
  }
}

export interface ResolvedCredential {
  key: string;
  source: 'environment' | 'system-keychain';
}

export async function resolveCredential(
  config: AppConfig,
  store: CredentialStore,
): Promise<ResolvedCredential | null> {
  if (config.environmentApiKey) {
    return { key: config.environmentApiKey, source: 'environment' };
  }
  const saved = await store.get();
  return saved ? { key: normalizeApiKey(saved), source: 'system-keychain' } : null;
}
