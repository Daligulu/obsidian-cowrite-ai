import {
  App,
  ButtonComponent,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from 'obsidian';
import { CowriteSettings, DEFAULT_SETTINGS, normalizeSettings } from './settings';
import { testConnection } from './llm';
import { getSelection, getFullText, replaceSelection, replaceFullText } from './editorContext';
import { rewrite, rewriteLabel, RewriteMode } from './rewrite';
import { generateImages } from './imageGen';
import { formatMarkdown } from './formatMd';
import {
  PUBLISH_PLATFORMS,
  PLATFORM_LABEL,
  PublishPlatform,
  getConfiguredToken,
  publish,
} from './publish';

export const VIEW_TYPE_COWRITE = 'cowrite-ai-toolbar';

// ---------------------------------------------------------------------------
// 主插件类
// ---------------------------------------------------------------------------

export default class CowriteAIPlugin extends Plugin {
  settings: CowriteSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    this.settings = normalizeSettings(await this.loadData());

    this.registerView(VIEW_TYPE_COWRITE, (leaf) => new CowriteToolbarView(leaf, this));

    this.addRibbonIcon('lucide-pen-tool', '打开 Cowrite AI 工具条', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-cowrite-toolbar',
      name: '打开 Cowrite AI 工具条',
      callback: () => void this.activateView(),
    });

    this.addSettingTab(new CowriteSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openOnStart) {
        void this.activateView();
      }
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_COWRITE);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_COWRITE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_COWRITE, active: true });
      }
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

// ---------------------------------------------------------------------------
// 工具条视图（4 个按钮纵向排列）
// ---------------------------------------------------------------------------

