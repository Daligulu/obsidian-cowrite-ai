import { TFile } from 'obsidian';
import { z } from 'zod';
import { defineTool } from '../defineTool';

/**
 * 搜索 vault：遍历 Markdown 文件做大小写不敏感子串匹配。
 * 不依赖 Obsidian 内部 Search 类，移动端可用。
 */
export const searchVaultTool = defineTool({
  name: 'search_vault',
  description:
    '在整个 vault 的 Markdown 笔记里全文搜索关键字（大小写不敏感子串匹配）。' +
    '返回命中的文件路径与每处命中的前后 120 字符片段。',
  parameters: z.object({
    query: z.string().describe('搜索关键字或短语'),
    limit: z.number().int().positive().optional().describe('最多返回几条结果，默认 10'),
  }),
  async execute(args, ctx) {
    const query = (args.query || '').trim();
    if (!query) return { ok: false, error: 'query 不能为空' };
    const limit = args.limit ?? 10;
    const q = query.toLowerCase();

    const files = ctx.vault.getMarkdownFiles();
    const hits: Array<{ path: string; snippet: string; chars: number }> = [];
    for (const file of files) {
      if (hits.length >= limit) break;
      let content = '';
      try {
        content = await ctx.vault.cachedRead(file);
      } catch {
        continue;
      }
      const idx = content.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 60);
      const end = Math.min(content.length, idx + q.length + 60);
      const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
      hits.push({ path: file.path, snippet, chars: content.length });
    }
    return { ok: true, query, total: hits.length, hits };
  },
  render(args, result, el) {
    el.addClass('cowrite-tool-result');
    el.createEl('div', { cls: 'cowrite-tool-name', text: `🔍 搜索：${args.query}（${result.total ?? 0} 条）` });
    if (Array.isArray(result.hits)) {
      for (const hit of result.hits.slice(0, 8)) {
        const row = el.createDiv({ cls: 'cowrite-tool-hit' });
        row.createEl('div', { cls: 'cowrite-tool-hit-path', text: hit.path });
        row.createEl('div', { cls: 'cowrite-tool-hit-snippet', text: hit.snippet });
      }
    }
  },
});
