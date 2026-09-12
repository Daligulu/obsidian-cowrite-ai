import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';
import { CowriteSettings, DEFAULT_SETTINGS, normalizeSettings } from './settings';
import { PageStore } from './pages';
import { TaskStore } from './taskStore';
import { ActionStore } from './actions';
import { Executor } from './executor';
import { testConnection } from './llm';
import { ActionConfig, CowriteTask } from './types';
import { VaultMap } from './agent/vaultMap';
import { MemoryStore } from './agent/memory';
import { findTool } from './agent/tools';
import type { AgentEvent } from './agent/events';

export const VIEW_TYPE_COWRITE = 'cowrite-ai-console';

/**
 * Cowrite AI 主插件类（v0.2：真 Agent）。
 * 页面仓库 + 任务队列 + Agent 执行引擎（tool calling + 流式 + vault map + 长期记忆）。
 * 纯浏览器/Obsidian API，移动端可用。
 */
export default class CowriteAIPlugin extends Plugin {
  settings: CowriteSettings = { ...DEFAULT_SETTINGS };
  pages!: PageStore;
  tasks!: TaskStore;
  actions!: ActionStore;
  executor!: Executor;
  vaultMap!: VaultMap;
  memory!: MemoryStore;

  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.pages = new PageStore(this.app.vault, this.settings.pagesDir);
    this.tasks = new TaskStore(this.app.vault, this.settings.tasksFile);
    this.actions = new ActionStore(this.app.vault, this.settings.actionsFile);
    this.vaultMap = new VaultMap(this.app.vault);
    this.memory = new MemoryStore(this.app.vault);
    this.executor = new Executor(this);

    // 注册控制台视图
    this.registerView(VIEW_TYPE_COWRITE, (leaf) => new CowriteConsoleView(leaf, this));

    // 功能区图标
    this.addRibbonIcon('lucide-pen-tool', '打开 Cowrite AI 控制台', () => {
      void this.activateView();
    });

    // 命令
    this.addCommand({
      id: 'open-console',
      name: '打开 Cowrite AI 控制台',
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: 'new-page',
      name: '新建 Cowrite 页面',
      callback: () => {
        new NewPageModal(this.app, this).open();
      },
    });
    this.addCommand({
      id: 'dispatch-task-current-note',
      name: '对当前笔记投递 Cowrite 任务',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          new NewTaskModal(this.app, this, file).open();
        }
        return true;
      },
    });
    this.addCommand({
      id: 'toggle-executor',
      name: '启动 / 暂停内置执行器',
      callback: () => this.toggleExecutor(),
    });

    // 设置页
    this.addSettingTab(new CowriteSettingTab(this.app, this));

    // vault 变更 → 失效 vault map 缓存
    this.registerEvent(
      this.app.vault.on('create', () => this.vaultMap.invalidate()),
    );
    this.registerEvent(
      this.app.vault.on('modify', () => this.vaultMap.invalidate()),
    );
    this.registerEvent(
      this.app.vault.on('delete', () => this.vaultMap.invalidate()),
    );

    // 后台懒构建 vault map（不阻塞首屏）
    void this.vaultMap.loadFromCache().then(() => {
      void this.vaultMap.ensureBuilt();
    });

    // 启动执行器
    if (this.settings.executorEnabled) {
      this.executor.start();
    }

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openOnStart) {
        void this.activateView();
      }
    });
  }

  onunload() {
    this.executor.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_COWRITE);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_COWRITE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_COWRITE, active: true });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  toggleExecutor(): void {
    if (this.executor.isRunning()) {
      this.executor.stop();
      this.settings.executorEnabled = false;
      void this.saveData(this.settings);
      new Notice('Cowrite AI: 执行器已暂停');
    } else {
      this.executor.start();
      this.settings.executorEnabled = true;
      void this.saveData(this.settings);
      new Notice('Cowrite AI: 执行器已启动');
    }
    this.refreshConsole();
  }

  /** 切换默认模式（ask/write） */
  toggleMode(): void {
    this.settings.defaultMode = this.settings.defaultMode === 'ask' ? 'write' : 'ask';
    void this.saveData(this.settings);
    new Notice(`Cowrite AI: 模式已切换为 ${this.settings.defaultMode === 'ask' ? '问答（只读）' : '创作（可写）'}`);
    this.refreshConsole();
  }

  refreshConsole(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_COWRITE).forEach((leaf) => {
      if (leaf.view instanceof CowriteConsoleView) {
        void leaf.view.refresh();
      }
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.pages = new PageStore(this.app.vault, this.settings.pagesDir);
    this.tasks = new TaskStore(this.app.vault, this.settings.tasksFile);
    this.actions = new ActionStore(this.app.vault, this.settings.actionsFile);
    this.executor.restart();
    this.refreshConsole();
  }
}

