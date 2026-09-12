import type { AgentEvent } from '../events';

/** OpenAI 兼容消息结构 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role=tool 时必填：对应 assistant 发起的 tool_call id */
  tool_call_id?: string;
  /** role=tool 时可选：工具名（部分网关要求） */
  name?: string;
  /** role=assistant 时：本次回复发起的工具调用 */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/** 聚合后的一次工具调用（loop 内部使用） */
export interface ToolCall {
  id: string;
  name: string;
  /** 已解析的参数对象（parse 失败时为原始字符串） */
  args: any;
  /** 原始 arguments 字符串（回灌模型用） */
  argsRaw: string;
}

/** provider.chat 单次请求入参 */
export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: object };
  }>;
  temperature?: number;
  maxTokens?: number;
}

/**
 * LLM Provider 抽象：流式产出 AgentEvent。
 * 每个 yield 项额外携带截至当前已聚合的 toolCalls，以及（仅最后一项）finishReason。
 * AgentRunner 消费时跟踪最后一次 finishReason 与累积 toolCalls 即可决定是否继续调工具。
 */
export interface LLMProvider {
  id: string;
  chat(
    req: ChatRequest,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent & { toolCalls?: ToolCall[]; finishReason?: string }>;
}
