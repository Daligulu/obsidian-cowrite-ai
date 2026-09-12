import type { CowriteSettings } from './settings';
import { chatComplete, chatStream } from './llm';

/**
 * 文章改写：调用 LLM。
 *  - 所有模式的 system prompt 都带 AI 腔黑名单
 *  - 支持 SSE 流式（onDelta 逐段回调），否则退化为单次调用
 *  - 纯文本往返，保留 Markdown 结构。
 */

export type RewriteMode = 'polish' | 'expand' | 'shorten' | 'translate' | 'deai';

const MODE_LABEL: Record<RewriteMode, string> = {
  polish: '润色',
  expand: '扩写',
  shorten: '缩写',
  translate: '翻译',
  deai: '去 AI 味',
};

/** 所有改写模式共用的 AI 腔黑名单，拼到 system prompt 末尾 */
const AI_TONE_BLACKLIST =
  '【文风硬性约束，必须遵守】' +
  '禁止出现以下套话："本质上""说白了就是""换句话说""值得注意的是""综上所述""笔者认为"。' +
  '禁止三段排比式结尾（"是……，是……，更是……"这类句式）。' +
  '禁止每段都以"而"或"然而"开头。' +
  '"不是 X，而是 Y"这种句式全文最多出现 1 次。' +
  '整体输出要像真人写的：不要过于工整对称，允许口语化、允许长短句不齐、允许不完美。';

function buildSystemPrompt(mode: RewriteMode, targetLang?: string): string {
  let base: string;
  switch (mode) {
    case 'polish':
      base =
        '你是一名资深中文文字编辑。下面是用户给你的一段 Markdown 正文。' +
        '请直接输出润色后的完整 Markdown 正文（不要解释、不要前后缀、不要代码块包裹）。' +
        '润色原则：修正语病与冗余，统一术语与标点，提升可读性与节奏，但严格保留作者原意与核心信息；' +
        '如原文含标题层级、列表、引用、图片链接、代码块，请原样保留这些结构与标记。' +
        '若单段超过 90 字（约手机屏 4 行），请在合适的句号/分号处自然拆成两段，不要堆成大段。' +
        '去 AI 味：输出要更像人写的，不要过于工整对称，允许口语化表达。';
      break;
    case 'expand':
      base =
        '你是一名中文内容写作者。下面是用户给你的一段 Markdown 正文。' +
        '请在保留原意与结构的基础上扩写：补充必要的论证、例子与过渡句，让内容更充实、更有深度。' +
        '直接输出扩写后的完整 Markdown 正文（不要解释、不要前后缀、不要代码块包裹）。' +
        '扩写不要均匀拉长：重点段落（核心观点、关键论证）多写，过渡段落少写甚至不动。' +
        '保留原文标题层级、列表、引用、图片链接等结构标记。';
      break;
    case 'shorten':
      base =
        '你是一名资深编辑。下面是用户给你的一段 Markdown 正文。' +
        '请在保留核心观点与关键数据的前提下进行缩写，删除冗余修饰、重复论述与空话套话，让文章更精炼。' +
        '直接输出缩写后的完整 Markdown 正文（不要解释、不要前后缀、不要代码块包裹）。' +
        '关键数字、专有名词、结论句必须保留；保留原文必要的标题层级与结构标记。';
      break;
    case 'translate':
      base =
        `你是一名专业翻译。下面是用户给你的一段 Markdown 正文，请翻译成 ${targetLang || '英文'}。` +
        '直接输出翻译后的完整 Markdown 正文（不要解释、不要前后缀、不要代码块包裹）。' +
        '保留原文标题层级、列表、引用、图片链接；Markdown 符号（#、*、>、-、[]() 等）不要翻译；' +
        '代码块（``` fenced）和图片语法（![alt](url)）原样保留，不要翻译其中内容。';
      break;
    case 'deai':
      base =
        '你是一名专去 AI 味的中文编辑。下面是用户给你的一段 Markdown 正文，疑似是 AI 生成的，文风过于工整、套话多。' +
        '请把它改写成更像真人写的自然中文：打散对称句式、删除"本质上/换句话说/值得注意的是"这类套话、' +
        '把排比句和"不是 X 而是 Y"句式压到最少、允许口语化和长短句不齐。' +
        '直接输出改写后的完整 Markdown 正文（不要解释、不要前后缀、不要代码块包裹）。' +
        '保留原文标题层级、列表、引用、图片链接、代码块等结构标记。';
      break;
  }
  return `${base}\n\n${AI_TONE_BLACKLIST}`;
}

/** 执行改写；传入 onDelta 则走 SSE 流式逐段回调，否则走单次调用 */
export async function rewrite(
  mode: RewriteMode,
  text: string,
  targetLang: string | undefined,
  settings: CowriteSettings,
  onDelta?: (delta: string, fullSoFar: string) => void,
): Promise<string> {
  if (!text || !text.trim()) {
    throw new Error('没有可处理的文本');
  }
  const system = buildSystemPrompt(mode, targetLang);
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: text },
  ];
  if (onDelta) {
    return await chatStream(settings, messages, onDelta);
  }
  return await chatComplete(settings, messages);
}

export function rewriteLabel(mode: RewriteMode): string {
  return MODE_LABEL[mode];
}
