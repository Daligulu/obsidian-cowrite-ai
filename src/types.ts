/**
 * Cowrite AI 插件数据模型。
 * 任务状态机：queued → running → succeeded | failed | cancelled
 * 任务持久化到 <vault>/.cowrite/tasks.json，页面为 vault 内 Markdown 文件。
 */

/** 任务动作标识符（配置化后支持任意自定义 id） */
export type TaskAction = string;

/** 任务状态机：queued → running → succeeded | failed | cancelled */
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type TaskPriority = 'high' | 'normal' | 'low';

/** 任务输入（创建任务时由插件/用户提供） */
export interface CowriteTaskInput {
  action: TaskAction;
  /** 目标页面在 vault 内的路径（如 Cowrite/示例.md） */
  pagePath?: string;
  /** 页面内锚点/选区上下文（可选） */
  anchor?: string;
  /** 用户对该任务的补充要求 */
  requirements?: string;
  /** 交付物说明（可选） */
  delivery?: string;
  priority?: TaskPriority;
}

/** 任务 */
export interface CowriteTask extends CowriteTaskInput {
  id: string;
  status: TaskStatus;
  attempts?: number;
  leaseUntil?: string;
  cancelRequestedAt?: string;
  recommendedSkills: string[];
  workerId?: string;
  result?: { message: string; assets?: string[] };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** 任务文件内容（<vault>/.cowrite/tasks.json） */
export interface TaskDataFile {
  version: 1;
  updatedAt?: string;
  tasks: CowriteTask[];
}

/** 动作配置：skills 仅作语义标签，prompt 为内置执行器调用 LLM 时的 system 模板 */
export interface ActionConfig {
  id: string;
  label: string;
  enabled: boolean;
  keywords: string[];
  /** 语义用途：描述该动作面向的能力方向，UI 展示用 */
  skills: string[];
  /** 内置执行器调用 LLM 时使用的 system prompt 模板 */
  prompt: string;
  description?: string;
}

/** 动作配置文件内容（<vault>/.cowrite/actions.json） */
export interface ActionConfigFile {
  version: 1;
  updatedAt?: string;
  actions: ActionConfig[];
}

/** 默认动作集（每个动作内置一段中文 system prompt，驱动 LLM 处理页面正文） */
export const DEFAULT_ACTIONS: ActionConfig[] = [
  {
    id: 'polish',
    label: '润色',
    enabled: true,
    keywords: ['润色', 'polish', '优化', '改写'],
    skills: ['humanizer-zh', 'wewrite'],
    description: '对页面内容进行润色优化（语言、结构、风格）。',
    prompt:
      '你是一名资深中文文字编辑。下面给你一段 Markdown 正文与用户补充要求。' +
      '请直接输出润色后的完整 Markdown 正文（不要解释、不要前后缀、不要代码块包裹）。' +
      '润色原则：修正语病与冗余，统一术语与标点，提升可读性与节奏，但保留作者原意与核心信息；' +
      '如原文含标题层级、列表、引用、图片链接，请原样保留这些结构。',
  },
  {
    id: 'write',
    label: '写作',
    enabled: true,
    keywords: ['写作', 'write', '创作', '起草'],
    skills: ['wewrite'],
    description: '根据要求起草/续写内容。',
    prompt:
      '你是一名中文内容写作者。下面给你一段 Markdown 正文（可能为空或仅含标题/大纲）与用户补充要求。' +
      '请直接输出可落地的完整 Markdown 正文（不要解释、不要代码块包裹）。' +
      '写作要求：紧扣用户要求展开，结构清晰（含合适的小标题），语言通顺自然，信息密度合理；' +
      '若原文已有内容，请在其基础上续写/扩写并与原文风格保持一致。',
  },
  {
    id: 'topic',
    label: '选题',
    enabled: true,
    keywords: ['选题', 'topic', '热点', '角度'],
    skills: ['baoyu-infographic'],
    description: '围绕主题产出选题与角度建议。',
    prompt:
      '你是一名内容策划。下面给你一段 Markdown 正文（通常是主题/方向/草稿）与用户补充要求。' +
      '请直接输出 Markdown 格式的选题方案（不要解释、不要代码块包裹）：' +
      '包含 5-8 个候选选题，每个选题给出标题、目标读者、核心角度与一句话亮点；' +
      '最后用一段话推荐其中最值得做的一个并说明理由。',
  },
  {
    id: 'illustrate',
    label: '配图建议',
    enabled: true,
    keywords: ['配图', 'illustrate', '图片', '封面'],
    skills: ['apiyi-image-generation'],
    description: '为内容生成配图/封面提示词建议。',
    prompt:
      '你是一名视觉编辑。下面给你一段 Markdown 正文与用户补充要求。' +
      '请直接输出 Markdown 格式的配图方案（不要解释、不要代码块包裹）：' +
      '为该正文建议 2-3 处配图/封面位置，每处给出：位置说明、画面描述、风格关键词、' +
      '以及一段可直接用于文生图模型的英文 prompt。',
  },
  {
    id: 'xiaohongshu',
    label: '小红书排版',
    enabled: true,
    keywords: ['小红书', 'xiaohongshu', '排版'],
    skills: ['xiaohongshu'],
    description: '按小红书风格重排/改写内容。',
    prompt:
      '你是一名小红书内容运营。下面给你一段 Markdown 正文与用户补充要求。' +
      '请直接输出小红书风格的 Markdown 正文（不要解释、不要代码块包裹）：' +
      '标题使用 emoji + 痛点/利益点，正文分短段落并使用 emoji 分隔，' +
      '保留核心信息，语气亲切、有代入感，结尾给出 5-8 个相关话题标签（# 开头）。',
  },
  {
    id: 'wechat-layout',
    label: '公众号排版',
    enabled: true,
    keywords: ['公众号', 'wechat', '排版', 'gzh'],
    skills: ['gzh-design', 'dashiai-ppt'],
    description: '按公众号风格排版内容。',
    prompt:
      '你是一名微信公众号编辑。下面给你一段 Markdown 正文与用户补充要求。' +
      '请直接输出适合公众号发布的 Markdown 正文（不要解释、不要代码块包裹）：' +
      '开头 2-3 句钩子引入，主体用清晰小标题分段，段落简短（每段不超过 4 行），' +
      '关键句可加粗，结尾给出总结与一句互动引导。保留原文核心信息。',
  },
];
