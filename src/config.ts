export const PERSONAL_API_KEYS_URL =
  'https://ones.cn/project/#/profile/personal_openapi_keys';
export const LOGIN_COMMAND = 'npx @suplaser/onces-mcp auth login';

export interface AppConfig {
  origin: string;
  apiOrigin?: string;
  environmentApiKey: string | undefined;
}

export function normalizeApiKey(input: string): string {
  const key = input.trim();
  if (!key || /\s/.test(key) || /^Bearer\s/i.test(key)) {
    throw new Error('请仅粘贴 API Key 值，不要包含空格、换行或 Bearer 前缀。');
  }
  return key;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const url = new URL(env.ONES_BASE_URL ?? 'https://ones.cn');
  if (url.protocol !== 'https:' || url.username || url.password || url.search ||
      url.hash || url.pathname !== '/') {
    throw new Error('ONES_BASE_URL 必须是 HTTPS 站点地址，例如 https://ones.cn。');
  }
  // Keep the existing credential account stable. The public cloud Open API
  // lives on sz.ones.cn; ones.cn hosts the personal-key settings page.
  const apiUrl = new URL(env.ONES_API_BASE_URL ?? (url.origin === 'https://ones.cn' ? 'https://sz.ones.cn' : url.origin));
  if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password || apiUrl.search ||
      apiUrl.hash || apiUrl.pathname !== '/') {
    throw new Error('ONES_API_BASE_URL 必须是 HTTPS 站点地址，例如 https://sz.ones.cn。');
  }
  return {
    origin: url.origin,
    apiOrigin: apiUrl.origin,
    environmentApiKey: env.ONES_API_KEY ? normalizeApiKey(env.ONES_API_KEY) : undefined,
  };
}
