import { Notice, TFile, Vault } from 'obsidian';
import type { CowriteTask, CowriteTaskInput, TaskDataFile, TaskStatus } from './types';

/**
 * 任务存储：读写 <vault>/.cowrite/tasks.json（文件级协议）。
 * 状态机：queued → running（认领，写 workerId + leaseUntil）→ succeeded | failed | cancelled
 * 并发安全：所有状态迁移用 vault.process 原子读改写。
 */
export class TaskStore {
  constructor(
    private vault: Vault,
    private tasksFile: string,
  ) {}

  /** 读取全部任务（文件不存在返回空列表） */
  async list(): Promise<CowriteTask[]> {
    const data = await this.readData();
    return data?.tasks ?? [];
  }

  /** 按状态过滤读取 */
  async listByStatus(status?: TaskStatus): Promise<CowriteTask[]> {
    const tasks = await this.list();
    if (!status) return tasks;
    return tasks.filter((t) => t.status === status);
  }

  async get(id: string): Promise<CowriteTask | undefined> {
    const tasks = await this.list();
    return tasks.find((t) => t.id === id);
  }

  /** 创建任务（默认 queued） */
  async create(input: CowriteTaskInput, recommendedSkills: string[]): Promise<CowriteTask> {
    const now = new Date().toISOString();
    const task: CowriteTask = {
      ...input,
      id: this.newId(),
      status: 'queued',
      recommendedSkills,
      priority: input.priority ?? 'normal',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.mutate((tasks) => [...tasks, task]);
    return task;
  }

  /**
   * 原子认领下一个最老的排队任务。
   * 返回 null 表示无任务可认领。
   */
  async claimNext(workerId: string): Promise<CowriteTask | null> {
    let claimed: CowriteTask | null = null;
    await this.mutate((tasks) => {
      const idx = tasks.findIndex((t) => t.status === 'queued');
      if (idx === -1) return tasks;
      const now = new Date().toISOString();
      const leaseUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 分钟租约
      const next: CowriteTask = {
        ...tasks[idx],
        status: 'running',
        workerId,
        leaseUntil,
        attempts: (tasks[idx].attempts ?? 0) + 1,
        updatedAt: now,
      };
      claimed = next;
      const copy = [...tasks];
      copy[idx] = next;
      return copy;
    });
    return claimed;
  }

  /** 原子认领指定任务（防双认领：仅当状态仍为 queued 时成功） */
  async claim(id: string, workerId: string): Promise<CowriteTask | null> {
    let claimed: CowriteTask | null = null;
    await this.mutate((tasks) => {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1 || tasks[idx].status !== 'queued') return tasks;
      const now = new Date().toISOString();
      const next: CowriteTask = {
        ...tasks[idx],
        status: 'running',
        workerId,
        leaseUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        attempts: (tasks[idx].attempts ?? 0) + 1,
        updatedAt: now,
      };
      claimed = next;
      const copy = [...tasks];
      copy[idx] = next;
      return copy;
    });
    return claimed;
  }

  /** 标记成功（携带结果消息/资产） */
  async complete(id: string, workerId: string, message: string, assets?: string[]): Promise<CowriteTask | null> {
    return this.finish(id, workerId, () => ({
      status: 'succeeded' as TaskStatus,
      result: { message, assets },
      error: undefined,
    }));
  }

  /** 标记失败（如实记录错误） */
  async fail(id: string, workerId: string, error: string): Promise<CowriteTask | null> {
    return this.finish(id, workerId, () => ({
      status: 'failed' as TaskStatus,
      result: undefined,
      error,
    }));
  }

  /** 重试失败任务（回到 queued，清除错误/结果） */
  async retry(id: string): Promise<CowriteTask | null> {
    let out: CowriteTask | null = null;
    await this.mutate((tasks) => {
      const idx = tasks.findIndex((t) => t.id === id && (t.status === 'failed' || t.status === 'cancelled'));
      if (idx === -1) return tasks;
      const next: CowriteTask = {
        ...tasks[idx],
        status: 'queued',
        result: undefined,
        error: undefined,
        workerId: undefined,
        updatedAt: new Date().toISOString(),
      };
      out = next;
      const copy = [...tasks];
      copy[idx] = next;
      return copy;
    });
    return out;
  }

