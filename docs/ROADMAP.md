# 路线图与选型记录

README 只描述「现在是什么」，这里记录「为什么这么选、接下来做什么」。

## AI Agent 选型（2026-09 定）

**决策：接 `genai`，手写定制 agent 循环，代码放 `src-tauri`（Rust 侧）。**

### 需求

自然语言 → 应用自己决定调用哪些数据操作（查学生 / 查照片 / 出统计 / 写备注）。
本质是 LLM 函数调用循环（tool calling loop），工具集固定且少（5~8 个）。

### 备选与结论

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| **genai + 手写循环** | ✅ 采纳 | 多提供商统一 API（OpenAI / DeepSeek / GLM / Kimi / Ollama 等），国内模型一等公民；纯积木不绑架构；工具少时重框架无增量价值 |
| Rig (`rig-core`) | 备选 | 最接近 LangChain 的 Rust 框架（8.5k star，活跃，近 90 天下载 142 万）；日后要 RAG / 本地模型（内置 Candle，可跑 Qwen3）时再迁 |
| Swiftide | 参考 | agent harness + human-in-the-loop 模式值得借鉴；支持 Dashscope；v0.32 后更新节奏偏慢 |
| langchain-rust | ❌ 否决 | 2024-10 起停更 |
| Python sidecar | ❌ 暂否决 | 安装包 +80~200MB、PyInstaller 杀软误报、双语言栈维护；仅当必须用 Python 独有库（特定 OCR / 自研 Python 模型）时重启评估 |
| rmcp | 按需 | MCP 官方 Rust SDK；若要接入外部 MCP 工具生态再加 |
| TS 前端直连 API | 仅原型 | API Key 暴露在 WebView，只用于第 1 步验证交互形态 |

活跃度数据（2026-09 查证）：genai 近 90 天下载 12.2 万，v0.7.0-beta 持续维护中。

### 约束

- 学生隐私数据本地优先：优先 Ollama 本地模型；走云 API 时只传脱敏摘要
- API Key 存系统钥匙串，不进 WebView
- 不引入 Python 运行时，安装包体积保持 ~10MB 量级

## 待办

### 第 0 步 · 修复 src-tauri 契约（前置，约半天）

- [ ] `Cargo.toml`：补 `tauri-plugin-sql` / `dialog` / `fs` / `opener` 依赖
- [ ] `lib.rs`：注册插件 + 恢复迁移 + 恢复 `photos_dir` / `import_photo` / `delete_photo_file` 命令
- [ ] `capabilities/default.json`：补 `sql:allow-execute`、`sql:allow-load`、`sql:allow-select`、`dialog:default` 等权限
- [ ] `npm test` 转绿（`tauri-capability.test.ts`）
- [ ] 清理 `db.ts` / `StudentsView.vue` 里的 TEMP-DEBUG `dbg()` 代码

### 第 1 步 · AI 原型（1~2 天）

- [ ] `src/lib/ai.ts`：TS 层直连云端 API（fetch + SSE）
- [ ] 新增 AIAssistant 视图（对话式 UI，风格沿用设计系统）
- [ ] 首个场景：自然语言查学生，逐步替换 StudentsView 的 LIKE 搜索框

### 第 2 步 · 下沉到 Rust（2~3 天）

- [ ] `Cargo.toml`：加 `genai` + `tokio`
- [ ] `src-tauri/src/ai/tools.rs`：把数据层包装成工具（`query_students` / `get_stats` / `search_photos` / `add_student_note`）
- [ ] `src-tauri/src/ai/mod.rs`：tool calling 循环 + system prompt
- [ ] `tauri::ipc::Channel` 流式推送 token 到前端
- [ ] 前端只留渲染，删除直连 API 代码

### 以后再说

- [ ] Ollama 本地模型（完全离线模式）
- [ ] 照片语义搜索（RAG + 向量化 → 届时评估迁 Rig + Candle）
- [ ] 接 MCP 工具生态（rmcp）