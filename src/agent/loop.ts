import type { App, TFile } from 'obsidian';
import type { AgentEvent } from './events';
import type { AgentMode } from './modes';
import { composeSystemPrompt } from './prompts/compose';
import { vaultMapSection } from './prompts/vaultMapSection';
import { memorySection } from './prompts/memorySection';
import { currentNoteSection } from './prompts/currentNoteSection';
import type { AgentTool, ToolContext } from './defineTool';
import { toolToOpenAISpec } from './defineTool';
import type { LLMProvider, ToolCall } from './providers/llm';
import type { SessionLog } from './sessionLog';
import { compactHistory } from './compact';
import { StuckDetector, StuckError } from './stuck';
import type { VaultMap } from './vaultMap';
import type { MemoryStore } from './memory';

/** loop 需要的设置最小集合 */
export interface RunnerSettings {
  temperature: number;
  maxTokens: number;
  maxTurns: number;
  compactThreshold: number;
  compactRetain: number;
  pagesDir: string;
}

export interface AgentRunnerOpts {
  app: App;
  provider: LLMProvider;
  tools: AgentTool[];
  sessionLog: SessionLog;
  mode: AgentMode;
  settings: RunnerSettings;
  toolContext: ToolContext;
  vaultMap?: VaultMap;
  memory?: MemoryStore;
  signal: AbortSignal;
  /** 流式事件回调（推 UI） */
  onEvent: (ev: AgentEvent) => void;
}

/**
 * Agent 主循环：多轮 tool calling 编排。
 * 每轮：derivceModelHistory → 调 provider → 消费事件流 → 有 tool_calls 就执行并回灌 → 继续；
 * 模型不再调工具则结束。turn 边界做 compact。
 */
export class AgentRunner {
  private opts: AgentRunnerOpts;
  private stuck = new StuckDetector();

  constructor(opts: AgentRunnerOpts) {
    this.opts = opts;
  }