  /** 取消排队任务 */
  async cancel(id: string): Promise<CowriteTask | null> {
    let out: CowriteTask | null = null;
    await this.mutate((tasks) => {
      const idx = tasks.findIndex((t) => t.id === id && (t.status === 'queued' || t.status === 'running'));
      if (idx === -1) return tasks;
      const next: CowriteTask = {
        ...tasks[idx],
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
      };
      out = next;
      const copy = [...tasks];
      copy[idx] = next;
      return copy;
    });
    return out;
  }

  /** 删除任务 */
  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.mutate((tasks) => {
      const copy = tasks.filter((t) => t.id !== id);
      removed = copy.length !== tasks.length;
      return copy;
    });
    return removed;
  }

  /** 清空已完成/失败/取消的旧任务 */
  async clearFinished(): Promise<number> {
    let count = 0;
    await this.mutate((tasks) => {
      const keep = tasks.filter((t) => t.status === 'queued' || t.status === 'running');
      count = tasks.length - keep.length;
      return keep;
    });
    return count;
  }

  // ---- 内部实现 ----

  private newId(): string {
    return `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  private async readData(): Promise<TaskDataFile | null> {
    const file = this.vault.getAbstractFileByPath(this.tasksFile);
    if (!(file instanceof TFile)) return null;
    try {
      const raw = await this.vault.cachedRead(file);
      return JSON.parse(raw) as TaskDataFile;
    } catch (e) {
      console.error('Cowrite AI: failed to parse tasks.json', e);
      return null;
    }
  }

  /** 原子读改写 tasks.json；文件不存在则创建 */
  private async mutate(fn: (tasks: CowriteTask[]) => CowriteTask[]): Promise<void> {
    await this.ensureFile();
    const file = this.vault.getAbstractFileByPath(this.tasksFile);
    if (!(file instanceof TFile)) {
      new Notice('Cowrite AI: 无法访问任务文件 ' + this.tasksFile);
      return;
    }
    await this.vault.process(file, (raw) => {
      let data: TaskDataFile;
      try {
        data = JSON.parse(raw || '{"version":1,"tasks":[]}') as TaskDataFile;
      } catch {
        data = { version: 1, tasks: [] };
      }
      data.tasks = fn(data.tasks ?? []);
      data.updatedAt = new Date().toISOString();
      return JSON.stringify(data, null, 2);
    });
  }

  /** 确保 tasks.json 存在（含父目录） */
  private async ensureFile(): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(this.tasksFile);
    if (existing instanceof TFile) return;
    const parent = this.tasksFile.split('/').slice(0, -1).join('/');
    if (parent) {
      const parentFolder = this.vault.getAbstractFileByPath(parent);
      if (!parentFolder) {
        try {
          await this.vault.createFolder(parent);
        } catch (e) {
          // 移动端 getAbstractFileByPath 对隐藏目录可能返回 null 但实际已存在，忽略 "already exists"
          if (!(e instanceof Error && /already exists/i.test(e.message))) {
            throw e;
          }
        }
      }
    }
    try {
      await this.vault.create(this.tasksFile, JSON.stringify({ version: 1, tasks: [] } as TaskDataFile, null, 2));
    } catch (e) {
      if (!(e instanceof Error && /already exists/i.test(e.message))) {
        throw e;
      }
    }
  }

  private async finish(
    id: string,
    workerId: string,
    patch: (t: CowriteTask) => Partial<CowriteTask>,
  ): Promise<CowriteTask | null> {
    let out: CowriteTask | null = null;
    await this.mutate((tasks) => {
      const idx = tasks.findIndex((t) => t.id === id && t.workerId === workerId && t.status === 'running');
      if (idx === -1) return tasks;
      const next: CowriteTask = {
        ...tasks[idx],
        ...patch(tasks[idx]),
        updatedAt: new Date().toISOString(),
      };
      out = next;
      const copy = [...tasks];
      copy[idx] = next;
      return copy;
    });
    return out;
  }
}
