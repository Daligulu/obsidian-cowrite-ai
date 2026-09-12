/**
 * Cowrite AI 插件设置（持久化到 <vault>/.obsidian/plugins/cowrite-ai/data.json）。
 * v0.4：文章创作工具条，流式改写 / LLM 配图 / 智能排版 / 公众号真实发布。
 */

/** 配图尺寸预设：1:1 / 16:9 / 9:16 */
export type ImageSizePreset = '1:1' | '16:9' | '9:16';

/** 预设 → OpenAI images/generations 的 size 字符串 */
export const IMAGE_SIZE_MAP: Record<ImageSizePreset, string> = {
  '1:1': '1024x1024',
  '16:9': '1792x1024',
  '9:16': '1024x1792',
};

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
  /** 配图尺寸预设（1:1 / 16:9 / 9:16），所有位置默认走 16:9 横版 */
  imageSizePreset: ImageSizePreset;
  /** 图像质量：standard / hd（hd 仅 dall-e-3 支持） */
  imageQuality: 'standard' | 'hd';
  /** 拼接到 prompt 末尾的风格后缀，空串表示不拼接 */
  imageStyleSuffix: string;

  // ---- 公众号排版主题 ----
  /** gzh-design 主题 id，见 themes.ts；默认 graphite-minimal */
  gzhTheme: string;

  // ---- 公众号发布配置（真实 API） ----
  /** 公众号 appid */
  wechatAppid: string;
  /** 公众号 appsecret */
  wechatSecret: string;

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
  imageSizePreset: '16:9',
  imageQuality: 'standard',
  imageStyleSuffix: 'clean illustration style, soft colors, professional editorial',

  gzhTheme: 'graphite-minimal',

  wechatAppid: '',
  wechatSecret: '',

  openOnStart: false,
  attachmentsDir: 'attachments',
};

/** 把预设解析成合法尺寸字符串；非法值回退到默认 16:9 */
export function resolveImageSize(preset: string): string {
  const p = (preset || '').trim() as ImageSizePreset;
  return IMAGE_SIZE_MAP[p] || IMAGE_SIZE_MAP['16:9'];
}

export function normalizeSettings(loaded: Partial<CowriteSettings> | null): CowriteSettings {
  const merged: CowriteSettings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  merged.apiBase = (merged.apiBase || '').trim() || DEFAULT_SETTINGS.apiBase;
  merged.model = (merged.model || '').trim() || DEFAULT_SETTINGS.model;
  merged.temperature = Math.max(0, Math.min(2, Number.isFinite(merged.temperature) ? merged.temperature : 0.7));
  merged.maxTokens = Math.max(256, merged.maxTokens || 2048);
  merged.requestTimeoutMs = Math.max(5000, merged.requestTimeoutMs || 60000);

  merged.imageApiBase = (merged.imageApiBase || '').trim() || DEFAULT_SETTINGS.imageApiBase;
  merged.imageModel = (merged.imageModel || '').trim() || DEFAULT_SETTINGS.imageModel;
  // 兼容旧版 imageSize 自由文本：若是已知预设映射则直接采用，否则落到默认 16:9
  const preset = (merged.imageSizePreset || '').trim() as ImageSizePreset;
  merged.imageSizePreset = ['1:1', '16:9', '9:16'].includes(preset) ? preset : '16:9';
  merged.imageQuality = merged.imageQuality === 'hd' ? 'hd' : 'standard';
  // 风格后缀允许空串（表示不拼接），不做 trim 强制，保留用户输入
  merged.imageStyleSuffix =
    typeof merged.imageStyleSuffix === 'string'
      ? merged.imageStyleSuffix
      : DEFAULT_SETTINGS.imageStyleSuffix;

  merged.gzhTheme = (merged.gzhTheme || '').trim() || DEFAULT_SETTINGS.gzhTheme;

  merged.wechatAppid = (merged.wechatAppid || '').trim();
  merged.wechatSecret = (merged.wechatSecret || '').trim();

  merged.attachmentsDir = (merged.attachmentsDir || '').trim() || 'attachments';
  return merged;
}
