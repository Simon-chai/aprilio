# Agent 技术栈方案：Rig + rmcp

日期：2026-09-04 · 决策：**内嵌引擎迁 Rig（替换 genai），能力出口走 rmcp（应用内 MCP server）。不引入 Goose、Mastra、Swiftide 等，理由见文末附录。**

---

## 1. 架构总览：双轨 + 一份能力清单

```
                       ┌──────────────────────────────────────┐
                       │    能力容器 container.ts             │
                       │  tools 自动扫描 │ 页面动作注册表      │
                       │  （单一事实源，内外两轨共用）          │
                       └────────┬───────────────┬─────────────┘
                                │               │
   ┌────────────────────────────▼───┐   ┌───────▼──────────────────────┐
   │  内嵌轨（Tauri 进程内）          │   │  外部轨（指令入口）            │
   │                                │   │                              │
   │  AgentChat.vue → loop.ts       │   │  rmcp MCP server             │
   │        │ (TS 循环，不动)        │   │   ├ stdio: aprilio mcp serve   │
   │        ▼                       │   │   └ 工具表由 manifest 直出    │
   │  ai.rs: genai → rig-core       │   │  → Goose / Claude / IDE      │
   │   ├ 20+ provider 统一 API      │   │    等任意 MCP 客户端          │
   │   ├ ai_chat_stream（流式）      │   │    可用指令操作本应用          │
   │   ├ 动态工具 = 逐请求透传       │   │                              │
   │   └ 消息协议不变，TS 侧零改动   │   │                              │
   └────────────────────────────────┘   └──────────────────────────────┘
```

原则：**能力只声明一次**。manifest 生成三样东西——内嵌轨的工具数组、system prompt 的能力段、MCP server 的工具表。新增功能文件即被两轨同时感知。

## 2. Rig 侧：怎么玩

### 2.1 迁移路径（genai → rig-core）

- 改动面收敛在 `src-tauri/src/ai.rs`（460 行）：`AgentMessage ↔ AiMessage` 消息协议、工具定义透传、tool_calls 返回——**对外契约不变**，只换内部实现。TS 侧 `providers/tauri.ts`、循环、UI、测试全部零改动。
- Rig 的 `Agent`/`CompletionClient` 负责多供应商与 tool-calling 解析，替代手写的 genai 适配代码，`ai.rs` 预期缩到 ~300 行。
- 国内模型走 OpenAI-compatible：DeepSeek / GLM / Kimi 用 rig 的 openai provider 换 `base_url`；本地模型走 Ollama provider。与 genai 的能力对齐且更全。

### 2.2 动态工具：逐请求透传（P2 落地形态）

计划中的「Rust 侧 Tool Server」最终不需要：循环在 TS，工具执行体也在 TS，
`ai_chat_stream` 每轮请求都携带容器 `resolveTools()` 的当前工具清单——
新增工具对下一轮请求立即可见，天然动态。Rust 侧维护常驻工具注册表反而
多一份状态要同步。

- 前端容器装载全部能力，每次 LLM 调用随请求透传工具定义；
- 新增工具文件 → 容器装载 → 下一轮请求生效（无需重启或重编译调度层）；
- 容器 `onChange` 事件保留为增量同步接口（热更新场景 / 未来 Rust 常驻能力用）。

工具执行链仍是「Rust 只转发、前端执行」，维持零 IPC 成本的分层。

### 2.3 流式与 RAG

- streaming（P2 已落地）：rig 0.42 `CompletionModel::stream` + `tauri::ipc::Channel`
  推 `{ type: "delta" }` 增量，最终结果随命令返回值一次性给出；
  `ai_chat` / `ai_chat_stream` 共用 `prepare_request` + `dispatch_provider!` 唯一事实源。
- RAG（P4 已落地）：embedding 走 Ollama `/api/embed`（默认 `bge-m3`，本地优先）；
  向量存储用 **SQLite BLOB（L2 归一化）+ Rust 暴力余弦**，不用 LanceDB——
  其依赖树（datafusion/arrow 全家桶）会使安装包 +25MB，违反 ~10MB 约束；
  万级条目下暴力余弦 <1ms，接口按可替换形状设计，数据量上来再升级。
  场景：学生档案与照片说明的语义搜索（`semantic_search` / `rag_reindex`）。
- evals：按需（工具调用质量回归），未排期。

### 2.4 pre-1.0 风险对冲

- `Cargo.toml` 锁精确版本（不用 `^`）；升级走 CHANGELOG。
- `ai.rs` 内留一层 ~100 行的私有适配模块（消息/工具定义 ↔ rig 类型的转换），rig 破坏性变更只改这一层。

## 3. rmcp 侧：怎么玩

### 3.1 形态：应用内 MCP server

用 MCP 官方 Rust SDK `rmcp`，在 Tauri 进程内起 MCP server，把 manifest 的工具表以 MCP 标准暴露。外部任何 MCP 客户端（Goose、Claude Desktop、各家 IDE agent）配置一次即可用自然语言/指令操作本应用。

