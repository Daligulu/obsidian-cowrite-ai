import { TFile } from 'obsidian';
import { z } from 'zod';
import { defineTool } from '../defineTool';

/** 追加段落：在笔记末尾追加一个新标题段落（write 模式下需审批） */
export const appendNoteTool = defineTool({
  name: 'append_note',
  description:
    '在一篇笔记末尾追加一段内容。可选指定一个二级标题作为新段落的标题。' +
    '不会覆盖已有内容，比 write_note 安全。',
  parameters: z.object({
    path: z.string().describe('目标笔记在 vault 内的相对路径'),
    heading: z.string().optional().describe('可选：新段落的二级标题，不填则直接追加正文'),
    content: z.string().describe('要追加的 Markdown 正文'),
  }),
  async execute(args, ctx) {
    const file = ctx.vault.getAbstractFileByPath(args.path);
    if (!(file instanceof TFile)) {
      return { ok: false, error: `笔记不存在：${args.path}` };
    }
    const existing = await ctx.vault.cachedRead(file);
    const block = args.heading ? `\n\n## ${args.heading}\n\n${args.content}` : `\n\n${args.content}`;
    const next = existing.replace(/\s+$/, '') + block;
    try {
      await ctx.vault.modify(file, next);
      return { ok: true, path: args.path, appended: block.length, total: next.length };
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e) };
    }
  },
  render(args, result, el) {
    el.addClass('cowrite-tool-result');
    const head = el.createEl('div', { cls: result.ok ? 'cowrite-tool-name' : 'cowrite-tool-error' });
    head.setText(result.ok ? `➕ 追加：${args.path}${args.heading ? ` · ${args.heading}` : ''}` : '❌ 追加失败');
    if (result.ok) {
      el.createEl('div', { cls: 'cowrite-tool-meta', text: `新增 ${result.appended} 字符（全文 ${result.total}）` });
    } else {
      el.createEl('div', { cls: 'cowrite-tool-error', text: String(result.error || '') });
    }
  },
});
