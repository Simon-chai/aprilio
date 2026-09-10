# 路线图与选型记录

README 只描述「现在是什么」，这里记录「为什么这么选、接下来做什么」。

## AI Agent 选型（2026-09 定，2026-09-04 收敛）

**决策：接 `genai` + 手写 agent 循环起步；收敛后迁移到 `rig-core`（内嵌引擎）+ `rmcp`（MCP 能力出口），双轨共用能力清单。完整方案见 [AGENT_FRAMEWORK_EVALUATION.md](AGENT_FRAMEWORK_EVALUATION.md)。**

### 需求演进

初期只要「自然语言 → 查数据/跳页面」（工具 5~8 个，genai 足够）；
后续要求：① 操作全部纳入框架且**动态感知**新增功能/接口；② 能处理文档、数据等日常事务。
这两点超出 genai 与手写循环的合理范围，2026-09-04 复核各框架后收敛为 Rig + rmcp。

### 备选与结论

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| **rig-core** | ✅ 采纳（P1 迁移） | Tool Server 支持运行时增删工具（匹配动态感知）；20+ provider、内置 RAG/向量库/流式/evals；迁移收敛在 `ai.rs` 换底座，消息协议不变 |
| **rmcp** | ✅ 采纳（P3） | MCP 官方 Rust SDK；应用内 MCP server 把能力清单直出工具表，外部 MCP 客户端（Goose / Claude 等）可指令操作本应用，不进安装包 |
| genai + 手写循环 | 过渡 | 2026-09 初版采纳，P1 迁移完成后退役 |
| Goose | ❌ 不引入 | 独立产品非库；MCP 生态红利经 rmcp 即可获得 |
| Swiftide | ❌ 观察 | provider 面窄、社区小；HITL 审批模式已借鉴进写操作设计 |
| Mastra / LangGraph.js | ❌ | 需 Node 运行时，违反 ~10MB 安装包约束 |
| Vercel AI SDK | ❌ | API Key 需进 WebView，推翻安全决策 |
| Python sidecar | ❌ 维持否决 | 安装包 +80~200MB、PyInstaller 杀软误报、双语言栈维护；仅当必须用 Python 独有库（特定 OCR / 自研 Python 模型）时重启评估 |
| TS 前端直连 API | 仅原型 | API Key 暴露在 WebView，只用于第 1 步验证交互形态 |

### 约束

- 学生隐私数据本地优先：优先 Ollama 本地模型；走云 API 时只传脱敏摘要
- API Key 存系统钥匙串，不进 WebView
- 不引入 Python / Node 运行时，安装包体积保持 ~10MB 量级
- MCP 首批只暴露只读工具；写操作待脱敏开关 + pending-审批机制落地

## AI 助手宠物形象选型（2026-09-09）

**决策：不引入独立桌宠应用；在首页右下角为 AI 助手赋予 Live2D 宠物形象。渲染层从 BongoCat 抽取（`easy-live2d` + `pixi.js` 薄封装，约 150 行组件），Rust 侧零改动。**

需求边界：应用内组件（Agent 助手的形象化），非独立窗口/全局桌宠——rdev 键鼠监听、透明置顶窗口、托盘、键盘贴图叠加全部不需要。

| 候选 | 结论 | 原因 |
| --- | --- | --- |
| **ayangweb/BongoCat** | ✅ 采纳其渲染层 | Tauri 2 + Vue 3 同构（MIT，活跃维护）；其核心渲染就是 `easy-live2d` 的 141 行封装（`src/utils/live2d.ts`），剥离成本低，API 可直接借鉴 |
| **easy-live2d** + pixi.js | ✅ 直接依赖 | MPL-2.0；Live2D 模型包成 Pixi Sprite，自带动作/表情/参数/lip sync（`playVoice`）API |
| TIUCSIB/deskpal | 备选 | Tauri 2 + Vue 3 精灵图方案，依赖最轻；Live2D 方案受阻时的退路 |
| Shimeji-ee 系 | 仅素材格式 | Java 栈不可嵌入 Tauri；46 帧 PNG + 行为 XML 可作精灵图素材来源，引擎需 TS 自研 |
| AkshitIreddy/AI-Desktop-Pet | ❌ | 架构可参考（单透明 overlay），但绑定 Convai 云服务，违反本地优先 |