### 3.2 传输选型

| 方式 | 说明 | 取舍 |
| --- | --- | --- |
| **stdio（推荐）** | 随应用带一个 CLI 子命令（`aprilio mcp serve`），外部 agent 以子进程方式拉起 | 不开端口、无攻击面；与所有 MCP 客户端兼容性最好 |
| streamable HTTP | 应用监听 localhost 端口 | 多客户端并发方便，但引入端口管理与本地越权风险，二期再议 |

stdio 形态下注意：CLI 子命令与 GUI 进程的数据库并发访问用 SQLite WAL 模式解决；CLI 只做 MCP 转发，能力执行仍优先路由到与 GUI 相同的查询层。

### 3.3 暴露范围与安全

- 首批只暴露只读工具：`query_data` / `find_docs` / `navigate`。
- 写操作（新增学生、写备注）暴露前必须落两件事：**字段脱敏开关**（监护人电话等，AGENT.md 隐私节已列）+ **MCP 侧操作确认**（外部 agent 无 UI 可弹，采用 pending-审批：写操作先挂起，GUI 内确认后执行，参考 Swiftide 的 human-in-the-loop 模式）。
- MCP 工具描述文案与容器共用同一份，避免内外行为漂移。

## 4. 能力容器（借鉴 Spring 组件管理，两轨的公共地基）

「动态感知」的机制不靠扫描本身，靠**容器**：所有能力组件在启动时装载进容器，
容器是唯一事实源，内嵌轨工具表、system prompt 能力段、MCP 工具表都只是容器的视图。

### 4.1 Spring 概念映射

| Spring 概念 | aprilio 对应物 | 说明 |
| --- | --- | --- |
| IoC 容器 | `container.ts` 能力容器 | 注册 / 去重 / 条件装配 / 变更事件，唯一事实源 |
| `@Component` 注解 | `defineAgentTool()` / `definePageAction()` 声明式工厂 | TS 无运行时注解，以「工厂 + 约定式导出」等价替代 |
| classpath 扫描 | `import.meta.glob('./tools/*.ts')` | 两者同为构建期已知、启动期注册；dev 下新文件热更新即被感知 |
| `@Conditional` 条件装配 | `condition(ctx)` 谓词 | 如照片工具只在 Tauri 桌面模式装配，浏览器 mock 态自动排除 |
| 依赖注入 | `AgentToolContext` 升级为能力容器 | 工具声明依赖（router / db / 确认服务），容器注入，不全局抓取 |
| 生命周期事件 | `onChange` 广播 | 容器变化 → 增量同步 Rust Tool Server（P2）与 MCP 工具表（P3） |

### 4.2 结构与声明方式

```
src/agent/
├── container.ts       # 能力容器：注册/去重/条件装配/onChange 事件（合并 Rust 侧上报）
├── define.ts          # defineAgentTool / definePageAction 声明式工厂
├── manifest.ts        # 容器视图：AgentTool[] + prompt 能力段 + MCP 工具表
├── tools/             # glob 自动扫描装载，新增文件即生效
└── page-actions/      # 各视图声明可操作按钮/动作 → ui_action 工具的枚举参数

src-tauri/src/
└── capabilities.rs    # Rust 执行面：inventory 散装收集，启动时经 IPC 上报 TS 容器
```

```ts
// tools/search-photos.ts —— 新增能力 = 新增一个文件
export default defineAgentTool({
  name: "search_photos",
  label: "搜索照片",
  tags: ["photos", "readonly"],
  condition: (ctx) => ctx.capabilities.has("tauri"),
  parameters: { /* JSON Schema */ },
  execute: async (args, ctx) => { /* ... */ },
});
```

### 4.3 刻意不引入的部分

组件总量在十几这个量级，完整的 IoC 是过度设计：不做构造器注入、不做 AOP、
不做 Bean 作用域/循环依赖处理。只借四样——**容器、声明式注册、条件装配、生命周期事件**。

### 4.4 双语言：一个容器、两个执行面

能力不只在 TS 层——Rust 侧已有 photos 三命令，后续 RAG、MCP server 都在 Rust。
**容器是逻辑上的一个，执行面有两个**：工具定义带 `executor: "ts" | "rust"` 判别字段，
rust 类工具在定义里指向 Tauri 命令名，执行时直接路由到 Rust，不做跨语言回环。

| 层 | 注册机制 | Spring 对应物 |
| --- | --- | --- |
| TS 执行面 | `import.meta.glob` 扫描 + `defineAgentTool` 工厂 | classpath 扫描 + `@Component` |
| Rust 执行面 | `inventory` crate 散装注册（编译期写入、链接期自动收集，跨 crate 生效） | `#[component]` 宏的底层机制（summer-rs 即用此实现） |

