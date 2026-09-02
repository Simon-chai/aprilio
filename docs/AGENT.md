# Agent 框架与工具扩展指南

应用内置的自主 Agent：通过全局聊天浮层（右下角）用自然语言操作应用——
跳转界面、查询数据、检索文档。本文是框架的使用与扩展说明，
同时也是 `find_docs` 工具的检索内容之一（可以向助手提问「你能做什么」）。

## 架构分层

```
用户消息（AgentChat.vue / useAgent.ts）
      │
      ▼
src/agent/loop.ts —— tool-calling 循环（TS 侧）
   构造 system prompt → LLM → 有 tool_calls 就执行工具并回喂 → 直到最终回复
      │
      ├── LLM 调用（providers/）
      │     ├── tauri.ts → Rust 命令 ai_chat（genai，多供应商）
      │     └── mock.ts  → 规则解析（浏览器演示态，不联网走通全链路）
      │
      └── 工具执行（tools/，全是前端能力，零 IPC）
            ├── navigation.ts → navigate    页面跳转（vue-router）
            ├── query.ts      → query_data  数据查询（lib/db.ts，浏览器/SQLite 双模式）
            └── docs.ts       → find_docs   文档检索（构建期内联 docs/*.md）
```

两层职责划分的原因：

- **循环在 TS**：三个工具的执行体都在前端（路由、数据层、文档），循环贴近工具
  执行不需要 Rust ↔ 前端往返；vitest 用 mock provider 可全链路测试循环。
- **LLM 协议转换在 Rust**（`src-tauri/src/ai.rs`）：genai 负责多供应商适配与密钥，
  前端只发「消息 + 工具定义」，只收「文本 + tool_calls」。

### 消息协议（TS ↔ Rust）

`AgentMessage`（src/agent/types.ts）与 Rust `AiMessage`（serde `tag = "role"`）一一对应：

| role | 字段 | 说明 |
| --- | --- | --- |
| `user` | `content` | 用户输入 |
| `assistant` | `content` + `toolCalls?` | 模型回复；带 toolCalls 表示发起调用 |
| `tool` | `toolCallId` + `name` + `content` | 工具结果回喂 |

工具调用结构 `{ id, name, arguments }`；工具返回统一为
`{ ok, summary, data?, error? }`，`summary` 回喂模型，`data` 供 UI 摘要。

## 首期工具

### navigate —— 页面跳转

`NAV_TARGETS`（src/agent/tools/navigation.ts）是**应用界面注册表**，
Agent 可达页面的唯一清单：home / classes / students / photos / profile / design / settings，
另支持 `student-detail` + `student_id` 跳学生详情（先查库校验存在性）。

### query_data —— 数据查询

只暴露结构化参数（`entity` + 过滤条件 + `limit`），不把裸 SQL 交给模型，
避免注入与误写。实体：`students`（姓名/学号关键词、班级过滤）、
`photos`（学生 ID、说明关键词）、`stats`（汇总统计）。

### find_docs —— 文档查找（广义数据查询）

构建期 `import.meta.glob` 内联 `docs/*.md`，按行做关键词命中打分，
返回带文档标题与行号的片段。应用文档（含本文）都在检索范围内。

## 如何新增工具

1. 在 `src/agent/tools/` 新建文件，实现 `AgentTool`：
   `definition`（name / description / JSON Schema 参数）+ `execute(args, ctx)`；
   失败时返回 `{ ok: false, error }`，循环会把错误回喂模型，不会中断会话。
2. 在 `src/agent/registry.ts` 的 `defaultAgentTools()` 注册。
3. 在 `src/composables/useAgent.ts` 的 `TOOL_LABELS` 补一个中文名（工具卡片展示）。
4. 补一条 vitest 测试（参考 `tests/agent-*.test.ts`）。

「操作页面上的具体按钮」这类细粒度 UI 动作，建议沿用同一模式：
先做一个「页面动作注册表」（页面 → 动作名 → 触发函数），再包一个 `ui_action` 工具。

## 隐私与安全

- API 密钥只存在本机 localStorage，LLM 请求由本机 Rust 进程发出。
- `query_data` 的查询结果会进入 LLM 上下文：本地模型无碍；
  **走云 API 时含监护人电话等敏感字段，待加脱敏开关**（字段白名单/打码）后再默认开启云调用。
- 工具只读。写操作（新增学生、写备注）后续接入时应在工具内二次确认或限定范围。

## 演示态

浏览器模式（`npm run dev`）下没有 Tauri 外壳，Provider 自动切到
`mock.ts` 规则解析：「打开学生列表」「现在有多少学生」「查一下林知远」
都能走完 理解 → 调工具 → 回喂 → 总结 的完整链路，方便调 UI 与跑测试。
