import type { AgentMode } from './mode';

/** 问答模式（ask）：只读，只能看/搜/列笔记，不能写 */
export const ASK_MODE: AgentMode = {
  id: 'ask',
  label: '问答',
  toolAllowlist: ['read_note', 'search_vault', 'list_notes'],
  requireApproval: () => false,
};
