import { Vault } from 'obsidian';

/**
 * 长期记忆（借鉴 Mastra observational memory）。
 * 存储：<vault>/agent/memory.md，bullet list 形态。
 * 用 vault.adapter 绕开 iOS 索引延迟。
 */
export class MemoryStore {
  private vault: Vault;
  private memoryPath = 'agent/memory.md';

  constructor(vault: Vault) {
    this.vault = vault;
  }

  /** 读取所有 observation 条目 */
  async list(): Promise<string[]> {
    let raw: string;
    try {
      raw = await this.vault.adapter.read(this.memoryPath);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('- ')) continue;
      const body = trimmed.replace(/^-\s+(\d{4}-\d{2}-\d{2}:\s*)?/, '').trim();
      if (body) out.push(body);
    }
    return out;
  }

  /** 追加若干条 observation */
  async append(observations: string[]): Promise<void> {
    const clean = observations
      .map((s) => (s || '').trim())
      .filter((s) => s.length > 0 && s.length < 200)
      .slice(0, 5);
    if (clean.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);
    const lines = clean.map((o) => `- ${today}: ${o}`).join('\n') + '\n';

    try {
      await this.vault.adapter.mkdir('agent');
    } catch {}

    let existing = '';
    try {
      existing = await this.vault.adapter.read(this.memoryPath);
    } catch {}

    if (!existing) {
      await this.vault.adapter.write(this.memoryPath, `# Cowrite AI 长期记忆\n\n${lines}`);
    } else {
      await this.vault.adapter.write(this.memoryPath, existing + lines);
    }
  }

  /** 按关键词做简单全文匹配 */
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
    if (hit.length === 0) return all.slice(-3);
    return hit.slice(-6);
  }
}
