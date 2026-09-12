import type { CowriteSettings } from './settings';

/**
 * 文章发布（预留）。
 * 各平台（公众号 / 知乎 / 小红书 / 掘金）API 鉴权与接口差异较大，先不实现真实调用。
 * 这里只做参数校验与占位返回，UI 流程已在 main.ts 接通。
 */

export const PUBLISH_PLATFORMS = ['wechat', 'zhihu', 'xiaohongshu', 'juejin'] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];

export const PLATFORM_LABEL: Record<PublishPlatform, string> = {
  wechat: '公众号',
  zhihu: '知乎',
  xiaohongshu: '小红书',
  juejin: '掘金',
};

export interface PublishResult {
  url?: string;
  message: string;
}

type TokenKey = 'wechatToken' | 'zhihuToken' | 'xiaohongshuToken' | 'juejinToken';

function tokenKey(platform: PublishPlatform): TokenKey {
  switch (platform) {
    case 'wechat':
      return 'wechatToken';
    case 'zhihu':
      return 'zhihuToken';
    case 'xiaohongshu':
      return 'xiaohongshuToken';
    case 'juejin':
      return 'juejinToken';
  }
}

export function getConfiguredToken(settings: CowriteSettings, platform: PublishPlatform): string {
  return (settings[tokenKey(platform)] || '').trim();
}

export async function publish(
  platform: PublishPlatform,
  _content: string,
  settings: CowriteSettings,
): Promise<PublishResult> {
  // TODO: 各平台真实发布 API 接入。
  //   - 公众号：草稿箱 draft/add + 素材上传，依赖 appid/secret 或临时 token；
  //   - 知乎：草稿 API（需 OAuth token）；
  //   - 小红书 / 掘金：无开放发布 API，需模拟登录或第三方桥接。
  // 当前版本仅做配置校验，不发起真实请求。
  const token = getConfiguredToken(settings, platform);
  if (!token) {
    throw new Error(`尚未配置${PLATFORM_LABEL[platform]}的 token，请先在设置中填写`);
  }
  return { message: `发布功能开发中，当前仅支持配置（${PLATFORM_LABEL[platform]}）` };
}
