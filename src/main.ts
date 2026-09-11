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

export const VIEW_TYPE_COWRITE = 'cowrite-ai-console';

/**
 * Cowrite AI 主插件类。
 * 自包含：页面仓库 + 任务队列 + 内置 LLM 执行引擎，
 * 全部运行在 Obsidian 内（移动端可用），通过用户配置的 OpenAI 兼容 API 驱动。
 */
export default class CowriteAIPlugin extends Plugin {
  settings: CowriteSettings = { ...DEFAULT_SETTINGS };
  pages!: PageStore;
  tasks!: TaskStore;
  actions!: ActionStore;
  executor!: Executor;

  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.pages = new PageStore(this.app.vault, this.settings.pagesDir);
    this.tasks = new TaskStore(this.app.vault, this.settings.tasksFile);
    this.actions = new ActionStore(this.app.vault, this.settings.actionsFile);
    this.executor = new Executor(this);

    // 注册控制台视图
    this.registerView(VIEW_TYPE_COWRITE, (leaf) => new CowriteConsoleView(leaf, this));

    // 功能区图标：打开控制台
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

    // 启动执行器
    if (this.settings.executorEnabled) {
      this.executor.start();
    }

    // 延迟初始化：启动时打开控制台
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

  /** 切换执行器启停 */
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

  /** 刷新所有控制台视图 */
  refreshConsole(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_COWRITE).forEach((leaf) => {
      if (leaf.view instanceof CowriteConsoleView) {
        void leaf.view.refresh();
      }
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // 设置变更后重建 store，并按新配置重启执行器
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
  private statusEl!: HTMLElement;
  private btnToggle!: HTMLButtonElement;

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

    await this.refresh();
  }

  async onClose() {
    this.contentEl.empty();
  }

  /** 刷新页面列表与任务队列 */
  async refresh(): Promise<void> {
    if (!this.contentEl || this.contentEl.children.length === 0) return;

    // 工具栏启停按钮文案
    if (this.btnToggle) {
      this.btnToggle.textContent = this.plugin.executor.isRunning() ? '⏸ 暂停执行器' : '▶ 启动执行器';
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

    // 状态行
    const running = tasks.filter((t) => t.status === 'running').length;
    const queued = tasks.filter((t) => t.status === 'queued').length;
    const done = tasks.filter((t) => t.status === 'succeeded').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    const execState = this.plugin.executor.isRunning() ? '运行中' : '已暂停';
    this.statusEl.setText(
      `执行器：${execState} · 排队 ${queued} · 进行中 ${running} · 成功 ${done} · 失败 ${failed}`,
    );
  }

  private renderTask(task: CowriteTask): void {
    const row = this.taskListEl.createDiv({ cls: `cowrite-task-row cowrite-task-${task.status}` });

    const head = row.createDiv({ cls: 'cowrite-task-head' });
    head.createEl('span', { cls: 'cowrite-task-action', text: task.action });
    head.createEl('span', { cls: `cowrite-task-status cowrite-task-status-${task.status}`, text: task.status });

    if (task.pagePath) {
      row.createEl('div', { cls: 'cowrite-task-meta', text: `页面: ${task.pagePath}` });
    }
    if (task.workerId) {
      row.createEl('div', { cls: 'cowrite-task-meta', text: `Worker: ${task.workerId}` });
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

    const ops = row.createDiv({ cls: 'cowrite-task-ops' });
    if (task.status === 'failed') {
      const retry = ops.createEl('button', { cls: 'cowrite-btn-small', text: '重试' });
      retry.addEventListener('click', async () => {
        await this.plugin.tasks.retry(task.id);
        new Notice(`Cowrite AI: 任务 ${task.id} 已回到排队`);
        await this.refresh();
      });
    }
    if (task.status === 'queued') {
      const cancel = ops.createEl('button', { cls: 'cowrite-btn-small', text: '取消' });
      cancel.addEventListener('click', async () => {
        await this.plugin.tasks.cancel(task.id);
        await this.refresh();
      });
    }
    const del = ops.createEl('button', { cls: 'cowrite-btn-small', text: '删除' });
    del.addEventListener('click', async () => {
      await this.plugin.tasks.remove(task.id);
      await this.refresh();
    });
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
      const file = await this.plugin.pages.create(titleInput.value, contentInput.value);
      this.close();
      if (file) {
        void this.plugin.app.workspace.openLinkText(file.path, '', false);
        this.plugin.refreshConsole();
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

    // 动作
    const actions: ActionConfig[] = await this.plugin.actions.list();
    const actionSel = contentEl.createEl('select', { cls: 'cowrite-input' });
    actions.forEach((a) => {
      const opt = actionSel.createEl('option', { text: `${a.label} (${a.id})`, value: a.id });
      opt.value = a.id;
    });

    // 页面
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

    // 测试连接按钮
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

    // ---- 执行引擎 ----
    containerEl.createEl('h3', { text: '执行引擎' });
    new Setting(containerEl)
      .setName('启用内置执行器')
      .setDesc('插件自动轮询任务队列并调用 LLM 执行')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.executorEnabled).onChange(async (value) => {
          this.plugin.settings.executorEnabled = value;
          await this.plugin.saveSettings();
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
