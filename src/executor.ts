import { TFile } from 'obsidian';
import type CowriteAIPlugin from './main';
import { createProvider } from './llm';
import type { CowriteTask } from './types';
import { SessionLog } from './agent/sessionLog';
import { AgentRunner } from './agent/loop';
import { getMode } from './agent/modes';
import { allTools } from './agent/tools';
import type { AgentEvent } from './agent/events';

/**
 * 内置 Agent 执行器：插件启动后轮询任务队列，自动认领 queued 任务，
 * 构造 AgentRunner（tool calling + 流式 + 多工具 + vault map）执行，
 * 事件流推给控制台 UI。纯浏览器 API，移动端可运行。
 */
export class Executor {
  /** 固定 workerId（内置执行器全局唯一） */
  readonly workerId = 'cowrite-ai-builtin';

  private plugin: CowriteAIPlugin;
  private timer: number | null = null;
  private inFlight = 0;
  private running = false;

  /** 每个任务最近的事件缓冲（控制台视图选中任务时重放） */
  private eventBuffers = new Map<string, AgentEvent[]>();
  /** 每个任务的事件订阅者集合 */
  private listeners = new Map<string, Set<(ev: AgentEvent) => void>>();

  constructor(plugin: CowriteAIPlugin) {
    this.plugin = plugin;
  }

  isRunning(): boolean {
    return this.running;
  }

  activeCount(): number {
    return this.inFlight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleTick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  restart(): void {
    this.stop();
    if (this.plugin.settings.executorEnabled) {
      this.start();
    }
  }

  /**
   * 订阅某任务的事件流。立即重放已缓冲事件，随后实时推送新事件。
   * 返回 unsubscribe 函数。
   */
  subscribe(taskId: string, cb: (ev: AgentEvent) => void): () => void {
    const existing = this.eventBuffers.get(taskId) ?? [];
    for (const ev of existing) {
      try {
        cb(ev);
      } catch {
        // 单个订阅者抛错不影响其他
      }
    }
    if (!this.listeners.has(taskId)) this.listeners.set(taskId, new Set());
    this.listeners.get(taskId)!.add(cb);
    return () => {
      this.listeners.get(taskId)?.delete(cb);
    };
  }

  /** 读取某任务已缓冲的全部事件（选中任务时一次性渲染用） */
  buffered(taskId: string): AgentEvent[] {
    return (this.eventBuffers.get(taskId) ?? []).slice();
  }

  // ---- 内部 ----

  private emit(taskId: string, ev: AgentEvent): void {
    const buf = this.eventBuffers.get(taskId) ?? [];
    buf.push(ev);
    if (buf.length > 800) buf.shift();
    this.eventBuffers.set(taskId, buf);
    this.listeners.get(taskId)?.forEach((cb) => {
      try {
        cb(ev);
      } catch {
        // 忽略
      }
    });
  }

  private scheduleTick(): void {
    if (!this.running) return;
    const interval = Math.max(500, this.plugin.settings.pollIntervalMs || 3000);
    this.timer = window.setTimeout(() => {
      void this.tick().finally(() => this.scheduleTick());
    }, interval);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const concurrency = this.plugin.settings.concurrency || 1;
    while (this.running && this.inFlight < concurrency) {
      const task = await this.plugin.tasks.claimNext(this.workerId);
      if (!task) break;
      this.inFlight++;
      void this.runTask(task)
        .catch((e) => console.error('Cowrite AI executor: unexpected error', e))
        .finally(() => {
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.plugin.refreshConsole();
        });
    }
  }

  /** 执行单个已认领任务：构造 AgentRunner 跑多轮 tool calling */
  private async runTask(task: CowriteTask): Promise<void> {
    const p = this.plugin;
    const settings = p.settings;
    try {
      if (!task.pagePath) {
        await p.tasks.fail(task.id, this.workerId, '任务未指定 pagePath');
        return;
      }
      const file: TFile | null = p.pages.getByPath(task.pagePath);
      if (!file) {
        await p.tasks.fail(task.id, this.workerId, `页面不存在：${task.pagePath}`);
        return;
      }

      // 组装用户输入：动作目标 + 目标页面 + 补充要求
      const action = await p.actions.get(task.action);
      const actionSection = action
        ? `【本任务目标（来自动作 ${action.label}）】\n${action.prompt}`
        : `【本任务】${task.action}`;
      const userInput = [
        actionSection,
        `【目标页面】${task.pagePath}`,
        task.requirements ? `【用户补充要求】\n${task.requirements}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      // 构造运行时
      const sessionLog = new SessionLog(p.app.vault, task.id);
      const provider = createProvider(settings);
      const mode = getMode(settings.defaultMode);
      const toolContext = {
        app: p.app,
        vault: p.app.vault,
        settings: {
          imageApiBase: settings.imageApiBase,
          imageApiKey: settings.imageApiKey,
          imageModel: settings.imageModel,
          pagesDir: settings.pagesDir,
          masterApiKey: settings.apiKey,
        },
      };

      const runner = new AgentRunner({
        app: p.app,
        provider,
        tools: allTools,
        sessionLog,
        mode,
        settings: {
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          maxTurns: settings.maxTurns,
          compactThreshold: settings.compactThreshold,
          compactRetain: settings.compactRetain,
          pagesDir: settings.pagesDir,
        },
        toolContext,
        vaultMap: p.vaultMap,
        memory: p.memory,
        signal: new AbortController().signal, // 任务级取消暂用本地 controller
        onEvent: (ev) => {
          // 审批请求：60s 无响应自动拒绝，避免挂死
          if (ev.type === 'approval-request') {
            const origResolve = ev.resolve;
            const timer = window.setTimeout(() => {
              try {
                origResolve(false);
              } catch {
                // 忽略
              }
            }, 60000);
            this.emit(task.id, {
              ...ev,
              resolve: (approved: boolean) => {
                window.clearTimeout(timer);
                origResolve(approved);
              },
            });
            return;
          }
          this.emit(task.id, ev);
        },
      });

      await runner.run(userInput);

      // 完成：从 sessionLog 取最终文本作为 summary
      const events = this.eventBuffers.get(task.id) ?? [];
      const doneEv = [...events].reverse().find((e) => e.type === 'done');
      const finalText = doneEv && doneEv.type === 'done' ? doneEv.finalText : '';
      const summary = `已完成（${file.path}）${finalText ? '：' + finalText.slice(0, 120) : ''}`;
      await p.tasks.complete(task.id, this.workerId, summary, [file.path]);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      console.error('Cowrite AI executor runTask failed', task.id, e);
      try {
        await p.tasks.fail(task.id, this.workerId, msg);
      } catch (e2) {
        console.error('Cowrite AI: fail task also failed', e2);
      }
    }
  }
}
