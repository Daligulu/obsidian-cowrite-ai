import type { AgentMode } from './mode';
import { ASK_MODE } from './ask';
import { WRITE_MODE } from './write';

export type { AgentMode } from './mode';
export { ASK_MODE } from './ask';
export { WRITE_MODE } from './write';

/** 根据 id 取模式；未知 id 回退到 write */
export function getMode(id: string): AgentMode {
  if (id === 'ask') return ASK_MODE;
  return WRITE_MODE;
}
