import { z } from 'zod';
import { defineTool } from '../defineTool';

/** base64 字符串转 ArrayBuffer（vault.createBinary 需要） */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * 生成图片并保存到 vault。
 * 走 OpenAI 兼容 images/generations 接口（DALL-E 等），返回 b64_json 后落盘。
 */
export const insertImageTool = defineTool({
  name: 'insert_image',
  description:
    '根据文字提示词生成一张图片并保存到 vault 的指定路径（如 "attachments/封面.png"）。' +
    '需要在设置里配置配图 API。生成后可在笔记里用 ![[文件名]] 引用。',
  parameters: z.object({
    prompt: z.string().describe('文生图英文提示词，描述画面内容与风格'),
    path: z.string().describe('图片保存路径（vault 内相对路径，建议放在 attachments/ 下，.png 结尾）'),
  }),
  async execute(args, ctx) {
    const s = ctx.settings;
    if (!s || !s.imageApiBase) {
      return { ok: false, error: '未配置配图 API（imageApiBase 为空），请在设置中开启' };
    }
    const apiKey = s.imageApiKey || s.masterApiKey || '';
    if (!apiKey) {
      return { ok: false, error: '未配置配图 API Key' };
    }
    const base = s.imageApiBase.replace(/\/+$/, '');
    const url = /\/images\/generations$/.test(base) ? base : `${base}/images/generations`;

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 90000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: s.imageModel || 'dall-e-3',
          prompt: args.prompt,
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return { ok: false, error: `图片生成失败 HTTP ${resp.status}: ${t.slice(0, 200)}` };
      }
      const data: any = await resp.json();
      const b64: string | undefined = data?.data?.[0]?.b64_json;
      if (!b64) {
        return { ok: false, error: '图片接口未返回 b64_json 字段' };
      }
      const buffer = base64ToArrayBuffer(b64);
      // 确保父目录存在
      const parent = args.path.split('/').slice(0, -1).join('/');
      if (parent && !ctx.vault.getAbstractFileByPath(parent)) {
        await ctx.vault.createFolder(parent);
      }
      // 已存在则覆盖
      const existing = ctx.vault.getAbstractFileByPath(args.path);
      if (existing) {
        await ctx.vault.modifyBinary(existing as any, buffer);
      } else {
        await ctx.vault.createBinary(args.path, buffer);
      }
      return { ok: true, path: args.path, bytes: buffer.byteLength };
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e) };
    } finally {
      window.clearTimeout(timer);
    }
  },
  render(args, result, el) {
    el.addClass('cowrite-tool-result');
    const head = el.createEl('div', { cls: result.ok ? 'cowrite-tool-name' : 'cowrite-tool-error' });
    head.setText(result.ok ? `🖼️ 配图已保存：${args.path}` : '❌ 配图失败');
    if (result.ok) {
      el.createEl('div', { cls: 'cowrite-tool-meta', text: `${result.bytes} 字节 · prompt: ${args.prompt.slice(0, 80)}` });
    } else {
      el.createEl('div', { cls: 'cowrite-tool-error', text: String(result.error || '') });
    }
  },
});