### 约束与风险

- Cubism Core（`live2dcubismcore.js`）不在任何 npm 包（Live2D 许可限制），需从 Live2D 官网下载放 `public/Core/`，`index.html` 引入；SDK 对小规模经营者免费（附声明、禁逆向）
- **BongoCat 内置猫模型来自 Bongo-Cat-Mver 社区，授权未随 MIT 豁免，不可随本应用分发**；POC 用 Live2D 官方示例模型，正式形象需单独解决授权
- pixi.js ~450KB gzip：组件 dynamic import，AI 助手挂载时才加载，不占首屏
- 模型风格选扁平/简约，贴合 Apple 视觉，避免与设计系统冲突

### 落地（2026-09-10 细化）

**架构定为三层：宠物包（`pet.json`）+ `PetRuntime` 适配器 + Agent 事件桥；Live2D 只是适配器之一，不与宠物系统本体绑死。完整方案见 [DESKTOP_PET.md](DESKTOP_PET.md)。**

- [x] P0 · 可运行原型三个：`pet-studio.html`（接入演示：三只矢量宠物 + 图片 / pet.json 导入 + 状态机 + Agent 事件模拟）、`pet-rig.html`（矢量装配台：分层 SVG 解析与样式内联 + 结构校验 + 锚点可视化编辑 + 导出 pet.json）、`pet-raster.html`（贴图装配台：分层 PNG 部位自动识别 + 同尺寸原位对齐 + 拖拽摆位 + 图层排序 + 锚点编辑 + 从矢量模板生成演示贴图 + 导出 pet.json）；模板 `templates/layered-cat.pet.svg`
- [ ] P1 · 三个适配器：`vector-layered`（读 `assets/model.svg`，按 slots / pivots 驱动）+ `raster-layered`（按 `layers` 数组叠图，同尺寸对齐）+ `sprite`（单图 / 序列帧）；`appLocalDataDir/pets/` 目录 + Rust `list_pets` / `import_pet_dir` / `delete_pet` + `assetProtocol.scope` 加 `$APPLOCALDATA/pets/**` + 设置页选宠物
- [ ] P2 · live2d 适配器：`npm i easy-live2d pixi.js`（dynamic import，不占首屏）+ Cubism Core 放 `public/Core/` 并在 `index.html` 引入；`setState/setParams` 映射到 `startMotion` / `setExpression` / `setParameterValueById`
- [ ] P3 · 模型授权确认 + 正式形象选型（扁平/简约风）

## 待办

### 第 0 步 · 修复 src-tauri 契约（前置，约半天）

- [x] `Cargo.toml`：补 `tauri-plugin-sql` / `dialog` / `fs` / `opener` 依赖
- [x] `lib.rs`：注册插件 + 迁移（students / photos / profile）+ 恢复 `photos_dir` / `import_photo` / `delete_photo_file` 命令
- [x] `capabilities/default.json`：补 `sql:allow-execute`、`sql:allow-load`、`sql:allow-select`、`dialog:default` 等权限
- [x] `npm test` 转绿（`tauri-capability.test.ts`）
- [x] 清理 `db.ts` / `StudentsView.vue` / `profile.ts` 里的 TEMP-DEBUG `dbg()` 代码

### 第 1 步 · AI 原型（1~2 天）

- [ ] `src/lib/ai.ts`：TS 层直连云端 API（fetch + SSE）
- [ ] 新增 AIAssistant 视图（对话式 UI，风格沿用设计系统）
- [ ] 首个场景：自然语言查学生，逐步替换 StudentsView 的 LIKE 搜索框

### 第 2 步 · Agent 框架落地（2026-09 完成）

实际落地与原计划有两处偏差（决策详见 [AGENT.md](AGENT.md)）：

