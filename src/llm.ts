import type { CowriteSettings } from './settings';

/**
 * LLM 调用层：
 *  - chatComplete：单次非流式 chat/completions
 *  - chatStream：SSE 流式，逐段回调 delta
 *  - readErrorBody：从非 2xx 响应里提取 OpenAI error.message / 微信 errmsg
 *  - parseError：把任意 thrown 值转成可读字符串
 * 纯浏览器 fetch，无 Node 依赖，移动端可用。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 拼装 chat/completions URL（容错尾部斜杠与是否已含 /chat/completions） */
function buildChatUrl(apiBase: string): string {
  const base = (apiBase || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('API Base 未配置');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/**
 * 从非 2xx 响应体里提取可读错误原因。
 * 兼容 OpenAI 风格 { error: { message } }、微信风格 { errmsg }，
 * 都解析不出来时返回截断后的原文片段。
 */
export async function readErrorBody(resp: Response): Promise<string> {
  const raw = await resp.text().catch(() => '');
  if (!raw) return `HTTP ${resp.status} ${resp.statusText || ''}`.trim();
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const msg: string | undefined =
    parsed?.error?.message ||
    parsed?.error?.msg ||
    parsed?.errmsg ||
    parsed?.message;
  if (msg && typeof msg === 'string') return msg;
  return `HTTP ${resp.status} ${resp.statusText || ''}: ${raw.slice(0, 200)}`.trim();
}

/**
 * 把任意 thrown 值转成可读错误字符串。
 * 用于 toast / Notice 展示，绝不暴露 HTTP 状态码或堆栈。
 */
export function parseError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return '请求超时，请稍后重试';
    return err.message || String(err);
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 单次 chat completion，返回模型输出文本 */
export async function chatComplete(
  settings: CowriteSettings,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  if (!settings.apiKey) {
    throw new Error('未配置 API Key，请在设置中填写');
  }
  const url = buildChatUrl(settings.apiBase);
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    stream: false,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : settings.temperature,
  };
  const maxTokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : settings.maxTokens;
  if (maxTokens > 0) body.max_tokens = maxTokens;

  const controller = new AbortController();
  const timeoutMs = settings.requestTimeoutMs || 60000;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    window.clearTimeout(timer);
    if ((e as Error).name === 'AbortError') {
      throw new Error(`请求超时（>${timeoutMs}ms）`);
    }
    throw new Error(`网络请求失败：${(e as Error).message || String(e)}`);
  }

  if (!resp.ok) {
    window.clearTimeout(timer);
    throw new Error(await readErrorBody(resp));
  }
  window.clearTimeout(timer);

  const data: any = await resp.json().catch(() => null);
  const text: string | undefined = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('模型返回为空');
  }
  return text.trim();
}

/**
 * SSE 流式 chat completion。
 * onDelta 每收到一段增量文本就回调一次；resolve 时返回完整文本。
 * 调用方负责把 delta 增量写到编辑器。
 */
export async function chatStream(
  settings: CowriteSettings,
  messages: ChatMessage[],
  onDelta: (delta: string, fullSoFar: string) => void,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  if (!settings.apiKey) {
    throw new Error('未配置 API Key，请在设置中填写');
  }
  const url = buildChatUrl(settings.apiBase);
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    stream: true,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : settings.temperature,
  };
  const maxTokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : settings.maxTokens;
  if (maxTokens > 0) body.max_tokens = maxTokens;

  const controller = new AbortController();
  const timeoutMs = settings.requestTimeoutMs || 120000;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    window.clearTimeout(timer);
    if ((e as Error).name === 'AbortError') {
      throw new Error(`请求超时（>${timeoutMs}ms）`);
    }
    throw new Error(`网络请求失败：${(e as Error).message || String(e)}`);
  }

  if (!resp.ok) {
    window.clearTimeout(timer);
    throw new Error(await readErrorBody(resp));
  }

  if (!resp.body) {
    window.clearTimeout(timer);
    // 极端情况下不支持流式，退回一次性读取
    const data: any = await resp.json().catch(() => null);
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('模型返回为空');
    }
    onDelta(text, text);
    return text.trim();
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 按 \n\n 分帧；这里按行处理 data: 前缀
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') continue;
        let json: any = null;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta: string | undefined = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          full += delta;
          onDelta(delta, full);
        }
      }
    }
  } finally {
    window.clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (full.length === 0) {
    throw new Error('模型流式返回为空');
  }
  return full.trim();
}

/** 测试连接：发一条极简 ping */
export async function testConnection(settings: CowriteSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const text = await chatComplete(
      settings,
      [
        { role: 'system', content: 'You are a ping responder. Reply with one short sentence.' },
        { role: 'user', content: 'ping' },
      ],
      { temperature: 0, maxTokens: 32 },
    );
    const snippet = (text || '').trim().slice(0, 80);
    return { ok: true, message: `连接成功，模型回复：${snippet || '(空)'}` };
  } catch (e) {
    return { ok: false, message: `连接失败：${parseError(e)}` };
  }
}
