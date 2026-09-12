/**
 * 配图风格预设（v0.6.0）。
 * 弹窗里选一个预设，其 promptSuffix 会被拼到 LLM 生成的配图 prompt 末尾；
 * 用户在"自定义描述"里输入的内容会再追加一层。
 */

export interface ImageStylePreset {
  id: string;
  name: string;
  scene: string;
  promptSuffix: string;
  negativePrompt?: string;
}

export const IMAGE_STYLE_PRESETS: ImageStylePreset[] = [
  {
    id: 'ai-infographic',
    name: '轻盈 AI 产品信息图',
    scene: '科技/产品/教程类，白/浅紫底+紫绿强调+圆角卡片+线性图标',
    promptSuffix:
      'premium AI-product illustration, clean white to very pale lavender background, near-black typography, violet to electric-blue gradient highlights, lime green accents, white rounded cards with subtle shadows, thin rounded line icons, generous negative space, polished and modern, minimalist tech aesthetic',
    negativePrompt:
      'no watermark, no logo, no garbled text, no photorealism, no dark background, no childish stickers',
  },
  {
    id: 'clean-illustration',
    name: '简洁插画（默认）',
    scene: '通用文章配图，柔和色彩、专业感',
    promptSuffix:
      'clean illustration style, soft colors, professional editorial illustration, flat design, minimal, clean lines',
    negativePrompt: 'no watermark, no text, no garbled characters',
  },
  {
    id: 'photorealistic',
    name: '写实摄影',
    scene: '产品评测、生活类，真实感强',
    promptSuffix:
      'photorealistic photography, high detail, professional lighting, 8k, sharp focus, commercial photography style',
    negativePrompt: 'no cartoon, no illustration, no watermark',
  },
  {
    id: 'flat-vector',
    name: '扁平矢量',
    scene: '教程、流程图、概念解释类',
    promptSuffix:
      'flat vector illustration, minimal geometric shapes, solid colors, clean outlines, modern design, no gradients',
    negativePrompt: 'no 3d, no shadows, no realistic textures',
  },
  {
    id: 'watercolor',
    name: '手绘水彩',
    scene: '随笔、生活、情感类',
    promptSuffix:
      'hand-drawn watercolor illustration, soft edges, gentle colors, artistic, textured paper feel, warm and organic',
    negativePrompt: 'no sharp lines, no digital look, no photorealism',
  },
  {
    id: 'three-d-render',
    name: '3D 渲染',
    scene: '科技、产品展示类',
    promptSuffix:
      '3D render, octane render, smooth lighting, modern minimalist, soft shadows, premium product visualization, clean background',
    negativePrompt: 'no cartoon, no messy composition, no heavy shadows',
  },
  {
    id: 'custom',
    name: '自定义',
    scene: '自己输入风格描述',
    promptSuffix: '',
    negativePrompt: '',
  },
];

export function getImageStyle(id: string): ImageStylePreset {
  return (
    IMAGE_STYLE_PRESETS.find((s) => s.id === id) ?? IMAGE_STYLE_PRESETS[1]
  );
}