class CowriteToolbarView extends ItemView {
  private plugin: CowriteAIPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: CowriteAIPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_COWRITE;
  }

  getDisplayText(): string {
    return 'Cowrite AI';
  }

  getIcon(): string {
    return 'lucide-pen-tool';
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('cowrite-toolbar');

    const header = contentEl.createDiv({ cls: 'cowrite-toolbar-header' });
    header.createEl('span', { cls: 'cowrite-toolbar-title', text: 'Cowrite AI' });
    const gear = header.createEl('button', { cls: 'cowrite-gear', attr: { 'aria-label': '打开设置' } });
    gear.setText('⚙');
    gear.addEventListener('click', () => {
      const s = (this.plugin.app as any).setting;
      s?.open?.();
      s?.openTabById?.(this.plugin.manifest.id);
    });

    const btnRewrite = this.makeButton(contentEl, '✏️', '文章改写');
    const btnImage = this.makeButton(contentEl, '🖼️', '文章配图');
    const btnFormat = this.makeButton(contentEl, '📐', '文章排版');
    const btnPublish = this.makeButton(contentEl, '📤', '文章发布');

    btnRewrite.onClick(async () => {
      await withBusy(btnRewrite, '✏️', async () => {
        await this.handleRewrite();
      });
    });
    btnImage.onClick(async () => {
      await withBusy(btnImage, '🖼️', async () => {
        await this.handleImage();
      });
    });
    btnFormat.onClick(async () => {
      await withBusy(btnFormat, '📐', async () => {
        await this.handleFormat();
      });
    });
    btnPublish.onClick(async () => {
      await withBusy(btnPublish, '📤', async () => {
        await this.handlePublish();
      });
    });
  }

  async onClose() {
    this.contentEl.empty();
  }

  private makeButton(container: HTMLElement, icon: string, label: string): ButtonComponent {
    const btn = new ButtonComponent(container);
    btn.setButtonText(`${icon} ${label}`);
    btn.buttonEl.addClass('cowrite-action-btn');
    return btn;
  }

  // ---- 按钮 1：文章改写 ----
  private async handleRewrite(): Promise<void> {
    const sel = getSelection(this.app);
    const ctx = await getFullText(this.app);
    if (!ctx) {
      new Notice('请先打开一篇笔记');
      return;
    }
    const picked = await openRewriteModal(this.app);
    if (!picked) return;
    const { mode, targetLang } = picked;

    const source = sel ? sel : ctx.content;
    const out = await rewrite(mode, source, targetLang, this.plugin.settings);

    if (sel) {
      replaceSelection(this.app, out);
    } else {
      await replaceFullText(this.app, ctx.file, out);
    }

    if (mode === 'expand') {
      new Notice(`已扩写至 ${out.length} 字`);
    } else {
      new Notice(`已完成${rewriteLabel(mode)}`);
    }
  }

  // ---- 按钮 2：文章配图 ----
  private async handleImage(): Promise<void> {
    const ctx = await getFullText(this.app);
    if (!ctx) {
      new Notice('请先打开一篇笔记');
      return;
    }
    const pos = await openImageModal(this.app);
    if (!pos) return;

    // 从正文提取提示词（前 200 字，粗略去掉 markdown 符号）
    const promptRaw = ctx.content.replace(/[#>*`\[\]()!\-_]/g, ' ').replace(/\s+/g, ' ').trim();
    const prompt = promptRaw.slice(0, 200) || ctx.file.basename;

    // 决定生成几张
    let count = 1;
    if (pos === 'between') {
      const blocks = ctx.content.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
      count = Math.max(1, Math.min(3, blocks.length - 1));
    }

    const buffers = await generateImages(prompt, count, this.plugin.settings);

    // 写回 vault/attachments/
    const dir = this.plugin.settings.attachmentsDir;
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(dir))) {
      await adapter.mkdir(dir).catch(() => undefined);
    }
    const names: string[] = [];
    for (let i = 0; i < buffers.length; i++) {
      const fname = `cowrite-${Date.now()}-${i}.png`;
      const fpath = `${dir}/${fname}`;
      await this.app.vault.createBinary(fpath, buffers[i]);
      names.push(fpath);
    }

    // 插入 Markdown 图片语法
    let md = ctx.content;
    const imgTags = names.map((n) => `![image](${n})`);
    if (pos === 'start') {
      md = `${imgTags.join('\n\n')}\n\n${md}`;
    } else if (pos === 'end') {
      md = `${md.replace(/\s+$/, '')}\n\n${imgTags.join('\n')}\n`;
    } else {
      // between：在段落块之间依次插入
      const parts = md.split(/(\n\s*\n)/);
      // 只在非空块之间插入
      const blocks: string[] = [];
      let sep = '';
      for (let i = 0; i < parts.length; i++) {
        if (/^\s*$/.test(parts[i])) {
          sep = parts[i];
        } else {
          blocks.push(parts[i]);
        }
      }
      let result = blocks[0] ?? '';
      for (let i = 1; i < blocks.length; i++) {
        const tag = imgTags[Math.min(i - 1, imgTags.length - 1)] ?? imgTags[0];
        result += `\n\n${tag}\n\n` + blocks[i];
      }
      md = result + '\n';
    }

    await replaceFullText(this.app, ctx.file, md);
    new Notice(`已插入 ${names.length} 张配图`);
  }

  // ---- 按钮 3：文章排版 ----
  private async handleFormat(): Promise<void> {
    const ctx = await getFullText(this.app);
    if (!ctx) {
      new Notice('请先打开一篇笔记');
      return;
    }
    const formatted = formatMarkdown(ctx.content);
    if (formatted !== ctx.content) {
      await replaceFullText(this.app, ctx.file, formatted);
    }
    new Notice('已排版');
  }

  // ---- 按钮 4：文章发布 ----
  private async handlePublish(): Promise<void> {
    const ctx = await getFullText(this.app);
    if (!ctx) {
      new Notice('请先打开一篇笔记');
      return;
    }
    const platform = await openPublishModal(this.app, this.plugin.settings);
    if (!platform) return;
    try {
      const r = await publish(platform, ctx.content, this.plugin.settings);
      new Notice(r.message);
    } catch (e) {
      new Notice(`发布失败：${(e as Error).message || String(e)}`);
    }
  }
}

/** 按钮 loading 包装：置灰 + “处理中...”，结束后恢复 */
async function withBusy(
  btn: ButtonComponent,
  restoreText: string,
  fn: () => Promise<void>,
): Promise<void> {
  btn.setDisabled(true);
  const original = btn.buttonEl.textContent ?? restoreText;
  btn.setButtonText('处理中...');
  btn.buttonEl.addClass('cowrite-busy');
  try {
    await fn();
  } finally {
    btn.buttonEl.removeClass('cowrite-busy');
    btn.setButtonText(original);
    btn.setDisabled(false);
  }
}

// ---------------------------------------------------------------------------
// Modal：文章改写
// ---------------------------------------------------------------------------

interface RewriteChoice {
  mode: RewriteMode;
  targetLang?: string;
}

