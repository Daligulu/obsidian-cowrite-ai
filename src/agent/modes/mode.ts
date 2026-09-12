/** Agent 模式（Roo Code 设计）：决定哪些工具可用、哪些写操作需要审批 */
export interface AgentMode {
  id: string;
  label: string;
  /** 允许的工具名白名单；含 '*' 表示全开 */
  toolAllowlist: string[];
  /** 该工具是否需要用户审批后才执行 */
  requireApproval(toolName: string): boolean;
}
