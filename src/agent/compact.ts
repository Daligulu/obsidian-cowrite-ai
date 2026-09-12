import type { ChatMessage, LLMProvider } from './providers/llm';

/**
 * 上下文压缩（借鉴 OpenHands / Claude Code 做法）。
 * 估算 token → 超过阈值时把中间历史 summarize 成一段 system 摘要 → 保留尾部近期消息。
 * 全程 try/catch：压缩失败直接跳过，不影响主流程（OpenHands issue #2703 教训）。
 */

/** 粗略 token 估算：3 字符 ≈ 1 token（中英混排够用，不引 tiktoken） */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 3);
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content || '');
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc.function.name + (tc.function.arguments || ''));
      }
    }
  }
  return total;
}

export interface CompactResult {
  messages: ChatMessage[];
  compacted: boolean;
}

/**
 * 在 turn 边界调用：判断历史是否过长，过长则压缩。
 * - contextWindow：模型上下文窗口（粗估，默认 128k）
 * - threshold：触发比例（settings.compactThreshold，默认 0.80）
 * - retainRatio：保留尾部比例（settings.compactRetain，默认 0.16）
 */
export async function compactHistory(opts: {
  provider: LLMProvider;
  system: string;
  messages: ChatMessage[];
  contextWindow?: number;
  threshold: number;
  retainRatio: number;
  signal: AbortSignal;
}): Promise<CompactResult> {
  const { provider, system, messages } = opts;
  const contextWindow = opts.contextWindow || 128000;
  const threshold = Math.max(0.5, Math.min(0.95, opts.threshold || 0.8));
  const retainRatio = Math.max(0.08, Math.min(0.4, opts.retainRatio || 0.16));

  const used = estimateMessagesTokens(messages);
  if (used < contextWindow * threshold) {
    return { messages, compacted: false };
  }

  try {
    // 保留尾部 retainRatio 条消息（至少 2 条）
    const retainCount = Math.max(2, Math.floor(messages.length * retainRatio));
    const tail = messages.slice(-retainCount);
    const middle = messages.slice(0, messages.length - retainCount);
    if (middle.length === 0) {
      return { messages, compacted: false };
    }

    // 把中间历史拍平成一段文本交给模型摘要
    const flat = middle
      .map((m) => {
        const role = m.role;
        let body = m.content || '';
        if (Array.isArray(m.tool_calls)) {
          body += '\n[tool_calls: ' + m.tool_calls.map((tc) => tc.function.name).join(', ') + ']';
        }
        return `${role}: ${body}`;
      })
      .join('\n\n');

    const summarySystem =
      '你是对话历史压缩器。请把以下多轮 Agent 会话历史压缩成一段简洁的中文摘要，' +
      '保留：已完成的关键动作、读写过的文件路径、用户核心目标、当前未完成的步骤。' +
      '不要展开细节，不要客套，300 字以内。';

    const summaryUser = `【待压缩历史】\n${flat}`;

    // 调一次模型做摘要（非工具调用，纯文本）
    let summary = '';
    const gen = provider.chat(
      {
        system: summarySystem,
        messages: [{ role: 'user', content: summaryUser }],
        tools: [],
        temperature: 0.3,
        maxTokens: 512,
      },
      opts.signal,
    );
    for await (const ev of gen) {
      if (ev.type === 'text-delta' && ev.delta) summary += ev.delta;
    }

    if (!summary.trim()) {
      return { messages, compacted: false };
    }

    const summarized: ChatMessage[] = [
      { role: 'system', content: `[历史摘要]\n${summary.trim()}` },
      ...tail,
    ];
    // 把运行时 system prompt 放在最前（composeSystemPrompt 每次都会前置）
    void system;
    return { messages: summarized, compacted: true };
  } catch (e) {
    // 压缩失败：跳过，继续跑（不抛错中断主流程）
    console.warn('Cowrite AI: compact failed, skip', e);
    return { messages, compacted: false };
  }
}