function openRewriteModal(app: App): Promise<RewriteChoice | null> {
  return new Promise((resolve) => {
    let done = false;
    const modal = new Modal(app);
    modal.titleEl.setText('文章改写');

    let mode: RewriteMode = 'polish';
    const langInput = modal.contentEl.createEl('input', {
      type: 'text',
      placeholder: '目标语言，例如 English / 日文',
    });
    langInput.addClass('cowrite-input');
    langInput.style.display = 'none';

    const modeSel = modal.contentEl.createEl('select', { cls: 'cowrite-input' });
    (['polish', 'expand', 'shorten', 'translate'] as RewriteMode[]).forEach((m) => {
      const opt = modeSel.createEl('option', { text: rewriteLabel(m), value: m });
      opt.value = m;
    });
    modeSel.addEventListener('change', () => {
      mode = (modeSel.value as RewriteMode) || 'polish';
      langInput.style.display = mode === 'translate' ? '' : 'none';
    });

    const btns = modal.contentEl.createDiv({ cls: 'cowrite-modal-btns' });
    const ok = btns.createEl('button', { text: '确认' });
    ok.addClass('mod-cta');
    const cancel = btns.createEl('button', { text: '取消' });

    const finish = (v: RewriteChoice | null) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };
    ok.addEventListener('click', () => {
      const targetLang = mode === 'translate' ? (langInput.value.trim() || '英文') : undefined;
      finish({ mode, targetLang });
    });
    cancel.addEventListener('click', () => finish(null));
    modal.onClose = () => finish(null);
    modal.open();
  });
}

// ---------------------------------------------------------------------------
// Modal：文章配图
// ---------------------------------------------------------------------------

type ImagePos = 'start' | 'between' | 'end';

function openImageModal(app: App): Promise<ImagePos | null> {
  return new Promise((resolve) => {
    let done = false;
    const modal = new Modal(app);
    modal.titleEl.setText('文章配图');
    const sel = modal.contentEl.createEl('select', { cls: 'cowrite-input' });
    [
      { v: 'start', t: '开头' },
      { v: 'between', t: '每段之间' },
      { v: 'end', t: '结尾' },
    ].forEach((o) => {
      const opt = sel.createEl('option', { text: o.t, value: o.v });
      opt.value = o.v;
    });
    const btns = modal.contentEl.createDiv({ cls: 'cowrite-modal-btns' });
    const ok = btns.createEl('button', { text: '生成' });
    ok.addClass('mod-cta');
    const cancel = btns.createEl('button', { text: '取消' });
    const finish = (v: ImagePos | null) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };
    ok.addEventListener('click', () => finish((sel.value as ImagePos) || 'start'));
    cancel.addEventListener('click', () => finish(null));
    modal.onClose = () => finish(null);
    modal.open();
  });
}

// ---------------------------------------------------------------------------
// Modal：文章发布
// ---------------------------------------------------------------------------