1. genai 只做协议转换（工具定义透传 + tool_calls 返回），**tool-calling 循环放 TS 侧**
   —— 工具执行体（vue-router 跳转、db 查询、文档检索）都在前端，循环贴近工具零 IPC 成本，
   且 vitest 用 mock provider 可全链路测试。
2. 数据层不在 Rust 重包一遍，工具直接复用 `src/lib/db.ts`（浏览器演示态走内存数据）。

- [x] `Cargo.toml`：`genai`（tokio 随 tauri 已有）
- [x] `src-tauri/src/ai.rs`：tool-calling 协议转换（消息协议 + 工具定义透传 + tool_calls 返回）
- [x] `src/agent/`：循环 + 工具注册表 + system prompt（TS 侧）
- [x] 首期三工具：`navigate`（页面跳转）/ `query_data`（数据查询）/ `find_docs`（文档检索）
- [x] 全局聊天浮层 `AgentChat`（App.vue 挂载，替换原首页 HomeChatBox）
- [x] 浏览器演示态规则 mock，不联网走通全链路
### 以后再说

- [ ] Ollama 本地模型（完全离线模式）

### 第 3 步 · Rig + rmcp 双轨落地（2026-09-04 起，方案见 [AGENT_FRAMEWORK_EVALUATION.md](AGENT_FRAMEWORK_EVALUATION.md)）

- [x] P0 能力容器（借鉴 Spring 组件管理）：`define.ts` 工厂 + `container.ts` 容器 + `manifest.ts` 扫描装载；tools 自动扫描 + 页面动作注册表 + `ui_action` 首批动作；写操作 confirm 确认门（2026-09-04）
- [x] P1 `ai.rs`：genai → rig-core 0.42 迁移（`ai_chat` 消息协议不变换底座），`Cargo.toml` 精确锁版本 `=0.42.0`（2026-09-04）
- [x] P1.5 Rust 能力注册：`capabilities.rs`（inventory 散装注册 + `agent_capabilities` 上报 TS 容器 + `log_inventory` 对账），photos 三命令首批注册（2026-09-04）
- [x] P2 流式输出：`ai_chat_stream`（rig 0.42 `CompletionModel::stream` + `tauri::ipc::Channel` 推 `delta` 事件），TS 侧 loop → useAgent 流式渲染；「Tool Server」以**逐请求透传工具清单**实现（循环在 TS，每轮携带容器当前工具表，天然动态；Rust 侧常驻注册表无必要）（2026-09-04）
- [x] P3 rmcp 3.2 应用内 MCP server（stdio 子命令 `aprilio mcp serve`）：只读工具面（photos_dir / list_students / get_stats / list_photos / semantic_search，脱敏投影不含联系方式住址）；与 inventory 对账防遗漏；**写操作待脱敏开关 + 审批双前置**（2026-09-04）
- [x] P4 RAG：Ollama embedding（`/api/embed`，默认 bge-m3）+ SQLite 向量存储（BLOB + 暴力余弦，**LanceDB 调整为数据量上来后的升级位**，理由：依赖全家桶 +25MB 违反 10MB 约束）；`rag_reindex` / `semantic_search` 经 inventory 注册自动进入 TS 容器与 MCP（2026-09-04）

## 花名册与 Excel 支持

- [x] 花名册导入 MVP：指定格式 + 智能导入（姓名列识别，规则 + AI 双轨）+ Agent 工具/页面动作（2026-09-05，见 [ROSTER_IMPORT.md](ROSTER_IMPORT.md)）
- [x] Excel（.xlsx）解析选型评估：**calamine 0.36.1 采纳**（实测二进制 +483KB / +2.1%；初评的前端 fflate 自研方案因真实世界长尾健壮性不足否决）；npm 版 SheetJS / exceljs / read-excel-file 否决（2026-09-05，实测数据见 [EXCEL_PARSING_EVALUATION.md](EXCEL_PARSING_EVALUATION.md)）
- [x] Excel 导入实施：`roster_read_table`（calamine 解码 + 日期序列转换）+ `rosterTableFromGrid` 管道接线 + xlsx 夹具测试（Rust 5 例 + TS grid 入口）（2026-09-05）