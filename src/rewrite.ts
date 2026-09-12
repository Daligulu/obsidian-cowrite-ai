import type { CowriteSettings } from './settings';
import { chatComplete } from './llm';

/**
 * 文章改写：调用 LLM 单次 chat completion。
 * 纯文本往返，保留 Markdown 结构。
 */

export type RewriteMode = 'polish' | 'expand' | 'shorten' | 'translate';

const MODE_LABEL: Record<RewriteMode, string> = {
  polish: '润色',
  expand: '扩写',
  shorten: '缩写',
  translate: '翻译',
};

function buildSystemPrompt(mode: RewriteMode, targetLang?: string): string {
  switch (mode) {
    case 'polish':
      return (
        '你是一名资深中文文字编辑。下面是用户给你的一段 Markdown 正文。' +
        '请直接输出润色后的完整 Markdown 正文（不要解释、不要前后缀、不要代码块包裹）。' +
        '润色原则：修正语病与冗余，统一术语与标点，提升可读性与节奏，但严格保留作者原意与核心信息；' +
        '如原文含标题层级、列表、引用、图片链接、代码块，请原样保留这些结构与标记。'
      );
    case 'expand':
      return (
        '你是一名中文内容写作者。下面是用户给你的一段 Markdown 正文。' +
        '请在保留原意与结构的基础上扩写：补充必要的论证、例子与过渡句，让内容更充实、更有深度。' +
        '直接输出扩写后的完整 Markdown 正文（不要解释、不要前后缀、不要代码块包裹）。' +
        '保留原文标题层级、列表、引用、图片链接等结构标记。'
      );
    case 'shorten':
      return (
        '你是一名资深编辑。下面是用户给你的一段 Markdown 正文。' +
        '请在保留核心观点与关键信息的前提下进行缩写，删除冗余修饰与重复论述，让文章更精炼。' +
        '直接输出缩写后的完整 Markdown 正文（不要解释、不要前后缀、不要代码块包裹）。' +
        '保留原文必要的标题层级与结构标记。'
      );
    case 'translate':
      return (
        `你是一名专业翻译。下面是用户给你的一段 Markdown 正文，请翻译成 ${targetLang || '英文'}。` +
        '直接输出翻译后的完整 Markdown 正文（不要解释、不要前后缀、不要代码块包裹）。' +
        '保留原文标题层级、列表、引用、图片链接、代码块等结构标记；Markdown 符号（#、*、>、-、[]() 等）不要翻译。'
      );
  }
}

/** 执行改写，返回处理后的文本 */
export async function rewrite(
  mode: RewriteMode,
  text: string,
  targetLang: string | undefined,
  settings: CowriteSettings,
): Promise<string> {
  if (!text || !text.trim()) {
    throw new Error('没有可处理的文本');
  }
  const system = buildSystemPrompt(mode, targetLang);
  const out = await chatComplete(settings, [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ]);
  return out;
}

export function rewriteLabel(mode: RewriteMode): string {
  return MODE_LABEL[mode];
}
