import { Notice, TFile, Vault } from 'obsidian';

/**
 * 页面 = vault 内 Markdown 笔记文件（默认 Cowrite/ 目录）。
 * 内容即笔记正文；标题即文件名。内置执行器直接读写这些文件完成写回。
 */
export class PageStore {
  constructor(
    private vault: Vault,
    private pagesDir: string,
  ) {}

  /** 页面目录（vault 内相对路径，规范化） */
  dir(): string {
    return this.pagesDir.replace(/^\/+|\/+$/g, '') || 'Cowrite';
  }

  /** 列出页面目录下所有 Markdown 文件 */
  async list(): Promise<TFile[]> {
    await this.ensureDir();
    const dir = this.vault.getAbstractFileByPath(this.dir());
    if (!dir) return [];
    const files = this.vault.getMarkdownFiles();
    const prefix = this.dir() + '/';
    return files
      .filter((f) => f.path.startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  /** 按路径查找 TFile */
  getByPath(path: string): TFile | null {
    const f = this.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  /** 创建页面（title 作为文件名，返回 TFile；已存在则提示） */
  async create(title: string, content = ''): Promise<TFile | null> {
    await this.ensureDir();
    const safeTitle = title.trim() || '未命名';
    const path = `${this.dir()}/${safeTitle}.md`;
    if (this.vault.getAbstractFileByPath(path)) {
      new Notice(`Cowrite AI: 页面已存在（${path}）`);
      return null;
    }
    try {
      const file = await this.vault.create(path, content || `# ${safeTitle}\n\n`);
      new Notice(`Cowrite AI: 已创建页面 ${safeTitle}`);
      return file;
    } catch (e) {
      new Notice(`Cowrite AI: 创建页面失败 ${String(e)}`);
      return null;
    }
  }

  /** 读取页面内容 */
  async read(file: TFile): Promise<string> {
    try {
      return await this.vault.cachedRead(file);
    } catch (e) {
      console.error('Cowrite AI: read page failed', file.path, e);
      return '';
    }
  }

  /** 写回页面内容（整体替换） */
  async write(file: TFile, content: string): Promise<boolean> {
    try {
      await this.vault.modify(file, content);
      return true;
    } catch (e) {
      console.error('Cowrite AI: write page failed', file.path, e);
      return false;
    }
  }

  /** 删除页面（进系统回收站，可恢复） */
  async trash(file: TFile): Promise<boolean> {
    try {
      await this.vault.trash(file, true);
      new Notice(`Cowrite AI: 已删除页面 ${file.name}`);
      return true;
    } catch (e) {
      new Notice(`Cowrite AI: 删除页面失败 ${String(e)}`);
      return false;
    }
  }

  /** 确保页面目录存在 */
  private async ensureDir(): Promise<void> {
    const dir = this.dir();
    if (!this.vault.getAbstractFileByPath(dir)) {
      try {
        await this.vault.createFolder(dir);
      } catch (e) {
        console.error('Cowrite AI: ensure pages dir failed', e);
      }
    }
  }
}
