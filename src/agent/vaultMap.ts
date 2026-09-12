import { TFile, Vault } from 'obsidian';

/**
 * Markdown vault map（借鉴 Aider repo map）。
 * 遍历 vault 内所有 Markdown，提取标题层级与 [[双链]]，建有向图；
 * 以当前打开笔记为 seed 跑 BFS 个性化排序，在 token 预算内选 top N 笔记，
 * 渲染成树形文本塞进 system prompt。
 * 缓存到 .cowrite/vault-map.json，后台懒构建，vault 变更即失效。
 */

interface VaultMapNode {
  path: string;
  basename: string;
  headings: string[];
  /** 从本笔记出发指向的其他笔记（按 basename 匹配） */
  links: string[];
}

interface CacheShape {
  builtAt: string;
  nodes: VaultMapNode[];
}

const HEADING_RE = /^(#{1,3})\s+(.+?)\s*#*\s*$/gm;
const LINK_RE = /\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]/g;

export class VaultMap {
  private vault: Vault;
  private cachePath = '.cowrite/vault-map.json';
  private nodes: Map<string, VaultMapNode> = new Map();
  private building: Promise<void> | null = null;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  /** 标记缓存失效（vault 变更时调用） */
  invalidate(): void {
    this.nodes.clear();
    this.building = null;
  }

  /** 确保已构建；首次调用会读缓存，随后后台重建 */
  async ensureBuilt(): Promise<void> {
    if (this.nodes.size > 0) return;
    if (this.building) return this.building;
    this.building = this.doBuild();
    try {
      await this.building;
    } finally {
      this.building = null;
    }
  }

  /** 同步尝试从缓存加载（不阻塞首屏） */
  async loadFromCache(): Promise<boolean> {
    if (this.nodes.size > 0) return true;
    const file = this.vault.getAbstractFileByPath(this.cachePath);
    if (!(file instanceof TFile)) return false;
    try {
      const raw = await this.vault.cachedRead(file);
      const data = JSON.parse(raw) as CacheShape;
      if (Array.isArray(data.nodes)) {
        this.nodes.clear();
        for (const n of data.nodes) this.nodes.set(n.path, n);
        return this.nodes.size > 0;
      }
    } catch (e) {
      console.warn('Cowrite AI: vault map cache unreadable', e);
    }
    return false;
  }

  /** 全量重建：遍历所有 md，提取标题与双链 */
  private async doBuild(): Promise<void> {
    const files = this.vault.getMarkdownFiles();
    const next = new Map<string, VaultMapNode>();
    for (const file of files) {
      let content = '';
      try {
        content = await this.vault.cachedRead(file);
      } catch {
        continue;
      }
      const headings: string[] = [];
      HEADING_RE.lastIndex = 0;
      let hMatch: RegExpExecArray | null;
      while ((hMatch = HEADING_RE.exec(content)) !== null) {
        const level = hMatch[1].length;
        if (level >= 1 && level <= 3) {
          headings.push(Array(level).join('  ') + '# ' + hMatch[2].trim());
        }
      }

      const links: string[] = [];
      LINK_RE.lastIndex = 0;
      let lMatch: RegExpExecArray | null;
      while ((lMatch = LINK_RE.exec(content)) !== null) {
        const target = lMatch[1].trim();
        if (target) links.push(target);
      }

      next.set(file.path, {
        path: file.path,
        basename: file.basename,
        headings: headings.slice(0, 8),
        links,
      });
    }
    this.nodes = next;
    // 写缓存（异步，不阻塞）
    void this.writeCache();
  }

