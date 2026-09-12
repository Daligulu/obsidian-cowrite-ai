import {
  App,
  ButtonComponent,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from 'obsidian';
import {
  CowriteSettings,
  DEFAULT_SETTINGS,
  IMAGE_SIZE_MAP,
  IMAGE_SIZE_PRESETS,
  ImageSizePreset,
  normalizeSettings,
  resolveImageSize,
} from './settings';
import { parseError, testConnection } from './llm';
import { getSelection, getFullText, replaceFullText } from './editorContext';
import { rewrite, rewriteLabel, RewriteMode } from './rewrite';
import { buildImagePrompt, generateImages } from './imageGen';
import {
  getImageStyle,
  IMAGE_STYLE_PRESETS,
  type ImageStylePreset,
} from './imageStyles';
import { formatMarkdown, markdownToWechatHtml, smartFormatWithLLM } from './formatMd';
import { GZH_THEMES, getTheme } from './themes';
import {
  isWechatConfigured,
  PUBLISH_PLATFORMS,
  PLATFORM_LABEL,
  PublishPlatform,
  publishWechatDraft,
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
      try {
        await this.handleRewrite(btnRewrite);
      } catch (e) {
        new Notice(`改写失败：${parseError(e)}`, 8000);
      }
    });
    btnImage.onClick(async () => {
      try {
        await this.handleImage(btnImage);
      } catch (e) {
        new Notice(`配图失败：${parseError(e)}`, 8000);
      }
    });
    btnFormat.onClick(async () => {
      try {
        await this.handleFormat(btnFormat);
      } catch (e) {
        new Notice(`排版失败：${parseError(e)}`, 8000);
      }
    });
    btnPublish.onClick(async () => {
      try {
        await this.handlePublish(btnPublish);
      } catch (e) {
        new Notice(`发布失败：${parseError(e)}`, 8000);
      }
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

  // ---- 按钮 1：文章改写（SSE 流式逐字替换） ----
  private async handleRewrite(btn: ButtonComponent): Promise<void> {
    const sel = getSelection(this.app);
    const ctx = await getFullText(this.app);
    if (!ctx) {
      new Notice('请先打开一篇笔记');
      return;
    }
    const picked = await openRewriteModal(this.app);
    if (!picked) return;
    const { mode, targetLang } = picked;

    const source = sel && sel.length > 0 ? sel : ctx.content;
    const actionName = rewriteLabel(mode);

    btn.setDisabled(true);
    const original = btn.buttonEl.textContent ?? '';
    btn.setButtonText(`正在${actionName}...`);
    btn.buttonEl.addClass('cowrite-busy');
    try {
      // 捕获编辑器替换区间
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const editor = view?.editor;
      let from: { line: number; ch: number } | null = null;
      let to: { line: number; ch: number } | null = null;
      if (editor) {
        const hasSel = editor.getSelection().length > 0;
        if (hasSel) {
          from = editor.getCursor('from');
          to = editor.getCursor('to');
        } else {
          from = { line: 0, ch: 0 };
          const total = editor.getValue().length;
          to = editor.offsetToPos(total);
        }
      }

      let first = true;
      await rewrite(mode, source, targetLang, this.plugin.settings, (delta, fullSoFar) => {
        void delta;
        const ed = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
        if (!ed || !from || !to) return;
        if (first) {
          ed.replaceRange(fullSoFar, from, to);
          first = false;
        } else {
          const startOff = ed.posToOffset(from);
          const curEnd = ed.offsetToPos(startOff + fullSoFar.length);
          ed.replaceRange(fullSoFar, from, curEnd);
        }
      });
      new Notice(`已完成${actionName}`);
    } finally {
      btn.buttonEl.removeClass('cowrite-busy');
      btn.setButtonText(original);
      btn.setDisabled(false);
    }
  }

  // ---- 按钮 2：文章配图（LLM 生成 prompt，逐张生成） ----
  private async handleImage(btn: ButtonComponent): Promise<void> {
    const ctx = await getFullText(this.app);
    if (!ctx) {
      new Notice('请先打开一篇笔记');
      return;
    }
    const picked = await openImageModal(this.app, this.plugin.settings);
    if (!picked) return;
    const { pos, stylePreset, sizePreset, customDesc } = picked;

    // 记住本次选择，下次打开弹窗预填
    this.plugin.settings.lastImageStyle = picked.styleId;
    this.plugin.settings.lastCustomStyle = customDesc;
    this.plugin.settings.imageSizePreset = sizePreset;
    await this.plugin.saveSettings();

    btn.setDisabled(true);
    const original = btn.buttonEl.textContent ?? '';
    btn.setButtonText('正在理解文章...');
    btn.buttonEl.addClass('cowrite-busy');
    try {
      // 提取标题 + 开头 300 字给 LLM 生成配图 prompt
      const titleMatch = /^#\s+(.+)$/m.exec(ctx.content);
      const title = titleMatch ? titleMatch[1].trim() : ctx.file.basename;
      const plainHead = ctx.content
        .replace(/[#>*`\[\]()!\-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const prompt = await buildImagePrompt(title, plainHead, this.plugin.settings);

      // 尺寸：用弹窗里选的预设
      const size = resolveImageSize(sizePreset);

      // 决定生成几张
      let count = 1;
      if (pos === 'between') {
        const blocks = ctx.content.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
        count = Math.max(1, Math.min(3, blocks.length - 1));
      }

      // 逐张生成
      const dir = this.plugin.settings.attachmentsDir;
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(dir))) {
        await adapter.mkdir(dir).catch(() => undefined);
      }
      const ts = Date.now();
      const names: string[] = [];
      for (let i = 0; i < count; i++) {
        btn.setButtonText(`正在生成配图 ${i + 1}/${count}...`);
        const buffers = await generateImages(prompt, 1, this.plugin.settings, {
          size,
          stylePreset,
          customSuffix: customDesc,
        });
        const fname = `cowrite-${ts}-${i}.png`;
        const fpath = `${dir}/${fname}`;
        await this.app.vault.createBinary(fpath, buffers[0]);
        names.push(fpath);
      }

      // 插入 Markdown 图片语法
      let md = ctx.content;
      const imgTags = names.map((n) => `![](${n})`);
      if (pos === 'start') {
        md = `${imgTags.join('\n\n')}\n\n${md}`;
      } else if (pos === 'end') {
        md = `${md.replace(/\s+$/, '')}\n\n${imgTags.join('\n')}\n`;
      } else {
        const parts = md.split(/(\n\s*\n)/);
        const blocks: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          if (!/^\s*$/.test(parts[i])) blocks.push(parts[i]);
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
    } finally {
      btn.buttonEl.removeClass('cowrite-busy');
      btn.setButtonText(original);
      btn.setDisabled(false);
    }
  }

  // ---- 按钮 3：文章排版（规则 / 智能 / 导出公众号 HTML） ----
  private async handleFormat(btn: ButtonComponent): Promise<void> {
    const ctx = await getFullText(this.app);
    if (!ctx) {
      new Notice('请先打开一篇笔记');
      return;
    }
    const choice = await openFormatModal(this.app, this.plugin.settings.gzhTheme, ctx.content);
    if (choice === null) return;

    // c) 导出公众号 HTML：弹窗内已完成复制，这里直接返回
    if (choice.kind === 'html') {
      return;
    }

    const useSmart = choice.kind === 'smart';
    btn.setDisabled(true);
    const original = btn.buttonEl.textContent ?? '';
    btn.setButtonText(useSmart ? '正在智能排版...' : '正在排版...');
    btn.buttonEl.addClass('cowrite-busy');
    try {
      let formatted: string;
      if (useSmart) {
        const llmOut = await smartFormatWithLLM(ctx.content, this.plugin.settings);
        formatted = formatMarkdown(llmOut);
      } else {
        formatted = formatMarkdown(ctx.content);
      }
      if (formatted !== ctx.content) {
        await replaceFullText(this.app, ctx.file, formatted);
      }
      // 排版完成：toast 带"复制为公众号 HTML"按钮
      showFormatDoneNotice(formatted, this.plugin.settings.gzhTheme);
    } finally {
      btn.buttonEl.removeClass('cowrite-busy');
      btn.setButtonText(original);
      btn.setDisabled(false);
    }
  }

  // ---- 按钮 4：文章发布 ----
  private async handlePublish(btn: ButtonComponent): Promise<void> {
    const ctx = await getFullText(this.app);
    if (!ctx) {
      new Notice('请先打开一篇笔记');
      return;
    }
    const choice = await openPublishModal(this.app, this.plugin.settings, ctx.content);
    if (!choice) return;

    btn.setDisabled(true);
    const original = btn.buttonEl.textContent ?? '';
    btn.setButtonText('正在发布...');
    btn.buttonEl.addClass('cowrite-busy');
    try {
      if (choice.platform === 'wechat') {
        // 提取封面图（如果用户选了文章第一张图）
        let cover: ArrayBuffer | undefined;
        if (choice.coverFromFirstImage) {
          const firstImg = extractFirstImage(ctx.content);
          if (firstImg) {
            try {
              cover = await this.app.vault.adapter.readBinary(firstImg);
            } catch {
              new Notice('封面图读取失败，将不使用封面', 4000);
              cover = undefined;
            }
          }
        }
        const html = markdownToWechatHtml(ctx.content, this.plugin.settings.gzhTheme);
        const r = await publishWechatDraft(this.plugin.settings, {
          title: choice.title,
          author: choice.author,
          digest: choice.digest,
          htmlContent: html,
          coverImage: cover,
          coverFilename: 'cover.png',
        });
        new Notice(r.message, 10000);
      } else {
        throw new Error(`${PLATFORM_LABEL[choice.platform]}发布功能开发中，暂不支持`);
      }
    } finally {
      btn.buttonEl.removeClass('cowrite-busy');
      btn.setButtonText(original);
      btn.setDisabled(false);
    }
  }
}

/** 从 Markdown 里提取第一张图片的 vault 相对路径 */
function extractFirstImage(md: string): string | null {
  const m = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(md);
  return m ? m[1] : null;
}

/** 排版完成 toast：带"复制为公众号 HTML"按钮 */
function showFormatDoneNotice(formattedMd: string, themeId?: string): void {
  const notice = new Notice('', 8000);
  notice.noticeEl.addClass('cowrite-format-notice');
  const textEl = notice.noticeEl.createEl('div', { text: '已排版' });
  textEl.style.marginBottom = '8px';
  const btn = notice.noticeEl.createEl('button', { text: '复制为公众号 HTML' });
  btn.addClass('mod-cta');
  btn.style.width = '100%';
  btn.addEventListener('click', async () => {
    try {
      const html = markdownToWechatHtml(formattedMd, themeId);
      await navigator.clipboard.writeText(html);
      const theme = getTheme(themeId || 'graphite-minimal');
      new Notice(`已复制公众号 HTML（${theme.name}）`);
      notice.hide();
    } catch (e) {
      new Notice(`复制失败：${parseError(e)}`, 6000);
    }
  });
}

// ---------------------------------------------------------------------------
// Modal：文章改写（5 个模式）
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
    (['polish', 'expand', 'shorten', 'translate', 'deai'] as RewriteMode[]).forEach((m) => {
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
// Modal：文章配图（位置 + 风格预设 + 尺寸 + 自定义描述）
// ---------------------------------------------------------------------------

type ImagePos = 'start' | 'between' | 'end';

interface ImageModalChoice {
  pos: ImagePos;
  /** 最终生效的风格预设（选 custom 时会把用户输入的描述塞进 promptSuffix） */
  stylePreset: ImageStylePreset;
  /** 用户在弹窗里实际选的风格 id（用于回写 settings.lastImageStyle） */
  styleId: string;
  sizePreset: ImageSizePreset;
  /** 用户在"自定义描述"里追加的文本 */
  customDesc: string;
}

function openImageModal(app: App, settings: CowriteSettings): Promise<ImageModalChoice | null> {
  return new Promise((resolve) => {
    let done = false;
    const modal = new Modal(app);
    modal.titleEl.setText('文章配图');
    const body = modal.contentEl;

    // ---- 配图位置 ----
    body.createEl('label', { text: '配图位置' }).addClass('cowrite-desc');
    const posSel = body.createEl('select', { cls: 'cowrite-input' });
    [
      { v: 'start', t: '开头（封面）' },
      { v: 'between', t: '每段之间（最多 3 张）' },
      { v: 'end', t: '结尾' },
    ].forEach((o) => {
      const opt = posSel.createEl('option', { text: o.t, value: o.v });
      opt.value = o.v;
    });

    // ---- 配图风格（下拉；选"自定义"时换成文本输入框） ----
    body.createEl('label', { text: '配图风格' }).addClass('cowrite-desc');
    const styleSel = body.createEl('select', { cls: 'cowrite-input' });
    IMAGE_STYLE_PRESETS.forEach((p) => {
      const opt = styleSel.createEl('option', { text: p.name, value: p.id });
      opt.value = p.id;
    });
    // 选 custom 时替换成的文本框
    const customStyleInput = body.createEl('input', {
      type: 'text',
      cls: 'cowrite-input',
      placeholder: '自己写风格描述，例如：neon cyberpunk illustration, dark background, glowing edges',
    });
    customStyleInput.style.display = 'none';

    const sceneHint = body.createEl('p', { cls: 'cowrite-desc' });
    sceneHint.style.marginTop = '4px';

    // ---- 尺寸 ----
    body.createEl('label', { text: '尺寸' }).addClass('cowrite-desc');
    const sizeSel = body.createEl('select', { cls: 'cowrite-input' });
    IMAGE_SIZE_PRESETS.forEach((s) => {
      const opt = sizeSel.createEl('option', {
        text: `${s}  (${IMAGE_SIZE_MAP[s]})`,
        value: s,
      });
      opt.value = s;
    });

    // ---- 自定义描述（无论选哪个风格都会追加到 prompt 末尾） ----
    body.createEl('label', { text: '自定义描述（追加到 prompt 末尾，可空）' }).addClass('cowrite-desc');
    const customDescInput = body.createEl('input', {
      type: 'text',
      cls: 'cowrite-input',
      placeholder: '例如：左上角留标题位、不要出现人脸',
    });

    // ---- 预填上次选择 ----
    const lastStyleId = IMAGE_STYLE_PRESETS.some((p) => p.id === settings.lastImageStyle)
      ? settings.lastImageStyle
      : 'clean-illustration';
    styleSel.value = lastStyleId;
    customDescInput.value = settings.lastCustomStyle || '';
    const lastSize = IMAGE_SIZE_PRESETS.includes(settings.imageSizePreset)
      ? settings.imageSizePreset
      : '16:9';
    sizeSel.value = lastSize;

    const syncStyleUi = () => {
      const isCustom = styleSel.value === 'custom';
      styleSel.style.display = isCustom ? 'none' : '';
      customStyleInput.style.display = isCustom ? '' : 'none';
      if (!isCustom) {
        const preset = getImageStyle(styleSel.value);
        sceneHint.setText(preset.scene);
      } else {
        sceneHint.setText('在上方输入框里写你想要的风格描述。');
      }
    };
    styleSel.addEventListener('change', syncStyleUi);
    syncStyleUi();

    const btns = body.createDiv({ cls: 'cowrite-modal-btns' });
    const ok = btns.createEl('button', { text: '开始生成' });
    ok.addClass('mod-cta');
    const cancel = btns.createEl('button', { text: '取消' });

    const finish = (v: ImageModalChoice | null) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };

    ok.addEventListener('click', () => {
      const styleId = styleSel.value;
      let stylePreset: ImageStylePreset;
      if (styleId === 'custom') {
        // 自定义：把用户输入的风格文本当作 promptSuffix
        stylePreset = {
          id: 'custom',
          name: '自定义',
          scene: '',
          promptSuffix: customStyleInput.value.trim(),
          negativePrompt: '',
        };
      } else {
        stylePreset = getImageStyle(styleId);
      }
      finish({
        pos: (posSel.value as ImagePos) || 'start',
        stylePreset,
        styleId,
        sizePreset: (sizeSel.value as ImageSizePreset) || '16:9',
        customDesc: customDescInput.value.trim(),
      });
    });
    cancel.addEventListener('click', () => finish(null));
    modal.onClose = () => finish(null);
    modal.open();
  });
}

// ---------------------------------------------------------------------------
// Modal：文章排版（三选项：规则排版 / 智能排版 / 导出公众号 HTML）
// ---------------------------------------------------------------------------

type FormatChoice =
  | { kind: 'rule' }
  | { kind: 'smart' }
  | { kind: 'html' };

/**
 * 返回 null 表示取消。
 *  - rule/smart：回主流程执行编辑器内替换
 *  - html：弹窗内已完成主题选择 + 复制到剪贴板，主流程不再动编辑器
 */
function openFormatModal(app: App, defaultThemeId: string, md: string): Promise<FormatChoice | null> {
  return new Promise((resolve) => {
    let done = false;
    const modal = new Modal(app);
    modal.titleEl.setText('文章排版');

    const body = modal.contentEl;

    const finish = (v: FormatChoice | null) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };
    modal.onClose = () => finish(null);

    // 弹窗内临时选中的主题：默认取设置页 gzhTheme；
    // 视图间来回切换时保留选择，复制时用；不写回 settings。
    const validThemeIds = new Set(GZH_THEMES.map((t) => t.id));
    let tempThemeId = validThemeIds.has(defaultThemeId) ? defaultThemeId : 'graphite-minimal';

    // ---- 视图一：三个选项按钮 ----
    const showOptionsView = () => {
      body.empty();

      const optionRule = body.createEl('button', {
        text: '📏 规则排版（纯正则，不调 LLM）',
      });
      optionRule.style.display = 'block';
      optionRule.style.width = '100%';
      optionRule.style.margin = '4px 0';

      const optionSmart = body.createEl('button', {
        text: '✨ 智能排版（调 LLM：长段拆分 / 关键词高亮 / 章节编号）',
      });
      optionSmart.style.display = 'block';
      optionSmart.style.width = '100%';
      optionSmart.style.margin = '4px 0';

      const optionHtml = body.createEl('button', { text: '🎨 导出公众号 HTML（选主题后复制）' });
      optionHtml.addClass('mod-cta');
      optionHtml.style.display = 'block';
      optionHtml.style.width = '100%';
      optionHtml.style.margin = '4px 0';

      const cancelLink = body.createEl('button', { text: '取消' });
      cancelLink.style.display = 'block';
      cancelLink.style.width = '100%';
      cancelLink.style.margin = '8px 0 0';

      optionRule.addEventListener('click', () => finish({ kind: 'rule' }));
      optionSmart.addEventListener('click', () => finish({ kind: 'smart' }));
      cancelLink.addEventListener('click', () => finish(null));
      optionHtml.addEventListener('click', showThemeView);
    };

    // ---- 视图二：主题下拉 + 复制按钮（同一弹窗内切换） ----
    const showThemeView = () => {
      body.empty();

      body.createEl('p', {
        cls: 'cowrite-desc',
        text: '选择排版主题，复制后可直接粘贴到公众号编辑器。',
      });

      const label = body.createEl('div', { cls: 'cowrite-desc', text: '主题选择：' });
      label.style.marginBottom = '4px';

      const themeSel = body.createEl('select', { cls: 'cowrite-input' });
      GZH_THEMES.forEach((t) => {
        const opt = themeSel.createEl('option', {
          text: `${t.name} — ${t.description}`,
          value: t.id,
        });
        opt.value = t.id;
      });
      themeSel.value = tempThemeId;
      themeSel.style.display = 'block';
      themeSel.style.width = '100%';

      const copyBtn = body.createEl('button', { text: '复制到剪贴板' });
      copyBtn.addClass('mod-cta');
      copyBtn.style.width = '100%';
      copyBtn.style.marginTop = '12px';

      const backBtn = body.createEl('button', { text: '返回' });
      backBtn.style.width = '100%';
      backBtn.style.marginTop = '8px';

      copyBtn.addEventListener('click', async () => {
        copyBtn.disabled = true;
        const origText = copyBtn.textContent ?? '复制到剪贴板';
        try {
          tempThemeId = themeSel.value;
          const html = markdownToWechatHtml(md, tempThemeId);
          await navigator.clipboard.writeText(html);
          const theme = getTheme(tempThemeId);
          new Notice(`已复制公众号 HTML（${theme.name}）`);
          finish({ kind: 'html' });
        } catch (e) {
          new Notice(`复制失败：${parseError(e)}`, 6000);
          copyBtn.disabled = false;
          copyBtn.textContent = origText;
        }
      });

      // 返回：回到三选项界面，不关闭弹窗
      backBtn.addEventListener('click', () => {
        tempThemeId = themeSel.value;
        showOptionsView();
      });
    };

    showOptionsView();
    modal.open();
  });
}

// ---------------------------------------------------------------------------
// Modal：文章发布（公众号真实表单）
// ---------------------------------------------------------------------------

interface PublishChoice {
  platform: PublishPlatform;
  title: string;
  author: string;
  digest: string;
  coverFromFirstImage: boolean;
}

function openPublishModal(
  app: App,
  settings: CowriteSettings,
  md: string,
): Promise<PublishChoice | null> {
  return new Promise((resolve) => {
    let done = false;
    let platform: PublishPlatform = 'wechat';
    const modal = new Modal(app);
    modal.titleEl.setText('文章发布');

    const sel = modal.contentEl.createEl('select', { cls: 'cowrite-input' });
    PUBLISH_PLATFORMS.forEach((p) => {
      const opt = sel.createEl('option', { text: PLATFORM_LABEL[p], value: p });
      opt.value = p;
    });

    const statusEl = modal.contentEl.createEl('div', { cls: 'cowrite-desc' });
    const formWrap = modal.contentEl.createDiv();

    // 预填标题：取第一个一级/二级标题
    const titleMatch = /^#{1,2}\s+(.+)$/m.exec(md);
    const defaultTitle = titleMatch ? titleMatch[1].trim() : '';

    const hasFirstImage = Boolean(extractFirstImage(md));

    const render = () => {
      formWrap.empty();
      statusEl.empty();

      if (platform === 'wechat') {
        btnsWrap.ok.disabled = false;
        const configured = isWechatConfigured(settings);
        statusEl.setText(
          configured
            ? '已配置公众号 appid / appsecret'
            : '未配置公众号 appid / appsecret（请到设置页填写）',
        );
        statusEl.style.color = configured ? 'inherit' : 'var(--text-error)';

        formWrap.createEl('label', { text: '标题' }).addClass('cowrite-desc');
        const titleInput = formWrap.createEl('input', {
          type: 'text',
          cls: 'cowrite-input',
          value: defaultTitle,
          placeholder: '文章标题',
        });

        formWrap.createEl('label', { text: '作者' }).addClass('cowrite-desc');
        const authorInput = formWrap.createEl('input', {
          type: 'text',
          cls: 'cowrite-input',
          placeholder: '作者署名',
        });

        formWrap.createEl('label', { text: '摘要' }).addClass('cowrite-desc');
        const digestInput = formWrap.createEl('textarea', {
          cls: 'cowrite-input',
          attr: { rows: '3', placeholder: '一句话摘要（可不填）' },
        });

        formWrap.createEl('label', { text: '封面图' }).addClass('cowrite-desc');
        const coverSel = formWrap.createEl('select', { cls: 'cowrite-input' });
        const optNone = coverSel.createEl('option', { text: '不使用封面', value: 'none' });
        void optNone;
        const optFirst = coverSel.createEl('option', {
          text: hasFirstImage ? '使用文章第一张图' : '使用文章第一张图（文章中未检测到图片）',
          value: 'first',
        });
        if (!hasFirstImage) optFirst.disabled = true;

        btnsWrap.ok.onclick = () => {
          finish({
            platform,
            title: titleInput.value.trim(),
            author: authorInput.value.trim(),
            digest: digestInput.value.trim(),
            coverFromFirstImage: coverSel.value === 'first',
          });
        };
      } else {
        statusEl.setText(`${PLATFORM_LABEL[platform]}：开放发布 API 暂不支持，功能开发中。`);
        statusEl.style.color = 'var(--text-warning)';
        btnsWrap.ok.disabled = true;
        btnsWrap.ok.onclick = () => finish(null);
      }
    };

    const btnsWrap = (() => {
      const btns = modal.contentEl.createDiv({ cls: 'cowrite-modal-btns' });
      const ok = btns.createEl('button', { text: '发布到草稿箱' });
      ok.addClass('mod-cta');
      const cancel = btns.createEl('button', { text: '取消' });
      cancel.addEventListener('click', () => finish(null));
      return { ok, cancel };
    })();

    sel.addEventListener('change', () => {
      platform = (sel.value as PublishPlatform) || 'wechat';
      render();
    });

    const finish = (v: PublishChoice | null) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };
    modal.onClose = () => finish(null);

    render();
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
    // 图像模型下拉：预置 5 个常用模型 + 自定义（选自定义显示文本框）
    const KNOWN_IMAGE_MODELS = [
      { v: 'dall-e-3', t: 'dall-e-3' },
      { v: 'dall-e-2', t: 'dall-e-2' },
      { v: 'gpt-image-1', t: 'gpt-image-1' },
      { v: 'stable-diffusion-xl', t: 'stable-diffusion-xl' },
      { v: 'flux-dev', t: 'flux-dev' },
      { v: '__custom__', t: '自定义...' },
    ] as const;
    const knownSet = new Set<string>(KNOWN_IMAGE_MODELS.map((k) => k.v));
    const curModel = this.plugin.settings.imageModel;
    const initialPreset = knownSet.has(curModel) ? curModel : '__custom__';

    const modelSetting = new Setting(containerEl)
      .setName('图像模型')
      .setDesc('选择预置模型，或选"自定义"后手动输入模型名');
    modelSetting.addDropdown((d) => {
      const opts: Record<string, string> = {};
      KNOWN_IMAGE_MODELS.forEach((k) => (opts[k.v] = k.t));
      d.addOptions(opts)
        .setValue(initialPreset)
        .onChange(async (v) => {
          if (v !== '__custom__') {
            this.plugin.settings.imageModel = v;
            customModelInputEl.style.display = 'none';
          } else {
            customModelInputEl.style.display = '';
            this.plugin.settings.imageModel = customModelInputEl.value.trim() || 'dall-e-3';
          }
          await this.plugin.saveSettings();
        });
    });
    let customModelInputEl: HTMLInputElement;
    modelSetting.addText((t) => {
      t.setPlaceholder('自定义模型名，例如 sd-xl-base')
        .setValue(initialPreset === '__custom__' ? curModel : '')
        .onChange(async (v) => {
          this.plugin.settings.imageModel = v.trim() || 'dall-e-3';
          await this.plugin.saveSettings();
        });
      customModelInputEl = t.inputEl;
      customModelInputEl.style.display = initialPreset === '__custom__' ? '' : 'none';
      customModelInputEl.style.minWidth = '140px';
    });

    new Setting(containerEl)
      .setName('图像质量')
      .setDesc('standard / hd（hd 仅 dall-e-3 支持，生成更慢更贵）')
      .addDropdown((d) =>
        d.addOptions({ standard: 'standard（标准）', hd: 'hd（高清）' })
          .setValue(this.plugin.settings.imageQuality)
          .onChange(async (v) => {
            this.plugin.settings.imageQuality = v === 'hd' ? 'hd' : 'standard';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('风格后缀')
      .setDesc('自动拼接到每条配图 prompt 末尾；留空则不拼接')
      .addText((t) =>
        t.setPlaceholder('clean illustration style, soft colors, professional editorial')
          .setValue(this.plugin.settings.imageStyleSuffix)
          .onChange(async (v) => {
            this.plugin.settings.imageStyleSuffix = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('配图尺寸')
      .setDesc('配图弹窗里的默认尺寸；弹窗内仍可临时切换')
      .addDropdown((d) => {
        const opts: Record<string, string> = {};
        IMAGE_SIZE_PRESETS.forEach((s) => {
          opts[s] = `${s}  (${IMAGE_SIZE_MAP[s]})`;
        });
        d.addOptions(opts)
          .setValue(this.plugin.settings.imageSizePreset)
          .onChange(async (v) => {
            this.plugin.settings.imageSizePreset =
              (v as ImageSizePreset) || '16:9';
            await this.plugin.saveSettings();
          });
      });

    // ---- 公众号排版主题 ----
    containerEl.createEl('h3', { text: '公众号排版主题' });
    new Setting(containerEl)
      .setName('gzh-design 主题')
      .setDesc('导出公众号 HTML / 发布到草稿箱时使用的排版主题')
      .addDropdown((d) => {
        const opts: Record<string, string> = {};
        GZH_THEMES.forEach((t) => {
          opts[t.id] = `${t.name}（${t.description}）`;
        });
        d.addOptions(opts)
          .setValue(this.plugin.settings.gzhTheme)
          .onChange(async (v) => {
            this.plugin.settings.gzhTheme = v || 'graphite-minimal';
            await this.plugin.saveSettings();
          });
      });

    // ---- 公众号发布配置 ----
    containerEl.createEl('h3', { text: '公众号发布配置' });
    new Setting(containerEl)
      .setName('公众号 AppID')
      .setDesc('在微信公众平台 → 开发 → 基本配置中获取')
      .addText((t) =>
        t.setPlaceholder('wx...')
          .setValue(this.plugin.settings.wechatAppid)
          .onChange(async (v) => {
            this.plugin.settings.wechatAppid = v.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('公众号 AppSecret')
      .setDesc('仅保存在本地 data.json')
      .addText((t) =>
        t.setPlaceholder('AppSecret')
          .setValue(this.plugin.settings.wechatSecret)
          .onChange(async (v) => {
            this.plugin.settings.wechatSecret = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: '其他平台（开发中）' });
    for (const [name, desc] of [
      ['知乎', '无开放发布 API，暂不支持'],
      ['小红书', '无开放发布 API，暂不支持'],
      ['掘金', '无开放发布 API，暂不支持'],
    ] as Array<[string, string]>) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.setPlaceholder('开发中').setDisabled(true);
        });
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
      text: '所有处理均在本地完成，API Key / AppSecret 仅保存在插件 data.json。',
    });
  }
}
