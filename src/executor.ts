import { Notice, TFile } from 'obsidian';
import type CowriteAIPlugin from './main';
import { chatCompletion } from './llm';
import type { CowriteTask } from './types';

/**
 * 内置 LLM 执行器：插件启动后轮询任务队列，自动认领 queued 任务，
 * 读取页面正文 → 拼接动作 prompt → 调用用户配置的 LLM → 写回页面 → 完成/失败。
 *
 * 纯浏览器 API 实现，无 Node 依赖，移动端可运行。
 */
export class Executor {
  /** 固定 workerId（内置执行器全局唯一） */
  readonly workerId = 'cowrite-ai-builtin';

  private plugin: CowriteAIPlugin;
  private timer: number | null = null;
  /** 当前正在执行的任务数（内存计数，用于限流） */
  private inFlight = 0;
  /** 是否已经启动（start/stop 控制） */
  private running = false;

  constructor(plugin: CowriteAIPlugin) {
    this.plugin = plugin;
  }

  /** 是否处于运行状态 */
  isRunning(): boolean {
    return this.running;
  }

  /** 当前并发占用 */
  activeCount(): number {
    return this.inFlight;
  }

  /** 启动轮询循环（幂等） */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleTick();
  }

  /** 停止轮询（不影响正在进行中的请求） */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 重启（设置变更后调用） */
  restart(): void {
    this.stop();
    if (this.plugin.settings.executorEnabled) {
      this.start();
    }
  }

  // ---- 内部实现 ----

  private scheduleTick(): void {
    if (!this.running) return;
    const interval = Math.max(500, this.plugin.settings.pollIntervalMs || 3000);
    this.timer = window.setTimeout(() => {
      void this.tick().finally(() => this.scheduleTick());
    }, interval);
  }

  /** 一轮 tick：若并发未满，尽量认领并执行一个任务 */
  private async tick(): Promise<void> {
    if (!this.running) return;
    const concurrency = this.plugin.settings.concurrency || 1;
    // 一次 tick 最多把并发补满
    while (this.running && this.inFlight < concurrency) {
      const task = await this.plugin.tasks.claimNext(this.workerId);
      if (!task) break; // 没有可认领任务
      this.inFlight++;
      // 不 await，并发执行；后台跑
      void this.runTask(task)
        .catch((e) => console.error('Cowrite AI executor: unexpected error', e))
        .finally(() => {
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.plugin.refreshConsole();
        });
    }
  }

  /** 执行单个已认领任务 */
  private async runTask(task: CowriteTask): Promise<void> {
    const p = this.plugin;
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

      const original = await p.pages.read(file);
      const action = await p.actions.get(task.action);
      const systemPrompt =
        action?.prompt ||
        '你是一名中文写作助手。请根据用户要求处理下面的 Markdown 正文，直接输出处理后的完整 Markdown 正文。';

      // 组装用户消息：原文 + 补充要求
      const userParts: string[] = [];
      userParts.push('【原始 Markdown 正文开始】');
      userParts.push(original || '(空)');
      userParts.push('【原始 Markdown 正文结束】');
      if (task.requirements) {
        userParts.push('');
        userParts.push('【用户补充要求】');
        userParts.push(task.requirements);
      }
      const userPrompt = userParts.join('\n');

      const result = await chatCompletion(p.settings, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);

      const newContent = (result.content || '').trim();
      if (!newContent) {
        await p.tasks.fail(task.id, this.workerId, '模型返回空内容');
        return;
      }

      const written = await p.pages.write(file, newContent);
      if (!written) {
        await p.tasks.fail(task.id, this.workerId, '写回页面失败（vault.modify 错误）');
        return;
      }

      const summary = `已写回 ${file.path}（${newContent.length} 字符）`;
      await p.tasks.complete(task.id, this.workerId, summary);
      new Notice(`Cowrite AI: 任务 ${task.id} 完成`);
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