  async run(userInput: string): Promise<void> {
    const { onEvent, signal } = this.opts;
    try {
      // 1) 记录用户消息
      await this.opts.sessionLog.append({
        kind: 'user',
        text: userInput,
        ts: new Date().toISOString(),
      });

      const maxTurns = Math.max(1, this.opts.settings.maxTurns || 12);

      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal.aborted) {
          onEvent({ type: 'error', error: '任务被用户取消' });
          return;
        }

        // 2) 派生历史
        const history = await this.opts.sessionLog.deriveModelHistory();

        // 3) 组装 system prompt（按 order 拼接，前缀稳定）
        const system = await this.buildSystemPrompt(userInput);

        // 4) 按模式过滤工具
        const allowedTools = this.filterToolsByMode(this.opts.tools, this.opts.mode);
        const openAISpecs = allowedTools.map(toolToOpenAISpec);

        // 5) 调 provider 流式
        let finalText = '';
        let lastToolCalls: ToolCall[] = [];
        let finishReason: string | undefined;

        const gen = this.opts.provider.chat(
          {
            system,
            messages: history,
            tools: openAISpecs,
            temperature: this.opts.settings.temperature,
            maxTokens: this.opts.settings.maxTokens,
          },
          signal,
        );

        for await (const ev of gen) {
          // 推 UI（保留 approval-request 等原生事件；text-delta/reasoning 透传）
          if (ev.type === 'text-delta') {
            if (ev.delta) {
              finalText += ev.delta;
              onEvent({ type: 'text-delta', delta: ev.delta });
            }
          } else if (ev.type === 'reasoning') {
            onEvent({ type: 'reasoning', delta: ev.delta });
          } else {
            onEvent(ev);
          }
          if (ev.toolCalls) lastToolCalls = ev.toolCalls;
          if (ev.finishReason) finishReason = ev.finishReason;
        }

        // 6) 记录 assistant 消息
        await this.opts.sessionLog.append({
          kind: 'assistant',
          text: finalText,
          toolCalls:
            lastToolCalls.length > 0
              ? lastToolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args, argsRaw: tc.argsRaw }))
              : undefined,
          ts: new Date().toISOString(),
        });

        const hasToolCall = lastToolCalls.length > 0;
        this.stuck.recordAssistantTurn(hasToolCall);

        // 7) 没有工具调用 = 模型认为任务完成
        if (!hasToolCall) {
          onEvent({ type: 'done', finalText });
          return;
        }

        // 8) 逐个执行工具调用
        for (const call of lastToolCalls) {
          if (signal.aborted) {
            onEvent({ type: 'error', error: '任务被用户取消' });
            return;
          }
          await this.executeOneToolCall(call);
        }

        // 9) turn 边界：检查是否需要 compact
        await this.maybeCompact();
      }

      onEvent({ type: 'error', error: `已达到最大轮次 ${maxTurns}，终止。` });
    } catch (e) {
      if (e instanceof StuckError) {
        onEvent({ type: 'error', error: e.message });
        return;
      }
      onEvent({ type: 'error', error: (e as Error)?.message || String(e) });
    }
  }

  // ---- 内部 ----

  /** 按模式白名单过滤工具 */
  private filterToolsByMode(tools: AgentTool[], mode: AgentMode): AgentTool[] {
    if (mode.toolAllowlist.includes('*')) return tools;
    return tools.filter((t) => mode.toolAllowlist.includes(t.name));
  }

  /** 组装 system prompt：prefix + vaultMap + memory + currentNote */
  private async buildSystemPrompt(userInput: string): Promise<string> {
    const app = this.opts.app;
    const activeFile: TFile | null = app.workspace.getActiveFile();

    // vault map
    let vaultMapText = '';
    if (this.opts.vaultMap) {
      try {
        await this.opts.vaultMap.ensureBuilt();
        vaultMapText = this.opts.vaultMap.renderFor(activeFile?.path ?? null, 1024);
      } catch (e) {
        console.warn('Cowrite AI: vaultMap render failed', e);
      }
    }

    // memory：从 userInput 抽关键词做匹配
    let observations: string[] = [];
    if (this.opts.memory) {
      const keywords = userInput
        .split(/[\s,，。、；;：:]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2);
      try {
        observations = await this.opts.memory.query(keywords);
      } catch (e) {
        console.warn('Cowrite AI: memory query failed', e);
      }
    }

    return composeSystemPrompt([
      vaultMapSection(vaultMapText),
      memorySection(observations),
      currentNoteSection(
        activeFile ? { path: activeFile.path, basename: activeFile.basename } : null,
      ),
    ]);
  }

  /** 执行单个工具调用：审批 → Zod 校验 → 执行 → 回灌结果 */
  private async executeOneToolCall(call: ToolCall): Promise<void> {
    const { onEvent, mode, toolContext, sessionLog } = this.opts;

    const tool = this.opts.tools.find((t) => t.name === call.name);
    // 模式外工具直接拒绝
    if (!tool || !this.filterToolsByMode([tool], mode).length) {
      const msg = `工具 ${call.name} 在当前模式 ${mode.id} 下不可用`;
      onEvent({ type: 'tool-end', name: call.name, result: { error: msg }, isError: true });
      await sessionLog.append({
        kind: 'tool',
        callId: call.id,
        name: call.name,
        result: msg,
        isError: true,
        ts: new Date().toISOString(),
      });
      return;
    }

    // stuck 检测（重复相同调用）
    try {
      this.stuck.recordToolCall(call.name, call.args);
    } catch (e) {
      const msg = (e as Error).message;
      onEvent({ type: 'error', error: msg });
      await sessionLog.append({
        kind: 'tool',
        callId: call.id,
        name: call.name,
        result: msg,
        isError: true,
        ts: new Date().toISOString(),
      });
      throw e;
    }

    // 审批
    if (mode.requireApproval(call.name)) {
      const approved = await new Promise<boolean>((resolve) => {
        onEvent({
          type: 'approval-request',
          toolName: call.name,
          args: call.args,
          resolve,
        });
      });
      if (!approved) {
        const msg = `用户拒绝了工具 ${call.name} 的执行`;
        onEvent({ type: 'tool-end', name: call.name, result: { error: msg }, isError: true });
        await sessionLog.append({
          kind: 'tool',
          callId: call.id,
          name: call.name,
          result: msg,
          isError: true,
          ts: new Date().toISOString(),
        });
        return;
      }
    }

    // Zod 校验
    onEvent({ type: 'tool-start', name: call.name, args: call.args });
    const parsed = tool.parameters.safeParse(call.args ?? {});
    if (!parsed.success) {
      const issues = JSON.stringify(parsed.error.issues).slice(0, 500);
      const msg = `参数校验失败：${issues}`;
      onEvent({ type: 'tool-end', name: call.name, result: { error: msg }, isError: true });
      await sessionLog.append({
        kind: 'tool',
        callId: call.id,
        name: call.name,
        result: msg,
        isError: true,
        ts: new Date().toISOString(),
      });
      return;
    }

    // 执行
    let result: Record<string, unknown>;
    let isError = false;
    try {
      result = await tool.execute(parsed.data, toolContext);
      isError = result?.ok === false;
    } catch (e) {
      result = { ok: false, error: String((e as Error).message || e) };
      isError = true;
    }

    onEvent({ type: 'tool-end', name: call.name, result, isError });
    await sessionLog.append({
      kind: 'tool',
      callId: call.id,
      name: call.name,
      result: JSON.stringify(result),
      isError,
      ts: new Date().toISOString(),
    });
  }

  /** turn 边界：历史过长时压缩 */
  private async maybeCompact(): Promise<void> {
    try {
      const history = await this.opts.sessionLog.deriveModelHistory();
      if (history.length < 6) return;
      const result = await compactHistory({
        provider: this.opts.provider,
        system: '',
        messages: history,
        threshold: this.opts.settings.compactThreshold,
        retainRatio: this.opts.settings.compactRetain,
        signal: this.opts.signal,
      });
      if (result.compacted) {
        // 把压缩后的历史整体重写为一条 system-note + 尾部消息
        // 简化：直接往 sessionLog 追加一条 system-note 摘要（下一轮 deriveModelHistory 会带上）
        const systemNote = result.messages.find((m) => m.role === 'system');
        if (systemNote) {
          await this.opts.sessionLog.append({
            kind: 'system-note',
            text: systemNote.content,
            ts: new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      console.warn('Cowrite AI: maybeCompact failed', e);
    }
  }
}
