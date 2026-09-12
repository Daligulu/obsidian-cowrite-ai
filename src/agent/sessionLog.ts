import { Vault } from 'obsidian';
import type { ChatMessage } from './providers/llm';

/**
 * 会话日志：append-only JSONL，存到 <vault>/.cowrite/sessions/<taskId>.jsonl。
 * 用 vault.adapter 绕开 iOS Obsidian 对隐藏路径的索引延迟。
 */

/** 会话内记录类型（持久化到 JSONL 的形态） */
export type SessionRecord =
  | { kind: 'user'; text: string; ts: string }
  | {
      kind: 'assistant';
      text: string;
      toolCalls?: Array<{ id: string; name: string; args: any; argsRaw: string }>;
      ts: string;
    }
  | { kind: 'tool'; callId: string; name: string; result: string; isError: boolean; ts: string }
  | { kind: 'system-note'; text: string; ts: string };

export class SessionLog {
  private vault: Vault;
  private filePath: string;

  constructor(vault: Vault, taskId: string) {
    this.vault = vault;
    this.filePath = `.cowrite/sessions/${taskId}.jsonl`;
  }

  /** 追加一条记录（read-modify-write，文件不存在则创建） */
  async append(record: SessionRecord): Promise<void> {
    await this.ensureFile();
    let raw = '';
    try {
      raw = await this.vault.adapter.read(this.filePath);
    } catch {
      raw = '';
    }
    await this.vault.adapter.write(this.filePath, raw + JSON.stringify(record) + '\n');
  }

  /** 读取全部记录（损坏行跳过） */
  async readAll(): Promise<SessionRecord[]> {
    let raw: string;
    try {
      raw = await this.vault.adapter.read(this.filePath);
    } catch {
      return [];
    }
    const out: SessionRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as SessionRecord);
      } catch {
        // 损坏行跳过
      }
    }
    return out;
  }

  /**
   * 从记录派生 OpenAI 兼容消息历史。
   */
  async deriveModelHistory(): Promise<ChatMessage[]> {
    const records = await this.readAll();
    const messages: ChatMessage[] = [];
    for (const rec of records) {
      switch (rec.kind) {
        case 'user':
          messages.push({ role: 'user', content: rec.text });
          break;
        case 'assistant': {
          const msg: ChatMessage = { role: 'assistant', content: rec.text || '' };
          if (Array.isArray(rec.toolCalls) && rec.toolCalls.length > 0) {
            msg.tool_calls = rec.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.argsRaw || '{}' },
            }));
          }
          messages.push(msg);
          break;
        }
        case 'tool':
          messages.push({
            role: 'tool',
            tool_call_id: rec.callId,
            name: rec.name,
            content: rec.result,
          });
          break;
        case 'system-note':
          messages.push({ role: 'system', content: rec.text });
          break;
      }
    }
    return messages;
  }

  /** 确保会话文件存在（含父目录），用 vault.adapter */
  private async ensureFile(): Promise<void> {
    const parent = this.filePath.split('/').slice(0, -1).join('/');
    if (parent) {
      try {
        await this.vault.adapter.mkdir(parent);
      } catch {
        // 已存在忽略
      }
    }
    const exists = await this.vault.adapter.exists(this.filePath);
    if (!exists) {
      await this.vault.adapter.write(this.filePath, '');
    }
  }
}
