import { TFile } from 'obsidian';
import { z } from 'zod';
import { defineTool } from '../defineTool';

/** 读笔记：按 vault 内相对路径读取 Markdown 完整内容（超长截断） */
export const readNoteTool = defineTool({
  name: 'read_note',
  description:
    '读取 vault 内某篇 Markdown 笔记的完整内容。路径为 vault 内相对路径（如 "Cowrite/示例.md"）。' +
    '如果笔记很长，会截断到 maxChars 字符。',
  parameters: z.object({
    path: z.string().describe('笔记在 vault 内的相对路径，如 "Cowrite/示例.md"'),
    maxChars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('最大返回字符数，默认 8000'),
  }),
  async execute(args, ctx) {
    const file = ctx.vault.getAbstractFileByPath(args.path);
    if (!(file instanceof TFile)) {
      return { ok: false, error: `笔记不存在：${args.path}` };
    }
    const raw = await ctx.vault.cachedRead(file);
    const max = args.maxChars ?? 8000;
    const truncated = raw.length > max;
    return {
      ok: true,
      path: args.path,
      length: raw.length,
      truncated,
      content: truncated ? raw.slice(0, max) : raw,
    };
  },
  render(args, result, el) {
    el.addClass('cowrite-tool-result');
    el.createEl('div', { cls: 'cowrite-tool-name', text: `📄 读取：${args.path}` });
    const meta = el.createEl('div', { cls: 'cowrite-tool-meta' });
    meta.setText(`长度 ${result.length ?? 0} 字符${result.truncated ? '（已截断）' : ''}`);
    const pre = el.createEl('pre', { cls: 'cowrite-tool-preview' });
    pre.setText((result.content ?? '').slice(0, 1200));
  },
});
