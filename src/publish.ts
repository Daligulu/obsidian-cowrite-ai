import { requestUrl } from 'obsidian';
import type { CowriteSettings } from './settings';

/**
 * 文章发布：
 *  - 公众号：真实调用微信 API（getToken → add_material 封面 → draft/add 草稿）
 *    用 Obsidian requestUrl() 绕 CORS，移动端可用。
 *  - 知乎 / 小红书 / 掘金：开放 API 不可用，UI 标注"开发中"。
 */

export const PUBLISH_PLATFORMS = ['wechat', 'zhihu', 'xiaohongshu', 'juejin'] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];

export const PLATFORM_LABEL: Record<PublishPlatform, string> = {
  wechat: '公众号',
  zhihu: '知乎（开发中）',
  xiaohongshu: '小红书（开发中）',
  juejin: '掘金（开发中）',
};

export interface PublishResult {
  url?: string;
  message: string;
  mediaId?: string;
}

/** 公众号草稿表单 */
export interface WechatPublishOptions {
  title: string;
  author: string;
  digest: string;
  /** 已经转好的 HTML 正文（内联样式） */
  htmlContent: string;
  /** 封面图二进制（PNG/JPEG），可选；不传则草稿无封面 */
  coverImage?: ArrayBuffer;
  coverFilename?: string;
}

/** 公众号是否已配置 appid + appsecret */
export function isWechatConfigured(settings: CowriteSettings): boolean {
  return Boolean(settings.wechatAppid && settings.wechatSecret);
}

// ---------------------------------------------------------------------------
// 微信 API 调用
// ---------------------------------------------------------------------------

/** 提取微信错误；errcode=0 视为成功 */
function assertWechatOk(json: any, action: string): void {
  if (!json) throw new Error(`${action}：空响应`);
  const errcode: number | undefined = json.errcode;
  if (errcode === undefined || errcode === 0) return;
  const errmsg: string = json.errmsg || `errcode=${errcode}`;
  throw new Error(`${action}失败：${errmsg}`);
}

/** 1) 拿 access_token */
async function getAccessToken(settings: CowriteSettings): Promise<string> {
  const url =
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
    `&appid=${encodeURIComponent(settings.wechatAppid)}` +
    `&secret=${encodeURIComponent(settings.wechatSecret)}`;
  const resp = await requestUrl({ url, method: 'GET' });
  const json: any = resp.json;
  assertWechatOk(json, '获取 access_token');
  const token: string | undefined = json.access_token;
  if (!token) throw new Error('获取 access_token 失败：响应里没有 access_token');
  return token;
}

/** 把多段（字符串 + 二进制）拼成 multipart/form-data body */
function buildMultipart(boundary: string, parts: Array<{ name: string; filename?: string; contentType?: string; data: string | ArrayBuffer }>): ArrayBuffer {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const pushStr = (s: string) => chunks.push(encoder.encode(s));
  for (const p of parts) {
    pushStr(`--${boundary}\r\n`);
    if (p.filename) {
      pushStr(
        `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
          `Content-Type: ${p.contentType || 'application/octet-stream'}\r\n\r\n`,
      );
    } else {
      pushStr(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`);
    }
    if (typeof p.data === 'string') {
      pushStr(p.data);
    } else {
      chunks.push(new Uint8Array(p.data));
    }
    pushStr('\r\n');
  }
  pushStr(`--${boundary}--\r\n`);
  // 合并
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return merged.buffer;
}

/** 2) 上传永久图片素材，返回 media_id */
async function uploadCoverMaterial(token: string, image: ArrayBuffer, filename: string): Promise<string> {
  const boundary = `----cowrite${Date.now()}boundary`;
  const body = buildMultipart(boundary, [
    { name: 'media', filename, contentType: 'image/png', data: image },
  ]);
  const resp = await requestUrl({
    url: `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: body as unknown as ArrayBuffer,
  });
  const json: any = resp.json;
  assertWechatOk(json, '上传封面');
  const mediaId: string | undefined = json.media_id;
  if (!mediaId) throw new Error('上传封面失败：响应里没有 media_id');
  return mediaId;
}

/** 3) 创建草稿 */
async function addDraft(
  token: string,
  opts: WechatPublishOptions,
  thumbMediaId: string | undefined,
): Promise<string> {
  const article: Record<string, unknown> = {
    title: opts.title.slice(0, 64),
    author: opts.author || '',
    digest: opts.digest.slice(0, 120),
    content: opts.htmlContent,
    content_source_url: '',
    need_open_comment: 0,
    only_fans_can_comment: 0,
  };
  if (thumbMediaId) {
    article.thumb_media_id = thumbMediaId;
  }
  const resp = await requestUrl({
    url: `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articles: [article] }),
  });
  const json: any = resp.json;
  assertWechatOk(json, '创建草稿');
  const mediaId: string | undefined = json.media_id;
  if (!mediaId) throw new Error('创建草稿失败：响应里没有 media_id');
  return mediaId;
}

/** 公众号完整发布流程 */
export async function publishWechatDraft(
  settings: CowriteSettings,
  opts: WechatPublishOptions,
): Promise<PublishResult> {
  if (!isWechatConfigured(settings)) {
    throw new Error('尚未配置公众号 appid / appsecret，请先在设置中填写');
  }
  if (!opts.title.trim()) throw new Error('文章标题不能为空');
  if (!opts.htmlContent.trim()) throw new Error('文章正文为空');

  const token = await getAccessToken(settings);
  let thumbMediaId: string | undefined;
  if (opts.coverImage && opts.coverImage.byteLength > 0) {
    thumbMediaId = await uploadCoverMaterial(token, opts.coverImage, opts.coverFilename || 'cover.png');
  }
  const mediaId = await addDraft(token, opts, thumbMediaId);
  return {
    mediaId,
    message: `草稿已创建（media_id: ${mediaId}）。请到公众号后台草稿箱确认并群发。`,
  };
}

/** 通用发布入口：wechat 走真实流程，其他平台占位 */
export async function publish(
  platform: PublishPlatform,
  _content: string,
  settings: CowriteSettings,
  opts?: Partial<WechatPublishOptions>,
): Promise<PublishResult> {
  if (platform === 'wechat') {
    return await publishWechatDraft(settings, {
      title: opts?.title || '',
      author: opts?.author || '',
      digest: opts?.digest || '',
      htmlContent: opts?.htmlContent || '',
      coverImage: opts?.coverImage,
      coverFilename: opts?.coverFilename,
    });
  }
  // 知乎 / 小红书 / 掘金：无开放发布 API，占位
  throw new Error(`${PLATFORM_LABEL[platform]}发布功能开发中，暂不支持`);
}
