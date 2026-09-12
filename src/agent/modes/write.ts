import type { AgentMode } from './mode';

/** 创作模式（write）：全开工具；写操作需要审批 */
export const WRITE_MODE: AgentMode = {
  id: 'write',
  label: '创作',
  toolAllowlist: ['*'],
  requireApproval: (toolName: string) =>
    toolName === 'write_note' || toolName === 'append_note' || toolName === 'insert_image',
};