  private async writeCache(): Promise<void> {
    try {
      const data: CacheShape = {
        builtAt: new Date().toISOString(),
        nodes: Array.from(this.nodes.values()),
      };
      const existing = this.vault.getAbstractFileByPath(this.cachePath);
      if (existing instanceof TFile) {
        await this.vault.modify(existing, JSON.stringify(data));
      } else {
        const parent = '.cowrite';
        if (!this.vault.getAbstractFileByPath(parent)) {
          await this.vault.createFolder(parent);
        }
        await this.vault.create(this.cachePath, JSON.stringify(data));
      }
    } catch (e) {
      console.warn('Cowrite AI: write vault-map cache failed', e);
    }
  }

  /**
   * 以 seedPath 为起点 BFS 选相关笔记，在 token 预算内渲染树形文本。
   * tokenBudget 粗按 3 字符/token。
   */
  renderFor(seedPath: string | null, tokenBudget = 1024): string {
    if (this.nodes.size === 0) return '';
    const budgetChars = tokenBudget * 3;

    // 1) 找到 seed 节点
    let seed: VaultMapNode | null = null;
    if (seedPath) {
      seed = this.nodes.get(seedPath) ?? null;
      if (!seed) {
        // 按 basename 模糊匹配
        const seedBase = seedPath.replace(/\.md$/, '').split('/').pop() || '';
        if (seedBase) {
          for (const n of this.nodes.values()) {
            if (n.basename === seedBase) {
              seed = n;
              break;
            }
          }
        }
      }
    }

    // 2) BFS 收集相关节点（出度+入度权重）
    const visited = new Set<string>();
    const queue: string[] = [];
    if (seed) {
      visited.add(seed.path);
      queue.push(seed.path);
    }
    // 入度表：统计每个 basename 被多少笔记链接
    const inDegree = new Map<string, number>();
    for (const n of this.nodes.values()) {
      for (const l of n.links) {
        const key = l.replace(/\.md$/, '');
        inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
      }
    }

    const ranked: Array<{ node: VaultMapNode; depth: number }> = [];
    let depth = 0;
    while (queue.length > 0 && depth < 3) {
      const size = queue.length;
      for (let i = 0; i < size; i++) {
        const path = queue.shift()!;
        const node = this.nodes.get(path);
        if (!node) continue;
        ranked.push({ node, depth });
        // 把本节点链接出去的邻居加入队列
        for (const l of node.links) {
          const key = l.replace(/\.md$/, '');
          for (const candidate of this.nodes.values()) {
            if (visited.has(candidate.path)) continue;
            if (candidate.basename === key || candidate.path === l || candidate.path === l + '.md') {
              visited.add(candidate.path);
              queue.push(candidate.path);
            }
          }
        }
      }
      depth++;
    }

    // 3) 若 seed 为空或结果太少，补全局入度 top 节点
    if (ranked.length < 6) {
      const byInDegree = Array.from(this.nodes.values())
        .map((n) => ({ node: n, score: inDegree.get(n.basename) ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      for (const item of byInDegree) {
        if (!visited.has(item.node.path)) {
          visited.add(item.node.path);
          ranked.push({ node: item.node, depth: 9 });
        }
      }
    }

    // 4) 在预算内选 top 节点，按目录分组渲染
    const lines: string[] = ['## Vault map（与当前任务相关的笔记）'];
    let used = 0;
    const selected: VaultMapNode[] = [];
    for (const item of ranked) {
      const cost = item.node.path.length + 8 + item.node.headings.join('\n').length;
      if (used + cost > budgetChars) break;
      used += cost;
      selected.push(item.node);
    }
    // 按目录排序
    selected.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
    const byDir = new Map<string, VaultMapNode[]>();
    for (const n of selected) {
      const dir = n.path.includes('/') ? n.path.split('/').slice(0, -1).join('/') : '(根目录)';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(n);
    }
    for (const dir of Array.from(byDir.keys()).sort()) {
      lines.push(`${dir}/`);
      for (const n of byDir.get(dir)!) {
        lines.push(`  ${n.basename}.md`);
        for (const h of n.headings.slice(0, 4)) {
          lines.push(`    ${h}`);
        }
      }
    }
    return lines.join('\n');
  }
}
