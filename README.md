# Cowrite AI (Obsidian 插件)

Obsidian 上自托管、自带 LLM 执行引擎的 **Cowrite 写作平台**。
所有页面与任务队列都存在你的 Obsidian vault 内；内置执行器直接通过你配置的 OpenAI 兼容 API 调用模型完成写作任务，**不需要任何外部服务端**。
纯浏览器 API 实现，**iOS / Android Obsidian App 同样可用**。

## 功能特性

- **页面库**：在 `Cowrite/` 目录下管理 Markdown 页面，一键新建/打开/删除。
- **任务队列**：对页面投递任务（润色 / 写作 / 选题 / 配图建议 / 小红书排版 / 公众号排版），状态机 `queued → running → succeeded | failed | cancelled`。
- **内置 LLM 执行器**：插件自动轮询队列，调用你配置的模型对页面进行改写并写回。
- **自定义模型 API**：任意 OpenAI 兼容服务（OpenAI 官方 / DeepSeek / 通义千问 / Kimi / 自建 vLLM / OneAPI 网关等）。
- **移动端适配**：不依赖 Node.js、不依赖本地文件系统路径，全部通过 Obsidian Vault API 与 `fetch()` 完成。
- **BRAT 发布**：仓库根目录直接包含 `main.js` / `manifest.json` / `manifest-beta.json` / `styles.css`，支持 BRAT 插件管理器 beta 通道。

## 安装（BRAT 方式）

1. 在 Obsidian 社区插件市场安装 **BRAT (Beta Reviewers Auto-update Tool)**。
2. 打开 BRAT 设置 → `Add Beta plugin`，填入本仓库地址：
   ```
   https://github.com/<your-github-username>/obsidian-cowrite-ai
   ```
3. 安装完成后在「第三方插件」中启用 **Cowrite AI**。

## 配置

启用后打开 `设置 → Cowrite AI`：

### LLM 接入

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| API Base URL | OpenAI 兼容接口根地址 | `https://api.openai.com/v1`、`https://api.deepseek.com/v1` |
| API Key | Bearer 鉴权密钥（仅保存在本地 `data.json`） | `sk-...` |
| 模型名称 | 你要调用的模型 id | `gpt-4o-mini`、`deepseek-chat`、`qwen-plus` |
| Temperature | 采样温度 0~2 | `0.7` |
| 最大生成 token | 单次请求 max_tokens | `2048` |
| 请求超时 | 单次请求超时（毫秒） | `60000` |

填完点「**发送测试**」验证连通性。

### 执行引擎

- **启用内置执行器**：插件启动后自动轮询队列。
- **并发数**：同时执行的任务数（1~3）。
- **轮询间隔**：检查队列的频率，默认 3 秒。

### 存储

- **页面目录**：默认 `Cowrite`。
- **任务文件**：默认 `.cowrite/tasks.json`。

## 使用

1. 点击右侧 Ribbon 图标 `lucide-pen-tool` 或命令面板「打开 Cowrite AI 控制台」。
2. 「＋ 新建页面」创建一篇 Markdown 笔记（也可以直接编辑已有笔记）。
3. 「＋ 投递任务」选择动作（润色/写作/选题/...）、目标页面、可选补充要求。
4. 任务进入 `queued`，内置执行器自动认领 → 调用 LLM → 把结果整体写回页面 → 标记 `succeeded`。
5. 失败任务可「重试」，排队任务可「取消」，任意任务可「删除」。

## 数据文件

- 页面：`<vault>/Cowrite/*.md`
- 任务队列：`<vault>/.cowrite/tasks.json`
- 动作配置：`<vault>/.cowrite/actions.json`（可选，首次使用回退内置默认动作集）
- 插件设置：`<vault>/.obsidian/plugins/cowrite-ai/data.json`

## 开发构建

```bash
# 安装依赖
npm install --registry=https://registry.npmmirror.com

# 开发模式（watch）
npm run dev

# 生产构建（产出 main.js）
npm run build
```

产物：

- `main.js` — 打包后的插件主入口（CJS）
- `manifest.json` — 插件元信息（稳定通道）
- `manifest-beta.json` — BRAT beta 通道（与 manifest.json 一致）
- `styles.css` — 控制台与 Modal 样式

## 目录结构

```
obsidian-cowrite-ai/
├── src/
│   ├── main.ts        # 插件入口、控制台视图、Modal、设置页
│   ├── types.ts       # 数据模型与默认动作集（含 prompt 模板）
│   ├── settings.ts    # 设置接口与默认值
│   ├── pages.ts       # 页面仓库（vault 内 Markdown CRUD）
│   ├── taskStore.ts   # 任务队列原子读写（vault.process 协议）
│   ├── actions.ts     # 动作配置读写
│   ├── llm.ts         # OpenAI 兼容 chat.completions 客户端
│   └── executor.ts    # 内置执行器（轮询 + 并发 + LLM 调用 + 写回）
├── manifest.json
├── manifest-beta.json
├── esbuild.config.mjs
├── tsconfig.json
├── version-bump.mjs
├── versions.json
├── styles.css
└── package.json
```

## License

MIT
