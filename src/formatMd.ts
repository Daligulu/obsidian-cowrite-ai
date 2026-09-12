import type { CowriteSettings } from './settings';
import { chatComplete } from './llm';
import { getTheme, type GzhTheme } from './themes';

/**
 * Markdown 排版：
 *  - formatMarkdown：纯规则化（正则 + 字符串），不调 LLM。
 *    保留原有规则 + 新增全角标点转换（跳过代码块）+ 超长段拆分。
 *  - smartFormatWithLLM：可选的 LLM 辅助排版（长段拆分 / 关键词高亮 / 章节编号）。
 *  - markdownToWechatHtml：把 Markdown 转成公众号可用的内联样式 HTML。
 *
 * fenced 代码块内容原样保留，不参与改写。
 */

// ---------------------------------------------------------------------------
// 原有纯正则规则（保留）
// ---------------------------------------------------------------------------

interface Line {
  raw: string;
  isCodeFence: boolean;
  inCode: boolean;
  type: 'blank' | 'heading' | 'list' | 'blockquote' | 'code' | 'paragraph' | 'other';
}

function classify(line: string, inCode: boolean): Line {
  const t = line.trim();
  if (inCode) {
    return { raw: line, isCodeFence: false, inCode: true, type: 'code' };
  }
  if (/^\s*(```|~~~)/.test(line)) {
    return { raw: line, isCodeFence: true, inCode: true, type: 'code' };
  }
  if (t === '') return { raw: line, isCodeFence: false, inCode: false, type: 'blank' };
  const h = /^(#{1,6})\s+\S/.exec(line);
  if (h) return { raw: line, isCodeFence: false, inCode: false, type: 'heading' };
  if (/^\s*>/.test(line)) return { raw: line, isCodeFence: false, inCode: false, type: 'blockquote' };
  if (/^\s*([-*+]|\d+\.)\s+\S/.test(line)) return { raw: line, isCodeFence: false, inCode: false, type: 'list' };
  return { raw: line, isCodeFence: false, inCode: false, type: 'paragraph' };
}

/** 提取标题级别；非标题返回 0 */
function headingLevel(line: string): number {
  const m = /^(#{1,6})(?:\s|$)/.exec(line);
  return m ? m[1].length : 0;
}

/** 把加粗标记内的首尾空格去掉：**  foo ** -> **foo** */
function trimBoldSpaces(text: string): string {
  return text.replace(/\*\*\s+([^*]+?)\s+\*\*/g, '**$1**');
}

/** 列表行：tab 转 2 空格，行尾去空白，标记后保留单空格 */
function normalizeList(line: string): string {
  const m = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/.exec(line);
  if (!m) return line.replace(/\s+$/, '');
  const indent = m[1].replace(/\t/g, '  ');
  const spaces = indent.length;
  const rounded = Math.round(spaces / 2) * 2;
  return `${' '.repeat(rounded)}${m[2]} ${m[4].replace(/\s+$/, '')}`;
}

/** 标题层级规整：最小标题级对齐到 #，且不允许向下跳级超过 1 */
function normalizeHeadings(lines: Line[]): void {
  const levels: number[] = [];
  for (const ln of lines) {
    if (ln.type === 'heading') levels.push(headingLevel(ln.raw));
  }
  if (levels.length === 0) return;
  const base = Math.min(...levels);
  const shift = base - 1;
  let prev = 0;
  for (const ln of lines) {
    if (ln.type !== 'heading') continue;
    let lv = headingLevel(ln.raw) - shift;
    if (prev > 0 && lv > prev + 1) lv = prev + 1;
    if (lv < 1) lv = 1;
    if (lv > 6) lv = 6;
    ln.raw = ln.raw.replace(/^#{1,6}(\s+)/, '#'.repeat(lv) + '$1');
    prev = lv;
  }
}

// ---------------------------------------------------------------------------
// 新增：全角标点转换（跳过代码块 / 行内代码 / 链接 URL）
// ---------------------------------------------------------------------------

const CJK = '\u4e00-\u9fff';

/**
 * 把正文里的半角逗号/句号转成全角。
 * 仅当中文相邻时转换，避免破坏 URL、数字小数、代码。
 * 代码块 fence 内整体跳过。
 */
function convertFullWidthPunct(text: string): string {
  return text
    // 半角逗号：前后至少一侧是中文 → 全角逗号
    .replace(new RegExp(`(?<=[${CJK}])\\s*,\\s*(?=[${CJK}])`, 'g'), '，')
    // 半角句号：前面是中文、后面是中文/空白/行尾 → 全角句号
    .replace(new RegExp(`(?<=[${CJK}])\\.(?=[\\s${CJK}]|$)`, 'g'), '。');
}

/** 按行处理，跳过 fenced code block 内部 */
function applyFullWidthOutsideCode(md: string): string {
  const lines = md.split('\n');
  let inCode = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      out.push(line);
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    out.push(convertFullWidthPunct(line));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 新增：超长段落拆分（>150 字在中间最近的句号/分号处拆两段）
// ---------------------------------------------------------------------------

function splitLongParagraphs(md: string, maxLen = 150): string {
  // 按空行切块
  const blocks = md.split(/(\n\s*\n)/);
  const out: string[] = [];
  for (const block of blocks) {
    // 分隔符原样保留
    if (/^\s*$/.test(block)) {
      out.push(block);
      continue;
    }
    // 跳过代码块 / 标题 / 列表 / 引用
    const trimmed = block.trim();
    if (
      /^(```|~~~|#{1,6}\s|>|\s*[-*+]\s|\s*\d+\.\s)/m.test(trimmed)
    ) {
      out.push(block);
      continue;
    }
    // 去除 markdown 标记后纯文本长度
    const plainLen = trimmed.replace(/[#*>`\[\]()!_-]/g, '').length;
    if (plainLen <= maxLen) {
      out.push(block);
      continue;
    }
    // 找中间附近的句号/分号
    const mid = Math.floor(block.length / 2);
    let best = -1;
    for (let i = mid; i < block.length; i++) {
      const ch = block[i];
      if (ch === '。' || ch === '；' || ch === ';' || ch === '！' || ch === '!') {
        best = i + 1;
        break;
      }
    }
    if (best < 0) {
      for (let i = mid; i >= 0; i--) {
        const ch = block[i];
        if (ch === '。' || ch === '；' || ch === ';' || ch === '！' || ch === '!') {
          best = i + 1;
          break;
        }
      }
    }
    if (best <= 0 || best >= block.length - 1) {
      out.push(block);
      continue;
    }
    const left = block.slice(0, best).trimEnd();
    const right = block.slice(best).trimStart();
    out.push(`${left}\n\n${right}`);
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// 对外主入口：纯正则排版
// ---------------------------------------------------------------------------

export function formatMarkdown(md: string): string {
  if (!md) return md;
  const normalized = md.replace(/\r\n?/g, '\n');
  const srcLines = normalized.split('\n');

  let inCode = false;
  const lines: Line[] = [];
  for (const raw of srcLines) {
    const isFence = /^\s*(```|~~~)/.test(raw);
    const line = classify(raw, inCode);
    lines.push(line);
    if (isFence) inCode = !inCode;
  }

  for (const ln of lines) {
    if (ln.inCode) {
      ln.raw = ln.raw.replace(/\s+$/, '');
      continue;
    }
    if (ln.type === 'list') {
      ln.raw = normalizeList(ln.raw);
    } else if (ln.type === 'heading' || ln.type === 'paragraph' || ln.type === 'blockquote') {
      ln.raw = trimBoldSpaces(ln.raw.replace(/\s+$/, ''));
    } else if (ln.type === 'blank') {
      ln.raw = '';
    }
  }

  normalizeHeadings(lines);

  const out: Line[] = [];
  const needBlankBefore = (i: number): boolean => {
    const cur = lines[i];
    if (!cur || cur.inCode) return false;
    if (cur.type === 'blockquote' || cur.type === 'code' || cur.type === 'heading') {
      const prev = out[out.length - 1];
      if (prev && prev.type !== 'blank' && !prev.inCode) return true;
    }
    return false;
  };
  const needBlankAfter = (i: number): boolean => {
    const cur = lines[i];
    if (!cur || cur.inCode) return false;
    const next = lines[i + 1];
    if (!next) return false;
    if (cur.type === 'blockquote' || cur.type === 'code') {
      if (next.type !== 'blank') return true;
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    if (needBlankBefore(i)) out.push({ raw: '', isCodeFence: false, inCode: false, type: 'blank' });
    out.push(lines[i]);
    if (needBlankAfter(i)) out.push({ raw: '', isCodeFence: false, inCode: false, type: 'blank' });
  }

  const folded: string[] = [];
  let blankRun = 0;
  for (const ln of out) {
    if (ln.type === 'blank') {
      blankRun++;
      if (blankRun <= 1) folded.push('');
    } else {
      blankRun = 0;
      folded.push(ln.raw);
    }
  }
  while (folded.length && folded[0] === '') folded.shift();
  while (folded.length && folded[folded.length - 1] === '') folded.pop();

  let result = folded.join('\n') + '\n';
  // 新增：全角标点 + 长段拆分
  result = applyFullWidthOutsideCode(result);
  result = splitLongParagraphs(result, 150);
  return result;
}

// ---------------------------------------------------------------------------
// LLM 辅助智能排版
// ---------------------------------------------------------------------------

/**
 * 调 LLM 做智能排版：
 *  - 长段拆分（≤150 字/段）
 *  - 关键词高亮（每段 1-3 个核心短语用 ==高亮==）
 *  - 二级标题 ## 自动加 01/02/03 前缀
 */
export async function smartFormatWithLLM(md: string, settings: CowriteSettings): Promise<string> {
  const system =
    '你是一名中文 Markdown 排版编辑。用户会给你一段 Markdown 正文。请直接输出排版后的完整 Markdown（不要解释、不要代码块包裹）。' +
    '要求：' +
    '1) 把超过 150 字的段落拆成多段，每段不超过 150 字；' +
    '2) 每段挑选 1-3 个核心短语，用 ==高亮== 包裹（Obsidian 高亮语法）；' +
    '3) 二级标题（## 开头）自动加两位序号前缀，例如 "## 01 引言"、"## 02 正文"；' +
    '4) 代码块、图片语法、链接 URL 原样保留，不要改动；' +
    '5) 不要删除原文内容，不要新增段落，只做排版加工。';
  return await chatComplete(
    settings,
    [
      { role: 'system', content: system },
      { role: 'user' as const, content: md },
    ],
    { temperature: 0.3, maxTokens: settings.maxTokens },
  );
}

// ---------------------------------------------------------------------------
// Markdown → 公众号内联样式 HTML（gzh-design 主题化）
// ---------------------------------------------------------------------------

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 处理行内样式：图片、链接、加粗、斜体、行内代码、高亮；全部按主题变量内联 */
function inlineHtml(text: string, t: GzhTheme): string {
  let s = escapeHtml(text);
  // 图片 ![alt](src)
  s = s.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    `<img src="$2" alt="$1" style="max-width: 100%; height: auto; display: block; margin: 1em auto;" />`,
  );
  // 链接 [text](url)
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    `<a href="$2" style="color: ${t.accent}; text-decoration: none;">$1</a>`,
  );
  // 高亮 ==text==
  s = s.replace(
    /==([^=\n]+)==/g,
    `<mark style="background: #fff3a3; padding: 0 2px;">$1</mark>`,
  );
  // 加粗 **text**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, `<strong style="font-weight: 600;">$1</strong>`);
  // 斜体 *text*
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, `$1<em>$2</em>`);
  // 行内代码 `code`
  s = s.replace(
    /`([^`\n]+)`/g,
    `<code style="background: ${t.codeBg}; padding: 0.1em 0.3em; border-radius: ${t.borderRadius}; font-size: 0.9em; color: ${t.bodyColor};">$1</code>`,
  );
  return s;
}

/**
 * 把 Markdown 转成公众号编辑器可粘贴的 HTML：
 * 所有样式内联，无 class/id；外层包一个 <section>，按 themeId 选主题变量。
 * 默认主题 graphite-minimal。
 */
export function markdownToWechatHtml(md: string, themeId?: string): string {
  const t = getTheme(themeId || 'graphite-minimal');
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let inCode = false;
  let listOpen: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listOpen) {
      html.push(`</${listOpen}>`);
      listOpen = null;
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (/^\s*(```|~~~)/.test(line)) {
      closeList();
      inCode = !inCode;
      if (inCode) {
        html.push(
          `<pre style="margin: 1em 0; padding: 1em; background: ${t.codeBg}; border-radius: ${t.borderRadius}; overflow-x: auto; font-size: 14px; line-height: 1.6; color: ${t.bodyColor};"><code>${escapeHtml(line.replace(/^\s*(```|~~~)/, ''))}\n`,
        );
      } else {
        html.push('</code></pre>');
      }
      continue;
    }
    if (inCode) {
      html.push(escapeHtml(line) + '\n');
      continue;
    }

    const tr = line.trim();
    if (tr === '') {
      closeList();
      continue;
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(tr)) {
      closeList();
      html.push(
        `<hr style="border: none; border-top: 1px solid ${t.borderColor}; margin: 2em 0;" />`,
      );
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(tr);
    if (h) {
      closeList();
      const level = Math.min(6, h[1].length);
      const fontSize = level === 1 ? 22 : level === 2 ? 20 : level === 3 ? 18 : 16;
      let style: string;
      if (level === 1 || level === 2) {
        style = `color: ${t.headingColor}; border-left: 4px solid ${t.accent}; padding-left: 0.5em; margin: 1.5em 0 0.5em; font-weight: 600; font-size: ${fontSize}px;`;
      } else {
        style = `color: ${t.headingColor}; margin: 1.2em 0 0.5em; font-weight: 600; font-size: ${fontSize}px;`;
      }
      html.push(`<h${level} style="${style}">${inlineHtml(h[2], t)}</h${level}>`);
      continue;
    }

    // 引用
    if (/^>\s?/.test(tr)) {
      closeList();
      const inner = tr.replace(/^>\s?/, '');
      html.push(
        `<blockquote style="background: ${t.quoteBg}; border-left: 3px solid ${t.accent}; padding: 0.5em 1em; margin: 1em 0; color: ${t.mutedColor}; border-radius: ${t.borderRadius};">${inlineHtml(inner, t)}</blockquote>`,
      );
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(tr)) {
      if (listOpen !== 'ul') {
        closeList();
        html.push(
          `<ul style="padding-left: 1.5em; margin: 1em 0; color: ${t.bodyColor}; line-height: 1.75;">`,
        );
        listOpen = 'ul';
      }
      const inner = tr.replace(/^[-*+]\s+/, '');
      html.push(`<li style="margin: 0.25em 0;">${inlineHtml(inner, t)}</li>`);
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(tr)) {
      if (listOpen !== 'ol') {
        closeList();
        html.push(
          `<ol style="padding-left: 1.5em; margin: 1em 0; color: ${t.bodyColor}; line-height: 1.75;">`,
        );
        listOpen = 'ol';
      }
      const inner = tr.replace(/^\d+\.\s+/, '');
      html.push(`<li style="margin: 0.25em 0;">${inlineHtml(inner, t)}</li>`);
      continue;
    }

    // 普通段落
    closeList();
    html.push(
      `<p style="color: ${t.bodyColor}; margin: 0 0 1em; line-height: 1.75; font-size: 16px;">${inlineHtml(tr, t)}</p>`,
    );
  }
  closeList();
  if (inCode) html.push('</code></pre>');

  const inner = html.join('\n');
  return `<section style="font-family: ${FONT_STACK}; line-height: 1.75; font-size: 16px; color: ${t.bodyColor}; margin: 0; padding: 0;">\n${inner}\n</section>`;
}
