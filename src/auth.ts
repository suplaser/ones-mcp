import { LOGIN_COMMAND, PERSONAL_API_KEYS_URL } from './config.js';
import type { AppConfig } from './config.js';
import { resolveCredential } from './credentials.js';
import type { CredentialStore } from './credentials.js';
import type { Desktop } from './desktop.js';
import type { SetupLock } from './setup-lock.js';

export interface AuthStatus {
  configured: boolean;
  source: 'environment' | 'system-keychain' | null;
  verified: false;
  setup: 'not-needed' | 'not-started' | 'waiting-for-input' | 'manual-required';
  message: string;
  settingsUrl: string;
}

export class AuthCoordinator {
  private setup: AuthStatus['setup'] = 'not-started';
  private starting: Promise<void> | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly store: CredentialStore,
    private readonly desktop: Desktop,
    private readonly lock: SetupLock,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async status(): Promise<AuthStatus> {
    const credential = await resolveCredential(this.config, this.store);
    return {
      configured: credential !== null,
      source: credential?.source ?? null,
      verified: false,
      setup: credential ? 'not-needed' : this.setup,
      message: credential
        ? '已找到按 API Key 配置保存的本地凭据。仅凭存储值无法判断它是用户 API Key 还是项目 Token；类型、有效性、用户身份与权限尚未远端验证。'
        : `尚未配置 API Key。请在 ONES 页面创建 Key，并在独立终端粘贴；也可手动运行 ${LOGIN_COMMAND}。`,
      settingsUrl: PERSONAL_API_KEYS_URL,
    };
  }

  ensureSetup(): Promise<void> {
    this.starting ??= this.startSetup();
    return this.starting;
  }

  private async startSetup(): Promise<void> {
    if (await resolveCredential(this.config, this.store)) return;
    const lease = await this.lock.acquire();
    if (!lease) {
      this.setup = 'waiting-for-input';
      return;
    }
    try {
      // Recheck after acquiring the lock: another process may have saved the key.
      if (await resolveCredential(this.config, this.store)) {
        await lease.release();
        return;
      }
      const pid = await this.desktop.openLoginTerminal();
      await lease.handoff(pid);
      this.setup = 'waiting-for-input';
      try { await this.desktop.openBrowser(PERSONAL_API_KEYS_URL); }
      catch { this.log('浏览器未自动打开，请使用输入终端中显示的 ONES API Key 页面地址。'); }
    } catch {
      this.setup = 'manual-required';
      await lease.release();
      this.log(`无法自动打开独立输入终端。请手动运行 ${LOGIN_COMMAND}。`);
    }
  }
}
