import type { CowriteSettings } from './settings';

/**
 * OpenAI 兼容 Chat Completions 客户端。
 * 纯浏览器 fetch 实现，无 EventSource / 无 Node 依赖，适配移动端 Obsidian。
 * 鉴权：Authorization: Bearer <apiKey>
 * 超时：AbortController 控制，默认 60s。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResult {
  /** 模型返回的文本内容 */
  content: string;
  /** 原始 usage（如有） */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

/** 拼装完整 chat/completions URL（容错 apiBase 尾部斜杠与是否已含 /v1） */
function buildUrl(apiBase: string): string {
  const base = (apiBase || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('API Base 未配置');
  // 若用户填的是带 /chat/completions 的完整 URL，直接返回
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/**
 * 发起一次非流式 chat.completion 请求。
 * 失败时抛出 Error，message 包含状态码与截断后的响应体，便于 UI 展示。
 */
export async function chatCompletion(
  settings: CowriteSettings,
  messages: ChatMessage[],
): Promise<ChatCompletionResult> {
  if (!settings.apiKey) {
    throw new Error('未配置 API Key，请在设置中填写');
  }
  const url = buildUrl(settings.apiBase);

  const body = {
    model: settings.model,
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs || 60000);

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
      throw new Error(`请求超时（>${settings.requestTimeoutMs}ms），请检查网络或模型地址`);
    }
    throw new Error(`网络请求失败：${(e as Error).message || String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  const rawText = await resp.text();
  if (!resp.ok) {
    const snippet = rawText ? rawText.slice(0, 300) : '(空响应)';
    throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${snippet}`);
  }

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`响应不是合法 JSON：${rawText.slice(0, 200)}`);
  }

  const choice = data?.choices?.[0];
  const content: string | undefined =
    choice?.message?.content ?? choice?.text ?? (typeof data?.content === 'string' ? data.content : undefined);
  if (!content) {
    throw new Error(`响应中未找到文本内容：${rawText.slice(0, 200)}`);
  }
  return {
    content: content as string,
    usage: data?.usage,
    model: data?.model,
  };
}

/** 测试连接：发一条极简 ping 消息，返回是否成功及错误信息 */
export async function testConnection(settings: CowriteSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await chatCompletion(settings, [
      { role: 'system', content: 'You are a ping responder.' },
      { role: 'user', content: 'ping' },
    ]);
    const snippet = (r.content || '').trim().slice(0, 80);
    return { ok: true, message: `连接成功，模型回复：${snippet || '(空)'}` };
  } catch (e) {
    return { ok: false, message: `连接失败：${(e as Error).message || String(e)}` };
  }
}
