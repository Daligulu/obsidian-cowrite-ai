/**
 * gzh-design 公众号排版主题（v0.5.0）。
 * 8 套主题，全部以变量形式定义，由 markdownToWechatHtml() 内联到 HTML。
 * 默认主题：graphite-minimal（石墨极简）。
 */

export interface GzhTheme {
  id: string;
  name: string;
  description: string;
  accent: string;
  accentLight: string;
  bodyColor: string;
  headingColor: string;
  mutedColor: string;
  quoteBg: string;
  codeBg: string;
  underline: string;
  borderColor: string;
  borderRadius: string;
}

export const GZH_THEMES: GzhTheme[] = [
  // 1. 摸鱼绿 moyu-green
  {
    id: 'moyu-green',
    name: '摸鱼绿',
    description: '清新治愈，适合生活/职场类',
    accent: '#059669',
    accentLight: '#A7F3D0',
    bodyColor: '#374151',
    headingColor: '#111827',
    mutedColor: '#9CA3AF',
    quoteBg: '#F0FDF4',
    codeBg: '#F0FDF4',
    underline: 'border-bottom:2px solid #A7F3D0;font-weight:600;',
    borderColor: '#E5E7EB',
    borderRadius: '8px',
  },
  // 2. 红白色系 red-white
  {
    id: 'red-white',
    name: '红白色系',
    description: '醒目有力，适合观点/评论类',
    accent: '#DC2626',
    accentLight: '#FECACA',
    bodyColor: '#3F3F46',
    headingColor: '#1F2937',
    mutedColor: '#9CA3AF',
    quoteBg: '#FEF2F2',
    codeBg: '#FEF2F2',
    underline: 'border-bottom:2px solid #FECACA;font-weight:600;',
    borderColor: '#E5E7EB',
    borderRadius: '4px',
  },
  // 3. 石墨极简 graphite-minimal（默认）
  {
    id: 'graphite-minimal',
    name: '石墨极简',
    description: '极简专业，适合技术/商业类',
    accent: '#52525B',
    accentLight: '#52525B',
    bodyColor: '#3F3F46',
    headingColor: '#27272A',
    mutedColor: '#9CA3AF',
    quoteBg: '#FAFAFA',
    codeBg: '#F6F8FA',
    underline: 'border-bottom:2px solid #52525B;font-weight:600;',
    borderColor: '#E5E7EB',
    borderRadius: '0px',
  },
  // 4. 留白禅意 zen-whitespace
  {
    id: 'zen-whitespace',
    name: '留白禅意',
    description: '留白呼吸感，适合散文/随笔类',
    accent: '#4A5D52',
    accentLight: '#B5C8BC',
    bodyColor: '#3F3F46',
    headingColor: '#2D3A33',
    mutedColor: '#9CA3AF',
    quoteBg: '#F7F8F6',
    codeBg: '#F7F8F6',
    underline: 'border-bottom:1.5px solid #B5C8BC;font-weight:500;',
    borderColor: '#E5E7EB',
    borderRadius: '4px',
  },
  // 5. 摸鱼票据 moyu-ticket
  {
    id: 'moyu-ticket',
    name: '摸鱼票据',
    description: '票据风，适合分享/清单类',
    accent: '#059669',
    accentLight: '#A7F3D0',
    bodyColor: '#374151',
    headingColor: '#111827',
    mutedColor: '#9CA3AF',
    quoteBg: '#F0FDF4',
    codeBg: '#F0FDF4',
    underline: 'border-bottom:2px solid #A7F3D0;font-weight:600;',
    borderColor: '#E5E7EB',
    borderRadius: '8px',
  },
  // 6. 橄榄手记 olive-journal
  {
    id: 'olive-journal',
    name: '橄榄手记',
    description: '温暖橙色调，适合读书笔记类',
    accent: '#ed7b2f',
    accentLight: '#ed7b2f',
    bodyColor: '#3F3F46',
    headingColor: '#1e1f23',
    mutedColor: '#9CA3AF',
    quoteBg: '#FFF8F0',
    codeBg: '#FFF8F0',
    underline: 'border-bottom:2px solid #ed7b2f;font-weight:600;',
    borderColor: '#E5E7EB',
    borderRadius: '4px',
  },
  // 7. 衬线绿 serif-green
  {
    id: 'serif-green',
    name: '衬线绿',
    description: '衬线字体+绿色，适合长文阅读类',
    accent: '#28a745',
    accentLight: '#28a745',
    bodyColor: '#3F3F46',
    headingColor: '#1a1a1a',
    mutedColor: '#9CA3AF',
    quoteBg: '#F0FFF4',
    codeBg: '#F0FFF4',
    underline: 'border-bottom:2px solid #28a745;font-weight:600;',
    borderColor: '#E5E7EB',
    borderRadius: '4px',
  },
  // 8. 衬线深蓝 serif-navy
  {
    id: 'serif-navy',
    name: '衬线深蓝',
    description: '专业深蓝色，适合财经/科技类',
    accent: '#1E5AA8',
    accentLight: '#1E5AA8',
    bodyColor: '#3F3F46',
    headingColor: '#1a1a2e',
    mutedColor: '#9CA3AF',
    quoteBg: '#F0F4FA',
    codeBg: '#F0F4FA',
    underline: 'border-bottom:2px solid #1E5AA8;font-weight:600;',
    borderColor: '#E5E7EB',
    borderRadius: '4px',
  },
];

export const DEFAULT_GZH_THEME_ID = 'graphite-minimal';

export function getTheme(id: string): GzhTheme {
  return GZH_THEMES.find((t) => t.id === id) ?? GZH_THEMES[2];
}
