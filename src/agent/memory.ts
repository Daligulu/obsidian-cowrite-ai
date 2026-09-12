import { TFile, Vault } from 'obsidian';

/**
 * 长期记忆（借鉴 Mastra observational memory）。
 * 存储：<vault>/agent/memory.md，bullet list 形态。
 * 会话结束时让模型抽 0-5 条 observation append；
 * 下次启动按当前任务关键词做简单全文匹配，命中条目注入 system prompt。
 * 不引向量库，纯字符串匹配，移动端友好。
 */
export class MemoryStore {
  private vault: Vault;
  private memoryPath = 'agent/memory.md';

  constructor(vault: Vault) {
    this.vault = vault;
  }

  /** 读取所有 observation 条目（去掉前缀 "- " 与时间戳） */
  async list(): Promise<string[]> {
    const file = this.vault.getAbstractFileByPath(this.memoryPath);
    if (!(file instanceof TFile)) return [];
    let raw: string;
    try {
      raw = await this.vault.cachedRead(file);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('- ')) continue;
      // 去掉 "- YYYY-MM-DD: " 前缀
      const body = trimmed.replace(/^-\s+(\d{4}-\d{2}-\d{2}:\s*)?/, '').trim();
      if (body) out.push(body);
    }
    return out;
  }

  /** 追加若干条 observation（带当天日期前缀） */
  async append(observations: string[]): Promise<void> {
    const clean = observations
      .map((s) => (s || '').trim())
      .filter((s) => s.length > 0 && s.length < 200)
      .slice(0, 5);
    if (clean.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);
    const lines = clean.map((o) => `- ${today}: ${o}`).join('\n') + '\n';

    const file = this.vault.getAbstractFileByPath(this.memoryPath);
    if (!(file instanceof TFile)) {
      // 首次创建：带标题
      const parent = this.memoryPath.split('/').slice(0, -1).join('/');
      if (!this.vault.getAbstractFileByPath(parent)) {
        try {
          await this.vault.createFolder(parent);
        } catch {
          // 忽略
        }
      }
      await this.vault.create(this.memoryPath, `# Cowrite AI 长期记忆\n\n${lines}`);
      return;
    }
    await this.vault.process(file, (raw) => (raw ?? '') + lines);
  }

  /**
   * 按关键词做简单全文匹配，返回命中的 observation。
   * keywords 为空时返回最近 5 条（兜底）。
   */
  async query(keywords: string[]): Promise<string[]> {
    const all = await this.list();
    if (all.length === 0) return [];
    const kws = (keywords || []).map((k) => k.toLowerCase()).filter((k) => k.length >= 2);
    if (kws.length === 0) {
      return all.slice(-5);
    }
    const hit: string[] = [];
    for (const obs of all) {
      const lower = obs.toLowerCase();
      for (const kw of kws) {
        if (lower.indexOf(kw) !== -1) {
          hit.push(obs);
          break;
        }
      }
    }
    // 命中超过 6 条取最近 6 条；没命中则兜底最近 3 条
    if (hit.length === 0) return all.slice(-3);
    return hit.slice(-6);
  }
}
