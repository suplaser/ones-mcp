import { normalizeApiKey } from './config.js';

export const overwriteApiKeyPromptOptions = {
  message: '已存在本地 API Key，是否覆盖？',
  default: false,
};

/** Shared by the real CLI and its terminal rendering checks. */
export const apiKeyPromptOptions = {
  message: '粘贴用户级个人 API Key 后按 Enter（每个字符显示为 *）：',
  mask: '*',
  toggleMask: false,
  validate: (value: string): true | string => {
    try { normalizeApiKey(value); return true; }
    catch { return '请仅粘贴非空的 API Key 值，不含空格或 Bearer 前缀。'; }
  },
};
