import type { CowriteSettings } from './settings';
import { OpenAICompatibleProvider } from './agent/providers/openai';
import type { LLMProvider } from './agent/providers/llm';

/**
 * LLM Provider 工厂：根据当前设置构造一个 LLMProvider。
 * 旧版单次 chatCompletion 已被 providers/openai.ts 的流式实现取代。
 */
export function createProvider(settings: CowriteSettings): LLMProvider {
  return new OpenAICompatibleProvider({
    apiBase: settings.apiBase,
    apiKey: settings.apiKey,
    model: settings.model,
    timeoutMs: settings.requestTimeoutMs || 60000,
  });
}

/** 测试连接：发一条极简 ping，消费流式响应拼出文本 */
export async function testConnection(settings: CowriteSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const provider = createProvider(settings);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), settings.requestTimeoutMs || 60000);
    let text = '';
    try {
      const gen = provider.chat(
        {
          system: 'You are a ping responder. Reply with one short sentence.',
          messages: [{ role: 'user', content: 'ping' }],
          tools: [],
          temperature: 0,
          maxTokens: 32,
        },
        controller.signal,
      );
      for await (const ev of gen) {
        if (ev.type === 'text-delta') text += ev.delta;
      }
    } finally {
      window.clearTimeout(timer);
    }
    const snippet = (text || '').trim().slice(0, 80);
    return { ok: true, message: `连接成功，模型回复：${snippet || '(空)'}` };
  } catch (e) {
    return { ok: false, message: `连接失败：${(e as Error).message || String(e)}` };
  }
}
