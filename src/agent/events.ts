/**
 * Agent 流式事件：discriminated union。
 * 由 LLMProvider 产出，经 AgentRunner 消费后转发给 UI 渲染层。
 */
export type AgentEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-start'; name: string; args: unknown }
  | { type: 'tool-end'; name: string; result: unknown; isError: boolean }
  | {
      type: 'approval-request';
      toolName: string;
      args: unknown;
      /** 由 UI 注入：用户点同意/拒绝后调用 resolve */
      resolve: (approved: boolean) => void;
    }
  | { type: 'error'; error: string }
  | { type: 'done'; finalText: string };
