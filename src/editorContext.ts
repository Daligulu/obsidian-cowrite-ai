import { App, Editor, MarkdownView, TFile } from 'obsidian';

/**
 * 当前编辑器上下文：获取选中文本 / 全文，以及替换回去。
 * 纯 Obsidian API，移动端可用。
 */

/** 当前选中文本（未选中返回空串） */
export function getSelection(app: App): string {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) return '';
  return view.editor.getSelection();
}

/** 当前打开笔记全文 + 文件对象 */
export async function getFullText(app: App): Promise<{ file: TFile; content: string } | null> {
  const file = app.workspace.getActiveFile();
  if (!file) return null;
  const content = await app.vault.cachedRead(file);
  return { file, content };
}

/** 替换选中文本（焦点仍在编辑器内） */
export function replaceSelection(app: App, newText: string): void {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) return;
  const editor: Editor = view.editor;
  editor.replaceSelection(newText);
}

/** 替换整篇笔记内容 */
export async function replaceFullText(app: App, file: TFile, newContent: string): Promise<void> {
  await app.vault.modify(file, newContent);
}