// ---------------------------------------------------------------------------
// 控制台视图
// ---------------------------------------------------------------------------

export class CowriteConsoleView extends ItemView {
  private plugin: CowriteAIPlugin;
  private pageListEl!: HTMLElement;
  private taskListEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private btnToggle!: HTMLButtonElement;
  private btnMode!: HTMLButtonElement;
  private selectedTaskId: string | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CowriteAIPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_COWRITE;
  }

  getDisplayText(): string {
    return 'Cowrite AI 控制台';
  }

  getIcon(): string {
    return 'lucide-pen-tool';
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('cowrite-console');

    const header = this.contentEl.createDiv({ cls: 'cowrite-header' });
    header.createEl('h2', { text: 'Cowrite AI' });
    this.statusEl = header.createEl('div', { cls: 'cowrite-status' });

    const toolbar = this.contentEl.createDiv({ cls: 'cowrite-toolbar' });
    const btnNew = toolbar.createEl('button', { text: '＋ 新建页面' });
    btnNew.addEventListener('click', () => {
      new NewPageModal(this.plugin.app, this.plugin).open();
    });
    const btnTask = toolbar.createEl('button', { text: '＋ 投递任务' });
    btnTask.addEventListener('click', () => {
      new NewTaskModal(this.plugin.app, this.plugin).open();
    });
    const btnRefresh = toolbar.createEl('button', { text: '↻ 刷新' });
    btnRefresh.addEventListener('click', () => void this.refresh());
    this.btnMode = toolbar.createEl('button', { text: '' });
    this.btnMode.addEventListener('click', () => this.plugin.toggleMode());
    this.btnToggle = toolbar.createEl('button', { text: '' });
    this.btnToggle.addEventListener('click', () => this.plugin.toggleExecutor());

    // 页面区
    const pagesSection = this.contentEl.createDiv({ cls: 'cowrite-section' });
    pagesSection.createEl('h3', { text: '页面库' });
    this.pageListEl = pagesSection.createDiv({ cls: 'cowrite-page-list' });

    // 任务区
    const tasksSection = this.contentEl.createDiv({ cls: 'cowrite-section' });
    tasksSection.createEl('h3', { text: '任务队列' });
    this.taskListEl = tasksSection.createDiv({ cls: 'cowrite-task-list' });

    // 任务详情区（流式输出 + 工具卡片 + 审批）
    const detailSection = this.contentEl.createDiv({ cls: 'cowrite-section' });
    detailSection.createEl('h3', { text: '任务详情' });
    this.detailEl = detailSection.createDiv({ cls: 'cowrite-detail' });
    this.detailEl.createEl('div', { cls: 'cowrite-empty', text: '点击左侧任务查看流式输出。' });

    await this.refresh();
  }

  async onClose() {
    if (this.unsubscribe) this.unsubscribe();
    this.contentEl.empty();
  }

  async refresh(): Promise<void> {
    if (!this.contentEl || this.contentEl.children.length === 0) return;

    if (this.btnToggle) {
      this.btnToggle.textContent = this.plugin.executor.isRunning() ? '⏸ 暂停执行器' : '▶ 启动执行器';
    }
    if (this.btnMode) {
      this.btnMode.textContent = this.plugin.settings.defaultMode === 'ask' ? '🔍 问答模式' : '✍️ 创作模式';
    }

    // 页面列表
    const files = await this.plugin.pages.list();
    this.pageListEl.empty();
    if (files.length === 0) {
      this.pageListEl.createEl('div', { cls: 'cowrite-empty', text: '暂无页面。点击「新建页面」开始。' });
    } else {
      files.forEach((file) => {
        const row = this.pageListEl.createDiv({ cls: 'cowrite-page-row' });
        const name = row.createEl('span', { cls: 'cowrite-page-name', text: file.basename });
        name.addEventListener('click', () => {
          void this.plugin.app.workspace.openLinkText(file.path, '', false);
        });
        const del = row.createEl('button', { cls: 'cowrite-btn-small', text: '删除' });
        del.addEventListener('click', async () => {
          await this.plugin.pages.trash(file);
          await this.refresh();
        });
      });
    }

    // 任务列表
    const tasks = await this.plugin.tasks.list();
    const sorted = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.taskListEl.empty();
    if (sorted.length === 0) {
      this.taskListEl.createEl('div', { cls: 'cowrite-empty', text: '暂无任务。投递一个任务，内置执行器会自动执行。' });
    } else {
      sorted.forEach((task) => this.renderTask(task));
    }

    const running = tasks.filter((t) => t.status === 'running').length;
    const queued = tasks.filter((t) => t.status === 'queued').length;
    const done = tasks.filter((t) => t.status === 'succeeded').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    const execState = this.plugin.executor.isRunning() ? '运行中' : '已暂停';
    this.statusEl.setText(
      `执行器：${execState} · 模式：${this.plugin.settings.defaultMode === 'ask' ? '问答' : '创作'} · 排队 ${queued} · 进行中 ${running} · 成功 ${done} · 失败 ${failed}`,
    );
  }

  private renderTask(task: CowriteTask): void {
    const row = this.taskListEl.createDiv({
      cls: `cowrite-task-row cowrite-task-${task.status}${task.id === this.selectedTaskId ? ' cowrite-task-selected' : ''}`,
    });

    const head = row.createDiv({ cls: 'cowrite-task-head' });
    head.createEl('span', { cls: 'cowrite-task-action', text: task.action });
    head.createEl('span', { cls: `cowrite-task-status cowrite-task-status-${task.status}`, text: task.status });

    if (task.pagePath) {
      row.createEl('div', { cls: 'cowrite-task-meta', text: `页面: ${task.pagePath}` });
    }
    if (task.requirements) {
      row.createEl('div', { cls: 'cowrite-task-meta', text: `要求: ${task.requirements}` });
    }
    if (task.result?.message) {
      row.createEl('div', { cls: 'cowrite-task-result', text: task.result.message });
    }
    if (task.error) {
      row.createEl('div', { cls: 'cowrite-task-error', text: task.error });
    }

    // 点击选中任务 → 订阅事件流
    head.addEventListener('click', () => this.selectTask(task.id));

    const ops = row.createDiv({ cls: 'cowrite-task-ops' });
    if (task.status === 'failed') {
      const retry = ops.createEl('button', { cls: 'cowrite-btn-small', text: '重试' });
      retry.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.plugin.tasks.retry(task.id);
        await this.refresh();
      });
    }
    if (task.status === 'queued') {
      const cancel = ops.createEl('button', { cls: 'cowrite-btn-small', text: '取消' });
      cancel.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.plugin.tasks.cancel(task.id);
        await this.refresh();
      });
    }
    const del = ops.createEl('button', { cls: 'cowrite-btn-small', text: '删除' });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.plugin.tasks.remove(task.id);
      await this.refresh();
    });
  }

  /** 选中任务：订阅事件流并渲染详情 */
  private selectTask(taskId: string): void {
    this.selectedTaskId = taskId;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.detailEl.empty();

    // 50ms debounce 批量更新 DOM
    let pending: AgentEvent[] = [];
    let flushTimer: number | null = null;
    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        const batch = pending;
        pending = [];
        for (const ev of batch) this.renderEvent(ev);
      }, 50);
    };

    this.unsubscribe = this.plugin.executor.subscribe(taskId, (ev) => {
      pending.push(ev);
      scheduleFlush();
    });

    this.detailEl.createEl('div', { cls: 'cowrite-task-result', text: `任务 ${taskId} 已选中，等待事件流...` });
  }

  /** 渲染单个 Agent 事件到详情区 */
  private renderEvent(ev: AgentEvent): void {
    const detail = this.detailEl;
    switch (ev.type) {
      case 'text-delta': {
        if (!ev.delta) return;
        let last = detail.lastElementChild;
        if (!last || !last.classList.contains('cowrite-stream-text')) {
          last = detail.createDiv({ cls: 'cowrite-stream-text' });
        }
        last.textContent = (last.textContent ?? '') + ev.delta;
        break;
      }
      case 'reasoning': {
        const el = detail.createDiv({ cls: 'cowrite-stream-reasoning' });
        el.textContent = '💭 ' + ev.delta;
        break;
      }
      case 'tool-start': {
        const card = detail.createDiv({ cls: 'cowrite-tool-card cowrite-tool-running' });
        card.createEl('div', { cls: 'cowrite-tool-name', text: `🔧 ${ev.name} 执行中...` });
        const argsPre = card.createEl('pre', { cls: 'cowrite-tool-args' });
        argsPre.setText(JSON.stringify(ev.args, null, 2).slice(0, 400));
        card.dataset.toolName = ev.name;
        card.dataset.toolArgs = JSON.stringify(ev.args);
        break;
      }
      case 'tool-end': {
        // 找最后一个 running 卡片替换
        const cards = detail.querySelectorAll('.cowrite-tool-card.cowrite-tool-running');
        const card = cards.length > 0 ? cards[cards.length - 1] as HTMLElement : detail.createDiv({ cls: 'cowrite-tool-card' });
        card.classList.remove('cowrite-tool-running');
        card.classList.add(ev.isError ? 'cowrite-tool-error' : 'cowrite-tool-done');
        card.empty();
        // 调工具自带 render
        const tool = findTool(ev.name);
        if (tool && tool.render) {
          try {
            tool.render(JSON.parse(card.dataset.toolArgs || '{}'), ev.result, card);
          } catch {
            card.createEl('div', { cls: 'cowrite-tool-name', text: `${ev.name} 完成` });
          }
        } else {
          card.createEl('div', { cls: 'cowrite-tool-name', text: `${ev.name} 完成` });
        }
        break;
      }
      case 'approval-request': {
        const card = detail.createDiv({ cls: 'cowrite-approval-card' });
        card.createEl('div', { cls: 'cowrite-approval-title', text: `⚠️ Agent 请求执行：${ev.toolName}` });
        const argsPre = card.createEl('pre', { cls: 'cowrite-tool-args' });
        argsPre.setText(JSON.stringify(ev.args, null, 2).slice(0, 400));
        const btns = card.createDiv({ cls: 'cowrite-modal-btns' });
        const ok = btns.createEl('button', { text: '同意执行' });
        ok.addEventListener('click', () => {
          card.empty();
          card.createEl('div', { cls: 'cowrite-tool-done', text: '✓ 已同意，执行中...' });
          ev.resolve(true);
        });
        const deny = btns.createEl('button', { text: '拒绝' });
        deny.addEventListener('click', () => {
          card.empty();
          card.createEl('div', { cls: 'cowrite-tool-error', text: '✗ 已拒绝' });
          ev.resolve(false);
        });
        break;
      }
      case 'error': {
        detail.createEl('div', { cls: 'cowrite-task-error', text: '❌ ' + ev.error });
        break;
      }
      case 'done': {
        const el = detail.createDiv({ cls: 'cowrite-task-result' });
        el.setText('✅ 任务完成' + (ev.finalText ? '：' + ev.finalText.slice(0, 200) : ''));
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 新建页面
// ---------------------------------------------------------------------------

export class NewPageModal extends Modal {
  private plugin: CowriteAIPlugin;

  constructor(app: App, plugin: CowriteAIPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '新建 Cowrite 页面' });

    const titleInput = contentEl.createEl('input', {
      type: 'text',
      placeholder: '页面标题（将作为文件名）',
    });
    titleInput.addClass('cowrite-input');

    const contentInput = contentEl.createEl('textarea', {
      placeholder: '初始内容（可选）',
    });
    contentInput.addClass('cowrite-textarea');

    const btns = contentEl.createDiv({ cls: 'cowrite-modal-btns' });
    const ok = btns.createEl('button', { text: '创建' });
    ok.addEventListener('click', async () => {
      try {
        const file = await this.plugin.pages.create(titleInput.value, contentInput.value);
        this.close();
        if (file) {
          void this.plugin.app.workspace.openLinkText(file.path, '', false);
          this.plugin.refreshConsole();
        }
      } catch (err) {
        console.error('Cowrite AI: 新建页面失败', err);
        new Notice(`Cowrite AI: 新建页面失败 - ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const cancel = btns.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// 投递任务
// ---------------------------------------------------------------------------

export class NewTaskModal extends Modal {
  private plugin: CowriteAIPlugin;
  private presetFile: TFile | null;

  constructor(app: App, plugin: CowriteAIPlugin, presetFile?: TFile) {
    super(app);
    this.plugin = plugin;
    this.presetFile = presetFile ?? null;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '投递 Cowrite 任务' });

    const actions: ActionConfig[] = await this.plugin.actions.list();
    const actionSel = contentEl.createEl('select', { cls: 'cowrite-input' });
    actions.forEach((a) => {
      const opt = actionSel.createEl('option', { text: `${a.label} (${a.id})`, value: a.id });
      opt.value = a.id;
    });

    const files = await this.plugin.pages.list();
    const pageSel = contentEl.createEl('select', { cls: 'cowrite-input' });
    if (this.presetFile) {
      const opt = pageSel.createEl('option', { text: this.presetFile.path, value: this.presetFile.path });
      opt.value = this.presetFile.path;
    }
    files.forEach((f) => {
      if (this.presetFile && f.path === this.presetFile.path) return;
      const opt = pageSel.createEl('option', { text: f.path, value: f.path });
      opt.value = f.path;
    });

    const reqInput = contentEl.createEl('textarea', { placeholder: '补充要求（可选，例如：聚焦 35 岁女性职场读者）' });
    reqInput.addClass('cowrite-textarea');

    const btns = contentEl.createDiv({ cls: 'cowrite-modal-btns' });
    const ok = btns.createEl('button', { text: '投递' });
    ok.addEventListener('click', async () => {
      const actionId = actionSel.value;
      const pagePath = pageSel.value;
      const action = actions.find((a) => a.id === actionId);
      if (!pagePath) {
        new Notice('Cowrite AI: 请选择目标页面');
        return;
      }
      try {
        const task = await this.plugin.tasks.create(
          {
            action: actionId,
            pagePath,
            requirements: reqInput.value || undefined,
          },
          action?.skills ?? [],
        );
        new Notice(`Cowrite AI: 任务 ${task.id} 已投递（${action?.label ?? actionId}）`);
        this.close();
        this.plugin.refreshConsole();
      } catch (err) {
        console.error('Cowrite AI: 投递任务失败', err);
        new Notice(`Cowrite AI: 投递失败 - ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const cancel = btns.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// 设置页
// ---------------------------------------------------------------------------

class CowriteSettingTab extends PluginSettingTab {
  plugin: CowriteAIPlugin;

  constructor(app: App, plugin: CowriteAIPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Cowrite AI 设置' });

    // ---- LLM 接入 ----
    containerEl.createEl('h3', { text: 'LLM 接入' });
    new Setting(containerEl)
      .setName('API Base URL')
      .setDesc('OpenAI 兼容接口地址，例如 https://api.openai.com/v1 或自建网关 /v1')
      .addText((text) =>
        text
          .setPlaceholder('https://api.openai.com/v1')
          .setValue(this.plugin.settings.apiBase)
          .onChange(async (value) => {
            this.plugin.settings.apiBase = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Bearer 鉴权密钥，仅保存在本地 data.json')
      .addText((text) =>
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName('模型名称')
      .setDesc('例如 gpt-4o-mini / deepseek-chat / qwen-plus / kimi-k2')
      .addText((text) =>
        text
          .setPlaceholder('gpt-4o-mini')
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim() || 'gpt-4o-mini';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Temperature')
      .setDesc('采样温度 0~2，越低越稳定')
      .addSlider((slider) =>
        slider
          .setLimits(0, 2, 0.1)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.temperature = value;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName('最大生成 token')
      .setDesc('单次请求 max_tokens')
      .addText((text) =>
        text
          .setPlaceholder('2048')
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.maxTokens = n;
              await this.plugin.saveData(this.plugin.settings);
            }
          }),
      );

    new Setting(containerEl)
      .setName('请求超时（毫秒）')
      .setDesc('单次 LLM 请求超时时间')
      .addText((text) =>
        text
          .setPlaceholder('60000')
          .setValue(String(this.plugin.settings.requestTimeoutMs))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.requestTimeoutMs = n;
              await this.plugin.saveData(this.plugin.settings);
            }
          }),
      );

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('使用当前配置发送一条 ping 消息')
      .addButton((btn) =>
        btn
          .setButtonText('发送测试')
          .setCta()
          .onClick(async () => {
            const origText = btn.buttonEl.textContent || '发送测试';
            btn.setDisabled(true);
            btn.buttonEl.textContent = '测试中...';
            const r = await testConnection(this.plugin.settings);
            btn.setDisabled(false);
            btn.buttonEl.textContent = origText;
            new Notice(`Cowrite AI: ${r.message}`, r.ok ? 4000 : 8000);
          }),
      );

    // ---- 配图 ----
    containerEl.createEl('h3', { text: '配图' });
    new Setting(containerEl)
      .setName('配图 API Base')
      .setDesc('OpenAI 兼容 images/generations 接口地址，留空则禁用配图工具')
      .addText((text) =>
        text
          .setPlaceholder('https://api.openai.com/v1')
          .setValue(this.plugin.settings.imageApiBase)
          .onChange(async (value) => {
            this.plugin.settings.imageApiBase = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          }),
      );
    new Setting(containerEl)
      .setName('配图 API Key')
      .setDesc('留空则回退使用主 API Key')
      .addText((text) =>
        text
          .setPlaceholder('（留空用主 key）')
          .setValue(this.plugin.settings.imageApiKey)
          .onChange(async (value) => {
            this.plugin.settings.imageApiKey = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          }),
      );
    new Setting(containerEl)
      .setName('配图模型')
      .setDesc('例如 dall-e-3 / stable-diffusion 兼容')
      .addText((text) =>
        text
          .setPlaceholder('dall-e-3')
          .setValue(this.plugin.settings.imageModel)
          .onChange(async (value) => {
            this.plugin.settings.imageModel = value.trim() || 'dall-e-3';
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    // ---- 执行引擎 ----
    containerEl.createEl('h3', { text: '执行引擎' });
    new Setting(containerEl)
      .setName('启用内置执行器')
      .setDesc('插件自动轮询任务队列并调用 Agent 执行')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.executorEnabled).onChange(async (value) => {
          this.plugin.settings.executorEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('默认模式')
      .setDesc('ask=只读问答；write=可写笔记（写操作需审批）')
      .addDropdown((dd) =>
        dd
          .addOption('ask', '问答（只读）')
          .addOption('write', '创作（可写）')
          .setValue(this.plugin.settings.defaultMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultMode = value === 'ask' ? 'ask' : 'write';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('最大轮次')
      .setDesc('单个任务最多 agent 轮次（防死循环）')
      .addText((text) =>
        text
          .setPlaceholder('12')
          .setValue(String(this.plugin.settings.maxTurns))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.maxTurns = n;
              await this.plugin.saveData(this.plugin.settings);
            }
          }),
      );

    new Setting(containerEl)
      .setName('上下文压缩触发比例')
      .setDesc('历史 token 占用 contextWindow 该比例时开始压缩（0.5~0.95）')
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 0.95, 0.05)
          .setValue(this.plugin.settings.compactThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.compactThreshold = value;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName('压缩保留尾部比例')
      .setDesc('压缩时保留最近历史的比例（0.08~0.4）')
      .addSlider((slider) =>
        slider
          .setLimits(0.08, 0.4, 0.02)
          .setValue(this.plugin.settings.compactRetain)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.compactRetain = value;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName('并发数')
      .setDesc('同时执行的任务数（1~3）')
      .addSlider((slider) =>
        slider
          .setLimits(1, 3, 1)
          .setValue(this.plugin.settings.concurrency)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.concurrency = Math.floor(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('轮询间隔（毫秒）')
      .setDesc('检查任务队列的频率')
      .addText((text) =>
        text
          .setPlaceholder('3000')
          .setValue(String(this.plugin.settings.pollIntervalMs))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 500) {
              this.plugin.settings.pollIntervalMs = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    // ---- 存储 ----
    containerEl.createEl('h3', { text: '存储' });
    new Setting(containerEl)
      .setName('页面目录')
      .setDesc('Cowrite 页面存放的 vault 内目录（相对路径）')
      .addText((text) =>
        text
          .setPlaceholder('Cowrite')
          .setValue(this.plugin.settings.pagesDir)
          .onChange(async (value) => {
            this.plugin.settings.pagesDir = value.trim() || 'Cowrite';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('任务文件')
      .setDesc('任务队列 JSON 文件（vault 内相对路径）')
      .addText((text) =>
        text
          .setPlaceholder('.cowrite/tasks.json')
          .setValue(this.plugin.settings.tasksFile)
          .onChange(async (value) => {
            this.plugin.settings.tasksFile = value.trim() || '.cowrite/tasks.json';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('动作配置文件')
      .setDesc('动作 prompt 模板 JSON 文件（vault 内相对路径）')
      .addText((text) =>
        text
          .setPlaceholder('.cowrite/actions.json')
          .setValue(this.plugin.settings.actionsFile)
          .onChange(async (value) => {
            this.plugin.settings.actionsFile = value.trim() || '.cowrite/actions.json';
            await this.plugin.saveSettings();
          }),
      );

    // ---- 其他 ----
    containerEl.createEl('h3', { text: '其他' });
    new Setting(containerEl)
      .setName('启动时打开控制台')
      .setDesc('Obsidian 启动时自动打开 Cowrite AI 控制台')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openOnStart).onChange(async (value) => {
          this.plugin.settings.openOnStart = value;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl('p', {
      cls: 'cowrite-desc',
      text: '所有任务数据与页面均保存在你的 Obsidian vault 内，API Key 仅保存在插件 data.json，不会上传到任何第三方。',
    });
  }
}
