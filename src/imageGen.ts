import type { CowriteSettings } from './settings';

/**
 * 图像生成：OpenAI 兼容 POST <imageApiBase>/images/generations，response_format=b64_json。
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

/** 生成 count 张图，返回每张图的 ArrayBuffer（PNG） */
export async function generateImages(
  prompt: string,
  count: number,
  settings: CowriteSettings,
): Promise<ArrayBuffer[]> {
  const apiKey = (settings.imageApiKey || '').trim() || settings.apiKey;
  if (!apiKey) {
    throw new Error('未配置配图 API Key（主 API Key 也为空）');
  }
  if (!prompt || !prompt.trim()) {
    throw new Error('配图提示词为空');
  }
  const url = buildImagesUrl(settings.imageApiBase);
  const body: Record<string, unknown> = {
    model: settings.imageModel,
    prompt,
    n: Math.max(1, Math.min(4, count)),
    size: settings.imageSize || '1024x1024',
    response_format: 'b64_json',
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
    if ((e as Error).name === 'AbortError') {
      throw new Error(`配图请求超时（>${timeoutMs}ms）`);
    }
    throw new Error(`配图网络请求失败：${(e as Error).message || String(e)}`);
  } finally {
    window.clearTimeout(timer);
  }

  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    const snippet = raw ? raw.slice(0, 300) : '(空响应)';
    throw new Error(`配图 HTTP ${resp.status} ${resp.statusText}: ${snippet}`);
  }

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
