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
   构造 system prompt → LLM（流式）→ 有 tool_calls 就执行工具并回喂 → 直到最终回复
      │
      ├── LLM 调用（providers/）
      │     ├── tauri.ts → Rust 命令 ai_chat_stream（rig-core，多供应商）
      │     │              文本增量经 ipc::Channel 推送（delta 事件）
      │     └── mock.ts  → 规则解析（浏览器演示态，不联网走通全链路）
      │
      ├── 能力容器（container.ts，唯一事实源）
      │     ├── tools/          → glob 自动扫描装载（新增文件即生效）
      │     ├── page-actions/   → 页面动作 → ui_action 工具
      │     └── Rust 能力上报   → agent_capabilities 命令 → 桥接工具
      │
      └── 工具执行
            ├── navigation.ts → navigate         页面跳转（vue-router）
            ├── query.ts      → query_data       数据查询（lib/db.ts，浏览器/SQLite 双模式）
            ├── docs.ts       → find_docs        文档检索（构建期内联 docs/*.md）
            ├── analyze.ts    → analyze          深度分析（analysis/ 引擎，内置成绩分析器）
            ├── student-ops.ts → manage_students 学生档案写操作（确认门）
            ├── roster-import.ts → import_student_roster 花名册导入（智能识别姓名列，确认门；成绩单自动分流）
            ├── score-import.ts → import_score_sheet 成绩单导入（生成考试批次，确认门）
            ├── ui_action     → 页面按钮动作（容器按当前页面动态生成参数枚举）
            └── Rust 桥接     → photos / rag_reindex / semantic_search / roster_read_text / roster_read_table（IPC）
                                    │
外部 MCP 客户端 ──────────────────┘
（aprilio mcp serve → rmcp stdio server，只读工具面，见下文）
```

三层职责划分的原因：

- **循环在 TS**：多数工具的执行体在前端（路由、数据层、文档），循环贴近工具
  执行不需要 Rust ↔ 前端往返；vitest 用 mock provider 可全链路测试循环。
- **LLM 协议转换在 Rust**（`src-tauri/src/ai.rs`）：rig-core 负责多供应商适配与密钥，
  前端只发「消息 + 工具定义」，只收「文本 + tool_calls」。
- **能力容器是唯一事实源**（借鉴 Spring 组件管理）：注册 / 去重 / 条件装配 /
  `onChange` 事件广播都发生在容器；system prompt 能力段、工具注册表、
  MCP 工具面都是容器的视图。

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
Agent 可达页面的唯一清单：home / classes / students / photos / profile / settings，
另支持 `student-detail` + `student_id` 跳学生详情（先查库校验存在性）。

### query_data —— 数据查询

只暴露结构化参数（`entity` + 过滤条件 + `limit`），不把裸 SQL 交给模型，
避免注入与误写。实体：`students`（姓名/学号关键词、班级过滤）、
`photos`（学生 ID、说明关键词）、`stats`（汇总统计）、`behaviors`（日常表现）、
`exams`（考试批次，班级/考试名/种类 `exam_type`（大考/小考）过滤）、
`scores`（成绩明细，班级/考试 ID/学生/科目过滤）。

### analyze —— 深度分析（AnalysisEngine）

把分析请求按 `kind` 路由到 `src/agent/analysis/` 的分析器。内置**成绩分析器**
（`providers/score-analysis.ts`，装配处 `tools/analyze.ts` 调 `registerScoreAnalysisProvider`）：

| kind | payload | 产出 |
| --- | --- | --- |
| `score_overview` / `score_class` | `class_name`，可选 `exam_id` | 班级统计（均分/极值/及格率/优秀率/各科）+ 总分排名 |
| `score_student` | `student_id` 或 `name`（+`class_name`） | 个人历次成绩、排名、进退步、偏科诊断 |
| `score_rank` | `class_name`，可选 `exam_id` | 总分排行榜 |
| `score_trend` | `student_id`/`name`（个人）或 `class_name`（班级） | 个人各次总分走势，或班级多次考试趋势（平均单科分 / 及格率 / 优秀率） |

统计口径与界面共用 `lib/score-analysis.ts`，助手回答的数字与界面展示一致。
新增分析器 = 实现 `AnalysisProvider` → 在 `analysis/providers/` 导出 → 在 `analyze.ts` 补一行注册。

### find_docs —— 文档查找（广义数据查询）

构建期 `import.meta.glob` 内联 `docs/*.md`，按行做关键词命中打分，
返回带文档标题与行号的片段。应用文档（含本文）都在检索范围内。

### import_student_roster —— 花名册导入

写操作（确认门）。把 CSV/TSV 花名册导入学生档案，底层走智能导入管道：
根据表头与单元格内容自动识别姓名列（已配置模型时由 AI 辅助判断），
其余列按表头映射；置信度低时返回候选列，让用户确认后带 `name_column` 重调。
文件选择、识别规则与去重策略详见 [docs/ROSTER_IMPORT.md](ROSTER_IMPORT.md)。
若加载的其实是一份成绩单，会自动转入成绩导入（见下）。

### import_score_sheet —— 成绩单导入

写操作（确认门）。把成绩单导入为一次考试批次（考试名 + 考试时间，可自动提取也可指定），
成绩自动关联学生档案；成绩单里没有的学生自动建档，学号或姓名匹配已有档案。
识别规则与幂等策略详见 [docs/SCORE_IMPORT.md](SCORE_IMPORT.md)。

## 如何新增能力（TS 执行面）

1. 在 `src/agent/tools/` 新建文件，用 `defineAgentTool()`（src/agent/define.ts）
   产出并 **default export**：`definition`（name / label / description / JSON Schema）
   + `execute(args, ctx)`；失败时返回 `{ ok: false, error }`，
   循环会把错误回喂模型，不会中断会话。
2. 完事。`import.meta.glob` 自动扫描装载，`label` 就是工具卡片中文名——
   **不改 registry、不改 useAgent、不改任何清单文件**。
3. 补一条 vitest 测试（参考 `tests/agent-*.test.ts`）。

工具的 `dangerous: true` 标记写操作，执行前会走 GUI 内二次确认。

### 页面动作（ui_action）

「操作当前页面上的具体按钮」走页面动作机制：在 `src/agent/page-actions/`
新建文件，`definePageAction()` 声明（page / name / label / run）并 default export。
容器按当前路由动态生成 `ui_action` 工具的参数枚举，模型只能选清单内的动作；
视图触发用 `emitPageAction()`（src/agent/page-action-bus.ts），
StudentsView 有现成接法（动作清单 + beforeUnmount 退订）。

## 如何新增能力（Rust 执行面）

Rust 侧用 `inventory` 散装注册（对应 Spring 的组件扫描，见
`src-tauri/src/capabilities.rs`）：

1. 实现（或复用）一个 Tauri 命令，挂进 lib.rs 的 `generate_handler!`；
2. 就地 `crate::register_capability!` 声明：name / label / description / command /
   dangerous / parameters（JSON Schema 的 raw 字符串；参数名与命令参数一致）；
3. 完事。链接期自动收集，启动时经 `agent_capabilities` 命令上报前端容器合并，
   `log_inventory` 会对账（声明了能力但没注册命令 → 启动日志报错）；
   只读能力若未在 MCP 工具面暴露，MCP 启动时也会提示。
   参考实现：`rag.rs` 的 `semantic_search` / `rag_reindex`。

注意：`parameters` 必须是 JSON 字符串字面量——inventory 的收集单元是 static，
`json!()` 宏非常量不能在 static 求值。

## 流式输出（P2）

`ai_chat_stream` 与 `ai_chat` 共用同一套请求构造与供应商映射（ai.rs 的
`prepare_request` + `dispatch_provider!` 是唯一事实源），差别只在执行模式：

- 一次性（`ai_chat`）：`model.completion(req)`，返回完整结果；
- 流式（`ai_chat_stream`）：`model.stream(req)`，助手文本增量经
  `tauri::ipc::Channel` 逐段推 `{ type: "delta", text }` 事件，
  最终结果（全文 + tool_calls）仍随命令返回值一次性给出。

前端链路：`providers/tauri.ts` 建 Channel → `loop.ts` 转成 `text-delta` 事件 →
`useAgent.ts` 维护「进行中」助手条目（工具调用开始即定格，下一轮增量另开条目）。
mock provider 整段模拟一次 delta，保证与真实 provider 走同一条事件路径。

工具清单的动态性：循环每轮调用都携带容器 `resolveTools()` 的当前工具表，
新增工具对下一轮请求立即可见——不需要 Rust 侧维护常驻注册表（Tool Server）。

## MCP 出口（P3）：aprilio mcp serve

应用二进制内置一个 rmcp stdio MCP server，供外部 Agent 客户端（Goose、
Claude Desktop 等）接入。命令行 `aprilio mcp serve` 进入 MCP 模式
（不启动 GUI，stdout 只跑 MCP 协议，日志走 stderr）。

- **工具面只读**：`photos_dir`、`list_students`、`get_stats`、`list_photos`、
  `list_exams`（考试批次）、`get_exam_scores`（成绩明细）、`semantic_search`，
  统一标注 `read_only_hint`；写操作永不暴露
  （前置条件：数据脱敏开关 + GUI 内审批机制，均未落地）。
- **脱敏投影**：学生查询不含监护人电话、住址、生日等敏感字段。
- **同源不同执行体**：MCP 子进程没有 Tauri 上下文，无法调用前端执行体，
  因此只读工具在 Rust 侧独立实现（`mcp_server.rs` + `db.rs` 直连同一 SQLite）；
  目录解析走 `paths.rs`（与 tauri-plugin-sql 同一个 `%APPDATA%/<identifier>` 目录）。
- **对账**：启动时比对 inventory 只读能力与 MCP 工具面，新增 Rust 能力若未
  在 MCP 暴露会在 stderr 提示，防遗漏。

## 语义检索（P4）：rag_reindex / semantic_search

`src-tauri/src/rag.rs`：Ollama embedding（`/api/embed`，默认模型 `bge-m3`，
需先 `ollama pull bge-m3`）+ SQLite 向量存储（L2 归一化 BLOB + 暴力余弦）。

- 索引素材：在读学生档案（姓名/学号/班级/备注）与照片记录（文件名/说明/学生）。
- `rag_reindex`：全量重建（embedding 只发往本机 Ollama；base_url 指向远端等于
  把档案文本送出本机，调用方需明确知晓）。
- `semantic_search`：Top-K 余弦检索；换 embedding 模型后必须重建索引
  （维度不符的旧向量自动跳过）。
- 向量存储刻意不用 LanceDB：其依赖树（datafusion/arrow）+25MB 违反 10MB
  约束；SQLite 方案在万级条目下查询 <1ms，接口已按可替换形状设计。

两个工具都经 `register_capability!` 注册，自动进入 TS 容器（含确认门体系）
与 MCP 工具面——新增 Rust 能力「放文件即被感知」在两轨都成立。

## 能力容器（Spring 思想的落法）

`src/agent/container.ts` 是能力容器的唯一事实源，借了 Spring 四样、刻意不借四样：

- **借**：容器（注册/去重/事件广播）、声明式工厂（`defineAgentTool` /
  `definePageAction` 对应 `@Component`）、条件装配（`condition(ctx)` 谓词，
  如 Tauri 态才装照片工具）、生命周期事件（`onChange` → 增量同步下游视图）。
- **不借**：构造器注入、AOP、Bean 作用域、循环依赖处理——组件就十几个量级，
  完整 IoC 是过度设计。

TS 没有运行时反射，「扫描」注定是构建期的（`import.meta.glob`）；真正的运行时
动态性来自容器 `onChange` 事件广播。manifest（manifest.ts）只是容器的视图之一。

## 隐私与安全

- API 密钥只存在本机 localStorage（`enc1:` 混淆存放、不躺明文，历史明文自动兼容读入），
  设置页默认脱敏显示（`maskApiKey` 只露头尾，「查看」一键明文、保存后自动收起），
  LLM 请求由本机 Rust 进程发出。注意混淆只是防偷窥而非加密，不防能读本机文件的人。
- `query_data` 的查询结果会进入 LLM 上下文：本地模型无碍；
  **走云 API 时含监护人电话等敏感字段，待加脱敏开关**（字段白名单/打码）后再默认开启云调用。
- 工具默认只读。写操作（`dangerous: true`）有两道闸：
  容器在执行时校验 `confirm:true` 参数——模型必须先向用户说明影响、
  征得同意后带 `confirm:true` 重新调用，否则直接拒绝并提示补确认；
  页面动作（ui_action）同理。

## 演示态

浏览器模式（`npm run dev`）下没有 Tauri 外壳，Provider 自动切到
`mock.ts` 规则解析：「打开学生列表」「现在有多少学生」「查一下林知远」
都能走完 理解 → 调工具 → 回喂 → 总结 的完整链路，方便调 UI 与跑测试。
