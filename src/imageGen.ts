import type { CowriteSettings } from './settings';
import { chatComplete, readErrorBody } from './llm';
import type { ImageStylePreset } from './imageStyles';

/**
 * 图像生成：
 *  - buildImagePrompt：先用 LLM 根据标题+开头 300 字生成英文配图 prompt
 *  - generateImages：OpenAI 兼容 POST <imageApiBase>/images/generations，response_format=b64_json
 *    v0.6：最终 prompt = LLM 描述 + stylePreset.promptSuffix + customSuffix；
 *          不再使用 settings.imageStyleSuffix 全局拼接；negativePrompt 不传（OpenAI images API 不支持）。
 * 纯浏览器 fetch，base64 解码为 ArrayBuffer，无 Node 依赖，移动端可用。
 */

function buildImagesUrl(apiBase: string): string {
  const base = (apiBase || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('配图 API Base 未配置');
  if (/\/images\/generations$/.test(base)) return base;
  return `${base}/images/generations`;
}

/** 把 base64 字符串解码为 ArrayBuffer */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 用 LLM 根据文章标题 + 开头 300 字，生成适合配图的英文 prompt。
 * 仅返回 LLM 清洗后的 prompt 本体；风格后缀由 generateImages() 统一拼接。
 */
export async function buildImagePrompt(
  title: string,
  head: string,
  settings: CowriteSettings,
): Promise<string> {
  const system =
    'You are an editorial illustrator prompt writer. ' +
    'Given an article title and its opening text, write a single English image-generation prompt (one sentence, <=60 words) ' +
    'that describes a clean editorial illustration matching the article topic. ' +
    'Do not include any text, letters, or words in the image. ' +
    'Do not wrap in quotes, do not add explanations, output only the prompt itself.';
  const user = `Title: ${title}\n\nOpening: ${head.slice(0, 300)}\n\nWrite the image prompt now:`;
  const raw = await chatComplete(
    settings,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.6, maxTokens: 160 },
  );
  return raw.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').trim();
}

export interface GenerateImagesOptions {
  /** 形如 "1792x1024"；不传则用默认 16:9 */
  size?: string;
  /** 弹窗里选的风格预设，其 promptSuffix 会被拼到 prompt 末尾 */
  stylePreset?: ImageStylePreset;
  /** 用户在"自定义描述"里追加的文本，无论选哪个风格都会拼 */
  customSuffix?: string;
}

/** 生成 count 张图，返回每张图的 ArrayBuffer（PNG）。 */
export async function generateImages(
  prompt: string,
  count: number,
  settings: CowriteSettings,
  opts?: GenerateImagesOptions,
): Promise<ArrayBuffer[]> {
  const apiKey = (settings.imageApiKey || '').trim() || settings.apiKey;
  if (!apiKey) {
    throw new Error('未配置配图 API Key（主 API Key 也为空）');
  }
  if (!prompt || !prompt.trim()) {
    throw new Error('配图提示词为空');
  }
  const url = buildImagesUrl(settings.imageApiBase);

  // 组装最终 prompt：LLM 描述 + 预设后缀 + 用户自定义追加
  const parts: string[] = [prompt.trim()];
  const presetSuffix = (opts?.stylePreset?.promptSuffix || '').trim();
  if (presetSuffix) parts.push(presetSuffix);
  const customSuffix = (opts?.customSuffix || '').trim();
  if (customSuffix) parts.push(customSuffix);
  const finalPrompt = parts.join(', ');

  const body: Record<string, unknown> = {
    model: settings.imageModel,
    prompt: finalPrompt,
    n: Math.max(1, Math.min(4, count)),
    size: opts?.size || '1792x1024',
    response_format: 'b64_json',
    quality: settings.imageQuality === 'hd' ? 'hd' : 'standard',
  };

  const controller = new AbortController();
  const timeoutMs = settings.requestTimeoutMs || 120000;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    window.clearTimeout(timer);
    if ((e as Error).name === 'AbortError') {
      throw new Error(`配图请求超时（>${timeoutMs}ms）`);
    }
    throw new Error(`配图网络请求失败：${(e as Error).message || String(e)}`);
  }

  if (!resp.ok) {
    window.clearTimeout(timer);
    throw new Error(await readErrorBody(resp));
  }
  window.clearTimeout(timer);

  const data: any = await resp.json().catch(() => null);
  const items: any[] | undefined = data?.data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('配图接口未返回图片数据');
  }
  const out: ArrayBuffer[] = [];
  for (const item of items) {
    const b64: string | undefined = item?.b64_json;
    if (typeof b64 === 'string' && b64.length > 0) {
      out.push(base64ToArrayBuffer(b64));
    }
  }
  if (out.length === 0) {
    throw new Error('配图接口返回的数据中没有 b64_json');
  }
  return out;
}
