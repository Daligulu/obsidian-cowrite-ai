/**
 * Cowrite AI 插件设置（持久化到 <vault>/.obsidian/plugins/cowrite-ai/data.json）。
 * v0.3：文章创作工具条，不再有任务队列 / 执行器 / 页面库。
 */
export interface CowriteSettings {
  // ---- LLM 配置 ----
  /** OpenAI 兼容 chat/completions 基础地址 */
  apiBase: string;
  /** 主 API Key（Bearer 鉴权） */
  apiKey: string;
  /** 模型名称 */
  model: string;
  /** 采样温度 0~2 */
  temperature: number;
  /** 单次最大生成 token */
  maxTokens: number;
  /** 请求超时毫秒 */
  requestTimeoutMs: number;

  // ---- 图像生成配置 ----
  /** images/generations 基础地址 */
  imageApiBase: string;
  /** 图像 API Key（空则回退用主 apiKey） */
  imageApiKey: string;
  /** 图像模型，默认 dall-e-3 */
  imageModel: string;
  /** 图像尺寸，默认 1024x1024 */
  imageSize: string;

  // ---- 发布平台配置（预留 UI，实际 API 未实现） ----
  wechatToken: string;
  zhihuToken: string;
  xiaohongshuToken: string;
  juejinToken: string;

  // ---- 其他 ----
  /** 启动时自动打开工具条 */
  openOnStart: boolean;
  /** 附件目录（vault 内相对路径），配图写入这里 */
  attachmentsDir: string;
}

export const DEFAULT_SETTINGS: CowriteSettings = {
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 2048,
  requestTimeoutMs: 60000,

  imageApiBase: 'https://api.openai.com/v1',
  imageApiKey: '',
  imageModel: 'dall-e-3',
  imageSize: '1024x1024',

  wechatToken: '',
  zhihuToken: '',
  xiaohongshuToken: '',
  juejinToken: '',

  openOnStart: false,
  attachmentsDir: 'attachments',
};

export function normalizeSettings(loaded: Partial<CowriteSettings> | null): CowriteSettings {
  const merged: CowriteSettings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  merged.apiBase = (merged.apiBase || '').trim() || DEFAULT_SETTINGS.apiBase;
  merged.model = (merged.model || '').trim() || DEFAULT_SETTINGS.model;
  merged.temperature = Math.max(0, Math.min(2, Number.isFinite(merged.temperature) ? merged.temperature : 0.7));
  merged.maxTokens = Math.max(256, merged.maxTokens || 2048);
  merged.requestTimeoutMs = Math.max(5000, merged.requestTimeoutMs || 60000);

  merged.imageApiBase = (merged.imageApiBase || '').trim() || DEFAULT_SETTINGS.imageApiBase;
  merged.imageModel = (merged.imageModel || '').trim() || DEFAULT_SETTINGS.imageModel;
  merged.imageSize = (merged.imageSize || '').trim() || DEFAULT_SETTINGS.imageSize;

  merged.attachmentsDir = (merged.attachmentsDir || '').trim() || 'attachments';
  return merged;
}
