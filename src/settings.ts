import { DEFAULT_ACTIONS } from './types';

/** 插件设置（持久化到 <vault>/.obsidian/plugins/cowrite-ai/data.json） */
export interface CowriteSettings {
  // ---- LLM 接入 ----
  /** OpenAI 兼容 API 基础地址，例如 https://api.openai.com/v1 或自建网关 */
  apiBase: string;
  /** API Key（Bearer 鉴权） */
  apiKey: string;
  /** 模型名称，例如 gpt-4o-mini / deepseek-chat / qwen-plus */
  model: string;
  /** 采样温度 0~2 */
  temperature: number;
  /** 单次最大生成 token 数 */
  maxTokens: number;
  /** 请求超时毫秒 */
  requestTimeoutMs: number;

  // ---- 执行引擎 ----
  /** 是否启用内置执行器（自动认领并执行 queued 任务） */
  executorEnabled: boolean;
  /** 并发执行数 1~3 */
  concurrency: number;
  /** 轮询间隔毫秒 */
  pollIntervalMs: number;

  // ---- 存储 ----
  /** 页面目录（vault 内相对路径） */
  pagesDir: string;
  /** 任务文件路径（vault 内相对路径） */
  tasksFile: string;
  /** 动作配置文件路径 */
  actionsFile: string;

  // ---- 其他 ----
  /** 是否在启动时打开控制台 */
  openOnStart: boolean;
}

export const DEFAULT_SETTINGS: CowriteSettings = {
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 2048,
  requestTimeoutMs: 60000,
  executorEnabled: true,
  concurrency: 1,
  pollIntervalMs: 3000,
  pagesDir: 'Cowrite',
  tasksFile: '.cowrite/tasks.json',
  actionsFile: '.cowrite/actions.json',
  openOnStart: false,
};

export function normalizeSettings(loaded: Partial<CowriteSettings> | null): CowriteSettings {
  const merged: CowriteSettings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  // 数值范围兜底
  merged.concurrency = Math.max(1, Math.min(3, Math.floor(merged.concurrency) || 1));
  merged.pollIntervalMs = Math.max(500, merged.pollIntervalMs || 3000);
  merged.requestTimeoutMs = Math.max(5000, merged.requestTimeoutMs || 60000);
  merged.temperature = Math.max(0, Math.min(2, merged.temperature ?? 0.7));
  merged.maxTokens = Math.max(256, merged.maxTokens || 2048);
  return merged;
}

export function defaultActionsFile(): string {
  return JSON.stringify({ version: 1 as const, actions: DEFAULT_ACTIONS }, null, 2);
}
