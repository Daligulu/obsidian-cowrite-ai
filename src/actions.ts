import { Notice, TFile, Vault } from 'obsidian';
import { ActionConfig, ActionConfigFile, DEFAULT_ACTIONS } from './types';

/**
 * 动作配置：<vault>/.cowrite/actions.json
 * 动作 → 内置 prompt 模板，供投递任务选择与内置执行器调用 LLM 时使用。
 */
export class ActionStore {
  constructor(
    private vault: Vault,
    private actionsFile: string,
  ) {}

  /** 读取动作列表；文件不存在或损坏时回退默认动作集 */
  async list(): Promise<ActionConfig[]> {
    const file = this.vault.getAbstractFileByPath(this.actionsFile);
    if (!(file instanceof TFile)) return [...DEFAULT_ACTIONS];
    try {
      const raw = await this.vault.cachedRead(file);
      const data = JSON.parse(raw) as ActionConfigFile;
      if (Array.isArray(data?.actions) && data.actions.length > 0) return data.actions;
      return [...DEFAULT_ACTIONS];
    } catch (e) {
      console.error('Cowrite AI: failed to parse actions.json', e);
      return [...DEFAULT_ACTIONS];
    }
  }

  /** 写入动作配置（含父目录） */
  async save(actions: ActionConfig[]): Promise<void> {
    try {
      const existing = this.vault.getAbstractFileByPath(this.actionsFile);
      if (!(existing instanceof TFile)) {
        const parent = this.actionsFile.split('/').slice(0, -1).join('/');
        if (parent && !this.vault.getAbstractFileByPath(parent)) {
          await this.vault.createFolder(parent);
        }
        await this.vault.create(this.actionsFile, '');
      }
      const file = this.vault.getAbstractFileByPath(this.actionsFile);
      if (file instanceof TFile) {
        const data: ActionConfigFile = { version: 1, updatedAt: new Date().toISOString(), actions };
        await this.vault.modify(file, JSON.stringify(data, null, 2));
      }
    } catch (e) {
      new Notice(`Cowrite AI: 保存动作配置失败 ${String(e)}`);
    }
  }

  /** 按 id 查动作 */
  async get(id: string): Promise<ActionConfig | undefined> {
    const actions = await this.list();
    return actions.find((a) => a.id === id);
  }
}
