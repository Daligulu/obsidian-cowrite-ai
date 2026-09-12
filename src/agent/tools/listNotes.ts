import { TFile } from 'obsidian';
import { z } from 'zod';
import { defineTool } from '../defineTool';

/** 列出指定目录下的 Markdown 笔记（默认 Cowrite/） */
export const listNotesTool = defineTool({
  name: 'list_notes',
  description: '列出 vault 内某个目录下的所有 Markdown 笔记路径（不递归子目录内容，只列直接文件）。',
  parameters: z.object({
    dir: z.string().optional().describe('vault 内目录，默认插件配置的页面目录（Cowrite/）'),
  }),
  async execute(args, ctx) {
    const dir = (args.dir || ctx.settings?.pagesDir || 'Cowrite').replace(/^\/+|\/+$/g, '');
    const prefix = dir + '/';
    const files = ctx.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
    return {
      ok: true,
      dir,
      count: files.length,
      notes: files.map((f: TFile) => ({ path: f.path, basename: f.basename })),
    };
  },
  render(args, result, el) {
    el.addClass('cowrite-tool-result');
    el.createEl('div', { cls: 'cowrite-tool-name', text: `📁 目录：${result.dir}（${result.count ?? 0} 篇）` });
    if (Array.isArray(result.notes)) {
      for (const n of result.notes.slice(0, 20)) {
        el.createEl('div', { cls: 'cowrite-tool-meta', text: n.path });
      }
    }
  },
});
