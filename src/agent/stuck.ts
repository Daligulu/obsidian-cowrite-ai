/**
 * 循环检测（stuck detector）。
 * - 同一个 (toolName, args) 组合重复执行 ≥ 3 次 → 判定原地打转
 * - 连续 ≥ 3 条 assistant 消息都不再调工具 → 判定模型卡壳
 * 检测到即抛错，由 loop 捕获后终止并往事件流推 error。
 */
export class StuckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StuckError';
  }
}

export class StuckDetector {
  /** 同一工具+参数组合的出现次数 */
  private toolCallCounts = new Map<string, number>();
  /** 连续无 tool_calls 的 assistant 消息数 */
  private noToolCallStreak = 0;
  /** 触发阈值 */
  private readonly repeatLimit = 3;
  private readonly noToolLimit = 3;

  private hashToolCall(name: string, args: unknown): string {
    let argsStr = '';
    try {
      argsStr = typeof args === 'string' ? args : JSON.stringify(args);
    } catch {
      argsStr = String(args);
    }
    return `${name}::${argsStr}`;
  }

  /** 每次工具调用前调用；重复超限则抛 StuckError */
  recordToolCall(name: string, args: unknown): void {
    const key = this.hashToolCall(name, args);
    const count = (this.toolCallCounts.get(key) ?? 0) + 1;
    this.toolCallCounts.set(key, count);
    // 执行了一个工具调用 = 这一轮有动作，清零无工具连续计数
    this.noToolCallStreak = 0;
    if (count >= this.repeatLimit) {
      throw new StuckError(`Agent 在原地打转：工具 ${name} 用相同参数已连续执行 ${count} 次，终止。`);
    }
  }

  /** 每个 assistant turn 结束后调用；hasToolCall 表示本轮是否发起了工具调用 */
  recordAssistantTurn(hasToolCall: boolean): void {
    if (hasToolCall) {
      this.noToolCallStreak = 0;
      return;
    }
    this.noToolCallStreak += 1;
    if (this.noToolCallStreak >= this.noToolLimit) {
      throw new StuckError('Agent 连续多次不再调用工具，可能已卡壳，终止。');
    }
  }

  reset(): void {
    this.toolCallCounts.clear();
    this.noToolCallStreak = 0;
  }
}