- Rust 侧起一个 `capabilities.rs`：各模块用 `inventory::submit!` 声明能力
  （名称/描述/参数 schema/命令名），启动时一次性收集，经 IPC 推给 TS 容器合并进 manifest。
- 新增 Rust 能力 = 新增一个带 `inventory::submit!` 的文件，与 TS 侧「放文件即生效」对称。
- Tauri 的 `invoke_handler` 本身就是命令注册表，Rust 容器与其对账（声明了能力但没注册命令 → 启动即报错）。

**框架取舍（2026-09-04 核实）**：
- Rust：`spring-rs`（已更名 **summer-rs**，v0.7.x，2026-05 活跃）是最完整的 Spring Boot 复刻
  （ComponentRegistry + `#[component]` 宏 + DI），但其 `#[component]` 底层正是 `inventory`；
  summer-rs 自带 web/job/配置体系，与 Tauri 的应用容器角色重复，**借 `inventory` 机制，不引框架**。
- TS：NestJS / Midway / Ts.ED 均需 Node 运行时（违反 10MB 约束，同 Mastra 落选理由）；
  InversifyJS / Awilix 可跑 WebView 但装饰器 DI 在 TC39 decorators + esbuild 下元数据支持残缺，
  为十几个组件引入不值；页面动作注册可直接搭 Vue 自带的 `provide/inject`（现成的小型 DI）。

### 4.5 效果

- 新增一个工具：`tools/` 放文件即可，容器装载 → 内嵌轨 / MCP 工具表同步生效。
- 新增一个页面：视图声明 `pageActions`，动作自动进入 Agent 与 MCP 可操作范围。
- `docs/*.md` 自动内联检索维持现状。

## 5. 分阶段路线

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0（1~2 天） ✅ | 能力容器 + tools 自动扫描装载 + 页面动作注册表 + `ui_action` 首批动作；写操作加 GUI 内二次确认 | 新增工具/页面不再改注册表代码 |
| P1（2~3 天） ✅ | `ai.rs` genai → rig-core 迁移（协议不变换底座），锁版本 + 适配层 | agent 测试全绿，多 provider 可切 |
| P2（2~3 天） ✅ | 流式输出：`ai_chat_stream`（rig stream + ipc::Channel）；动态工具 = 逐请求透传（见 §2.2） | 助手回复逐段渲染；新增工具下一轮立即可见 |
| P3（3~5 天） ✅ | rmcp MCP server（stdio 子命令 `aprilio mcp serve`），首批只读工具（脱敏投影）；写操作待脱敏开关 + 审批 | 外部 MCP 客户端可查学生/照片/语义检索 |
| P4（按需） ✅ | Ollama embedding（bge-m3）+ SQLite 向量存储（LanceDB 降为升级位，见 §2.3）；`semantic_search` / `rag_reindex` | 语义检索经容器两轨可用 |

依赖关系：P0 独立可先行；P1 → P2 串行；P3 依赖 P0（工具表来自 manifest），与 P1/P2 可并行；P4 最后。

## 6. 风险清单

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| rig pre-1.0 破坏性变更 | 中 | 锁版本 + ai.rs 适配层隔离 |
| TLS 加密栈编译环境坑（ring/aws-lc 的 C 编译依赖本机工具链） | 中 | 全链路 native-tls（Windows schannel，纯绑定零 C 编译）；rig-core 关默认 features 换 native-tls，reqwest 与 rig 统一 0.13 单版本 |
| rmcp / MCP 规范演进 | 低 | 只用 stdio + tools 核心 子集，不碰实验特性 |
| 前端↔Rust 工具桥接延迟 | 低 | 桥接只传定义与结果，执行仍在前端 |
| MCP 写操作被外部 agent 滥用 | 中 | 首批只读；写操作 pending-审批 + 脱敏开关前置 |
| SQLite GUI/CLI 并发 | 低 | WAL 模式 + 单写者约定 |

---

## 附录：落选记录（2026-09-04 复核）

| 方案 | 结论 | 一句话理由 |
| --- | --- | --- |
| Goose | ❌ 不引入 | 独立产品非库，嵌入需 sidecar、工具面（shell/文件执行）与本地隐私场景错位；MCP 生态红利通过 rmcp 即可获得，无需装 goose |
| Swiftide | ❌ 观察 | provider 面窄（国内模型需自写适配）、社区小；HITL 审批模式已借鉴进 P3 写操作设计 |
| Mastra / LangGraph.js | ❌ | 需 Node 运行时，违反 ~10MB 安装包约束 |
| Vercel AI SDK | ❌ | 需 API Key 进 WebView，推翻现有安全决策 |
| Python sidecar | ❌（维持） | +80~200MB、杀软误报、双语言栈 |
| genai | 退役 | 保留至 P1 迁移完成；只做协议转换，无 RAG/流式/动态工具 |

历史选型记录（2026-09 初版对比）见 git 历史；本版为聚焦 rig+rmcp 后的收敛版。
