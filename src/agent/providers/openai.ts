import type { ChatMessage, ChatRequest, LLMProvider, ToolCall } from './llm';

/** OpenAI 兼容 provider 构造参数 */
export interface OpenAIProviderConfig {
  apiBase: string;
  apiKey: string;
  model: string;
  /** 单次请求超时毫秒（默认 60s） */
  timeoutMs?: number;
}

/** 拼装 chat/completions URL（容错尾部斜杠与是否已含 /chat/completions） */
function buildChatUrl(apiBase: string): string {
  const base = (apiBase || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('API Base 未配置');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/**
 * OpenAI 兼容流式 Provider。
 * 纯浏览器 fetch + ReadableStream 解析 SSE，无 Node 依赖，移动端可用。
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  private cfg: OpenAIProviderConfig;

  constructor(cfg: OpenAIProviderConfig) {
    this.cfg = cfg;
    this.id = cfg.model || 'openai-compatible';
  }

  async *chat(
    req: ChatRequest,
    signal: AbortSignal,
  ): AsyncGenerator<
    import('../events').AgentEvent & { toolCalls?: ToolCall[]; finishReason?: string }
  > {
    if (!this.cfg.apiKey) {
      throw new Error('未配置 API Key，请在设置中填写');
    }
    const url = buildChatUrl(this.cfg.apiBase);

    // 合并 system 到消息头部
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push(...req.messages);

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      stream: true,
      stream_options: { include_usage: false },
    };
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens;
    if (Array.isArray(req.tools) && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }

    // 合并外部取消信号与内部超时
    const controller = new AbortController();
    const timeoutMs = this.cfg.timeoutMs || 60000;
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    signal.addEventListener('abort', onExternalAbort, { once: true });

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new Error(`请求中断或超时（>${timeoutMs}ms）`);
      }
      throw new Error(`网络请求失败：${(e as Error).message || String(e)}`);
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onExternalAbort);
    }

    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      const snippet = raw ? raw.slice(0, 300) : '(空响应)';
      throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${snippet}`);
    }
    if (!resp.body) {
      throw new Error('响应没有 body（流式不可用）');
    }

    // ---- 解析 SSE ----
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    // 按 index 聚合流式 tool_calls（OpenAI 把 arguments 切成多段）
    const toolCallMap = new Map<number, { id: string; name: string; argsRaw: string }>();
    let finishReason: string | undefined;

    const flushToolCalls = (): ToolCall[] => {
      const out: ToolCall[] = [];
      const keys = Array.from(toolCallMap.keys()).sort((a, b) => a - b);
      for (const k of keys) {
        const tc = toolCallMap.get(k)!;
        let args: any = tc.argsRaw;
        try {
          args = tc.argsRaw ? JSON.parse(tc.argsRaw) : {};
        } catch {
          // 解析失败保留原始字符串，loop 会回灌错误让模型重试
        }
        out.push({ id: tc.id || `call_${k}`, name: tc.name || '', args, argsRaw: tc.argsRaw });
      }
      return out;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 事件以空行分隔
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          // 块内逐行找 data:
          const lines = block.split('\n');
          for (const line of lines) {
            const trimmed = line.replace(/\r$/, '');
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr) continue;
            if (dataStr === '[DONE]') {
              continue;
            }
            let chunk: any;
            try {
              chunk = JSON.parse(dataStr);
            } catch {
              continue;
            }
            const choice = chunk?.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};

            // 文本增量
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              yield { type: 'text-delta', delta: delta.content, toolCalls: flushToolCalls() };
            }
            // 思维链增量（DeepSeek 等网关放在 reasoning_content）
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (typeof reasoning === 'string' && reasoning.length > 0) {
              yield { type: 'reasoning', delta: reasoning, toolCalls: flushToolCalls() };
            }
            // 工具调用增量
            if (Array.isArray(delta.tool_calls)) {
              for (const tcDelta of delta.tool_calls) {
                const idx: number = typeof tcDelta.index === 'number' ? tcDelta.index : 0;
                const entry = toolCallMap.get(idx) ?? { id: '', name: '', argsRaw: '' };
                if (typeof tcDelta.id === 'string' && tcDelta.id) entry.id = tcDelta.id;
                const fn = tcDelta.function ?? {};
                if (typeof fn.name === 'string' && fn.name) entry.name = fn.name;
                if (typeof fn.arguments === 'string' && fn.arguments) entry.argsRaw += fn.arguments;
                toolCallMap.set(idx, entry);
              }
              yield { type: 'text-delta', delta: '', toolCalls: flushToolCalls() };
            }
            // 结束原因
            if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 忽略
      }
    }

    // 收尾：把聚合好的 toolCalls 与 finishReason 交给 loop
    yield { type: 'text-delta', delta: '', toolCalls: flushToolCalls(), finishReason };
  }
}
