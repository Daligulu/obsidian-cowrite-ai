/**
 * Markdown 排版：纯规则化处理（正则 + 字符串），不调 LLM。
 * 处理：标题层级不跳级、列表缩进统一、引用块前后空行、加粗内空格规范、段落间空行、代码块前后空行。
 *  fenced 代码块内容原样保留，不参与改写。
 */

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
  // 缩进统一按 2 的倍数
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
  const shift = base - 1; // 让最小级变成 1
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

export function formatMarkdown(md: string): string {
  if (!md) return md;
  // 统一换行
  const normalized = md.replace(/\r\n?/g, '\n');
  const srcLines = normalized.split('\n');

  // 1) 逐行分类（跟踪代码块）
  let inCode = false;
  const lines: Line[] = [];
  for (const raw of srcLines) {
    const isFence = /^\s*(```|~~~)/.test(raw);
    const line = classify(raw, inCode);
    lines.push(line);
    if (isFence) inCode = !inCode;
  }

  // 2) 行级规整（代码块内部不动）
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

  // 3) 标题层级
  normalizeHeadings(lines);

  // 4) 插入必要空行：引用块、代码块前后
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

  // 5) 段落间空行：把连续的 paragraph 行合并为块，块之间保证一个空行
  //    （标题/列表/引用/代码块天然分隔；这里只处理连续 paragraph 之间的多余压缩）
  // 6) 折叠连续空行（>1 个空行压成 1 个），并去掉首尾空行
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

  return folded.join('\n') + '\n';
}
