import type { CowriteSettings } from './settings';

/**
 * LLM 调用层：单次非流式 OpenAI 兼容 chat/completions。
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
    if ((e as Error).name === 'AbortError') {
      throw new Error(`请求超时（>${timeoutMs}ms）`);
    }
    throw new Error(`网络请求失败：${(e as Error).message || String(e)}`);
  } finally {
    window.clearTimeout(timer);
  }

  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    const snippet = raw ? raw.slice(0, 300) : '(空响应)';
    throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${snippet}`);
  }

  const data: any = await resp.json().catch(() => null);
  const text: string | undefined = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('模型返回为空');
  }
  return text.trim();
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
    return { ok: false, message: `连接失败：${(e as Error).message || String(e)}` };
  }
}
