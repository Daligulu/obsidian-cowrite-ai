import type { AgentTool } from '../defineTool';
import { readNoteTool } from './readNote';
import { writeNoteTool } from './writeNote';
import { appendNoteTool } from './appendNote';
import { searchVaultTool } from './searchVault';
import { listNotesTool } from './listNotes';
import { insertImageTool } from './insertImage';

/** 全部内置工具注册表 */
export const allTools: AgentTool[] = [
  readNoteTool,
  writeNoteTool,
  appendNoteTool,
  searchVaultTool,
  listNotesTool,
  insertImageTool,
];

/** 按名字查工具（O(n)，工具数量少够用） */
export function findTool(name: string): AgentTool | undefined {
  return allTools.find((t) => t.name === name);
}
