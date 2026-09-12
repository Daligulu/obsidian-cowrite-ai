import { PROMPT_PREFIX, PROMPT_PREFIX_ORDER } from './prefix';

/**
 * System prompt 组装：按 order 排序拼接，前缀稳定（KV cache 友好）。
 * 顺序：prefix(0) → vaultMap(10) → memory(20) → currentNote(30)。
 */
export interface PromptSection {
  order: number;
  render: () => string;
}

export function composeSystemPrompt(sections: PromptSection[]): string {
  const ordered = [
    { order: PROMPT_PREFIX_ORDER, render: () => PROMPT_PREFIX },
    ...sections,
  ].sort((a, b) => a.order - b.order);

  const parts: string[] = [];
  for (const s of ordered) {
    const text = s.render();
    if (text && text.trim().length > 0) parts.push(text.trim());
  }
  return parts.join('\n\n');
}
