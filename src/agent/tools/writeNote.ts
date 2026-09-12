import { TFile } from 'obsidian';
import { z } from 'zod';
import { defineTool } from '../defineTool';

/** 覆盖写笔记：把整篇笔记替换为给定 content（write 模式下需审批） */
export const writeNoteTool = defineTool({
  name: 'write_note',
  description:
    '把一篇 Markdown 笔记整体覆盖写入 content。如果文件不存在会新建。' +
    '这是破坏性操作：原内容会被替换，请先 read_note 确认现状。',
  parameters: z.object({
    path: z.string().describe('目标笔记在 vault 内的相对路径'),
    content: z.string().describe('要写入的完整 Markdown 正文'),
  }),
  async execute(args, ctx) {
    const existing = ctx.vault.getAbstractFileByPath(args.path);
    try {
      if (existing instanceof TFile) {
        await ctx.vault.modify(existing, args.content);
      } else {
        // 确保父目录存在
        const parent = args.path.split('/').slice(0, -1).join('/');
        if (parent && !ctx.vault.getAbstractFileByPath(parent)) {
          await ctx.vault.createFolder(parent);
        }
        await ctx.vault.create(args.path, args.content);
      }
      return { ok: true, path: args.path, bytes: args.content.length, created: !(existing instanceof TFile) };
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e) };
    }
  },
  render(args, result, el) {
    el.addClass('cowrite-tool-result');
    const head = el.createEl('div', { cls: result.ok ? 'cowrite-tool-name' : 'cowrite-tool-error' });
    head.setText(result.ok ? `✍️ ${result.created ? '新建' : '覆盖写'}：${args.path}` : `❌ 写入失败`);
    if (result.ok) {
      el.createEl('div', { cls: 'cowrite-tool-meta', text: `${result.bytes} 字符` });
      const pre = el.createEl('pre', { cls: 'cowrite-tool-preview' });
      pre.setText(args.content.slice(0, 600));
    } else {
      el.createEl('div', { cls: 'cowrite-tool-error', text: String(result.error || '') });
    }
  },
});