function openPublishModal(app: App, settings: CowriteSettings): Promise<PublishPlatform | null> {
  return new Promise((resolve) => {
    let done = false;
    let platform: PublishPlatform = PUBLISH_PLATFORMS[0];
    const modal = new Modal(app);
    modal.titleEl.setText('文章发布');

    const sel = modal.contentEl.createEl('select', { cls: 'cowrite-input' });
    PUBLISH_PLATFORMS.forEach((p) => {
      const opt = sel.createEl('option', { text: PLATFORM_LABEL[p], value: p });
      opt.value = p;
    });

    const tokenWrap = modal.contentEl.createDiv();
    const renderTokenHint = () => {
      tokenWrap.empty();
      const configured = getConfiguredToken(settings, platform);
      const note = tokenWrap.createEl('div', {
        cls: 'cowrite-desc',
        text: configured ? `已配置 ${PLATFORM_LABEL[platform]} token（可在设置中修改）` : `尚未配置 ${PLATFORM_LABEL[platform]} token`,
      });
      void note;
    };
    sel.addEventListener('change', () => {
      platform = (sel.value as PublishPlatform) || PUBLISH_PLATFORMS[0];
      renderTokenHint();
    });
    renderTokenHint();

    const btns = modal.contentEl.createDiv({ cls: 'cowrite-modal-btns' });
    const ok = btns.createEl('button', { text: '下一步' });
    ok.addClass('mod-cta');
    const cancel = btns.createEl('button', { text: '取消' });
    const finish = (v: PublishPlatform | null) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };
    ok.addEventListener('click', () => finish(platform));
    cancel.addEventListener('click', () => finish(null));
    modal.onClose = () => finish(null);
    modal.open();
  });
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

    // ---- LLM 配置 ----
    containerEl.createEl('h3', { text: 'LLM 配置' });
    new Setting(containerEl)
      .setName('API Base')
      .setDesc('OpenAI 兼容接口地址')
      .addText((t) =>
        t.setPlaceholder('https://api.openai.com/v1')
          .setValue(this.plugin.settings.apiBase)
          .onChange(async (v) => {
            this.plugin.settings.apiBase = v.trim() || DEFAULT_SETTINGS.apiBase;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Bearer 鉴权密钥，仅保存在本地 data.json')
      .addText((t) =>
        t.setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Model')
      .setDesc('模型名称，例如 gpt-4o-mini / deepseek-chat')
      .addText((t) =>
        t.setPlaceholder('gpt-4o-mini')
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v.trim() || DEFAULT_SETTINGS.model;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Temperature')
      .setDesc('采样温度 0~2')
      .addSlider((s) =>
        s.setLimits(0, 2, 0.1)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.temperature = v;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('使用当前配置发送一条 ping')
      .addButton((b) =>
        b.setButtonText('发送测试')
          .setCta()
          .onClick(async () => {
            const orig = b.buttonEl.textContent || '发送测试';
            b.setDisabled(true);
            b.buttonEl.textContent = '测试中...';
            const r = await testConnection(this.plugin.settings);
            b.setDisabled(false);
            b.buttonEl.textContent = orig;
            new Notice(`Cowrite AI: ${r.message}`, r.ok ? 4000 : 8000);
          }),
      );

    // ---- 图像生成配置 ----
    containerEl.createEl('h3', { text: '图像生成配置' });
    new Setting(containerEl)
      .setName('Image API Base')
      .setDesc('OpenAI 兼容 images/generations 接口地址')
      .addText((t) =>
        t.setPlaceholder('https://api.openai.com/v1')
          .setValue(this.plugin.settings.imageApiBase)
          .onChange(async (v) => {
            this.plugin.settings.imageApiBase = v.trim() || DEFAULT_SETTINGS.imageApiBase;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Image API Key')
      .setDesc('留空则使用主 API Key')
      .addText((t) =>
        t.setPlaceholder('（留空用主 key）')
          .setValue(this.plugin.settings.imageApiKey)
          .onChange(async (v) => {
            this.plugin.settings.imageApiKey = v.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Image Model')
      .setDesc('例如 dall-e-3')
      .addText((t) =>
        t.setPlaceholder('dall-e-3')
          .setValue(this.plugin.settings.imageModel)
          .onChange(async (v) => {
            this.plugin.settings.imageModel = v.trim() || DEFAULT_SETTINGS.imageModel;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Image Size')
      .setDesc('例如 1024x1024 / 1792x1024')
      .addText((t) =>
        t.setPlaceholder('1024x1024')
          .setValue(this.plugin.settings.imageSize)
          .onChange(async (v) => {
            this.plugin.settings.imageSize = v.trim() || DEFAULT_SETTINGS.imageSize;
            await this.plugin.saveSettings();
          }),
      );

    // ---- 发布平台配置（预留 UI） ----
    containerEl.createEl('h3', { text: '发布平台配置（预留）' });
    const tokenFields: Array<{ name: string; key: 'wechatToken' | 'zhihuToken' | 'xiaohongshuToken' | 'juejinToken' }> = [
      { name: '公众号 token', key: 'wechatToken' },
      { name: '知乎 token', key: 'zhihuToken' },
      { name: '小红书 token', key: 'xiaohongshuToken' },
      { name: '掘金 token', key: 'juejinToken' },
    ];
    for (const f of tokenFields) {
      new Setting(containerEl)
        .setName(f.name)
        .setDesc('发布 API 尚未接入，先预留配置位')
        .addText((t) =>
          t.setPlaceholder('token / cookie')
            .setValue(this.plugin.settings[f.key])
            .onChange(async (v) => {
              this.plugin.settings[f.key] = v.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    // ---- 其他 ----
    containerEl.createEl('h3', { text: '其他' });
    new Setting(containerEl)
      .setName('启动时打开工具条')
      .setDesc('Obsidian 启动时自动打开右侧工具条')
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.openOnStart).onChange(async (v) => {
          this.plugin.settings.openOnStart = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('附件目录')
      .setDesc('配图写入 vault 内的相对目录')
      .addText((t) =>
        t.setPlaceholder('attachments')
          .setValue(this.plugin.settings.attachmentsDir)
          .onChange(async (v) => {
            this.plugin.settings.attachmentsDir = v.trim() || 'attachments';
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('p', {
      cls: 'cowrite-desc',
      text: '所有处理均在本地完成，API Key 仅保存在插件 data.json。',
    });
  }
}
