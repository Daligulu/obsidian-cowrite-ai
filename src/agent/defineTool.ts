import type { App, Vault } from 'obsidian';
import { z } from 'zod';

/** 插件设置的最小形状（避免 agent 模块反向依赖完整 settings.ts 类型） */
export interface ToolSettings {
  imageApiBase: string;
  imageApiKey: string;
  imageModel: string;
  pagesDir: string;
  /** 主 apiKey（imageApiKey 为空时回退使用） */
  masterApiKey?: string;
}

/** 工具执行时能拿到的运行时上下文（Obsidian 只读引用 + 插件设置快照） */
export interface ToolContext {
  app: App;
  vault: Vault;
  /** 执行时的设置快照（insertImage 等需要） */
  settings?: ToolSettings;
}

/** 单个 Agent 工具：名字 + 描述 + Zod 参数 schema + 执行函数 + 可选渲染函数 */
export interface AgentTool {
  name: string;
  description: string;
  /** Zod 参数 schema（运行时 safeParse 校验模型传入的 JSON） */
  parameters: z.ZodObject<z.ZodRawShape>;
  /** 执行工具，返回可 JSON 序列化的结果（会回灌给模型） */
  execute(args: any, ctx: ToolContext): Promise<Record<string, unknown>>;
  /** 在侧边栏把工具结果渲染成卡片（可选） */
  render?(args: any, result: any, el: HTMLElement): void;
}

/**
 * 工具定义工厂：把 Zod schema 与执行函数组装成 AgentTool。
 * 类型上把 parameters 的 Zod shape 与 execute 的入参对齐，避免手写 any。
 */
export function defineTool<T extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  parameters: z.ZodObject<T>;
  execute: (args: z.infer<z.ZodObject<T>>, ctx: ToolContext) => Promise<Record<string, unknown>>;
  render?: (args: z.infer<z.ZodObject<T>>, result: any, el: HTMLElement) => void;
}): AgentTool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters as unknown as z.ZodObject<z.ZodRawShape>,
    execute: (args, ctx) => def.execute(args as z.infer<z.ZodObject<T>>, ctx),
    render: def.render as AgentTool['render'],
  };
}

// ---- Zod → JSON Schema 递归转换（只覆盖本插件用到的类型，不引第三方包） ----

function zodAnyToJsonSchema(schema: z.ZodTypeAny): object {
  const def: any = (schema as any)._def ?? {};
  const typeName: string = def.typeName ?? '';
  const out: Record<string, unknown> = {};

  switch (typeName) {
    case 'ZodString': {
      out.type = 'string';
      if (def.description) out.description = def.description;
      return out;
    }
    case 'ZodNumber': {
      out.type = 'number';
      if (def.description) out.description = def.description;
      return out;
    }
    case 'ZodBoolean': {
      out.type = 'boolean';
      if (def.description) out.description = def.description;
      return out;
    }
    case 'ZodEnum': {
      out.type = 'string';
      out.enum = Array.isArray(def.values) ? def.values.slice() : [];
      if (def.description) out.description = def.description;
      return out;
    }
    case 'ZodArray': {
      out.type = 'array';
      out.items = def.element ? zodAnyToJsonSchema(def.element as z.ZodTypeAny) : { type: 'string' };
      if (def.description) out.description = def.description;
      return out;
    }
    case 'ZodOptional':
    case 'ZodNullable': {
      // 可选字段在 object 层处理 required 列表；这里直接返回内层 schema
      return def.innerType ? zodAnyToJsonSchema(def.innerType as z.ZodTypeAny) : { type: 'string' };
    }
    case 'ZodObject': {
      const shape: Record<string, z.ZodTypeAny> =
        typeof def.shape === 'function' ? def.shape() : def.shape ?? {};
      const props: Record<string, object> = {};
      const required: string[] = [];
      for (const key of Object.keys(shape)) {
        const child = shape[key] as any;
        props[key] = zodAnyToJsonSchema(child as z.ZodTypeAny);
        const childTypeName: string = child?._def?.typeName ?? '';
        // ZodOptional/ZodDefault 视为可选，其余视为必填
        const isOpt = childTypeName === 'ZodOptional' || childTypeName === 'ZodDefault';
        if (!isOpt) required.push(key);
      }
      out.type = 'object';
      out.properties = props;
      if (required.length > 0) out.required = required;
      if (def.description) out.description = def.description;
      return out;
    }
    default: {
      // 兜底：未知类型按 string 透传，不让构建失败
      if (def.description) out.description = def.description;
      out.type = 'string';
      return out;
    }
  }
}

/** 把 Zod schema 转成 OpenAI function calling 需要的 JSON Schema */
export function toolToOpenAISpec(tool: AgentTool): {
  type: 'function';
  function: { name: string; description: string; parameters: object };
} {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodAnyToJsonSchema(tool.parameters),
    },
  };
}
