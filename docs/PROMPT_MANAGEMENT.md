# 系统提示词管理

应用内全部 AI 功能的系统提示词**不再写死在调用处**，统一登记为「提示词模块」，
在「提示词管理」页按分组逐模块查看、调整、恢复默认。本文是这套机制的规则与扩展说明。

## 背景与目标

改造前，10 处系统提示词以 `const SYSTEM_PROMPT = "..."` 散落在各业务文件里，
调整措辞要改代码、重新发版，教师侧无法针对自己的班级情况微调。

目标：

1. **集中管理**：全部系统提示词登记为模块，一个页面统一查看与编辑
2. **按模块组织**：分组 → 模块两级，未来模块变多仍然可浏览（不是一长串平铺列表）
3. **放文件即接入**：新增一处 AI 功能 = 新增一个 `*.prompt.ts` 文件，不改注册表、不改页面
4. **零覆盖行为不变**：没有任何自定义时，发给模型的内容与改造前**逐字一致**

## 非目标（明确不做）

- 不做提示词市场 / 导入导出 / 云端同步：提示词只存本机
- 不做变更历史与回滚（只有「恢复默认」）
- 不做 A/B 测试与效果评测
- 不接管**消息内容**（user 消息里的学生数据、成绩摘要等仍由业务代码拼装）——
  本机制只管理系统提示词（`system` 字段）
- 不接管工具的参数 Schema：Agent 工具清单仍由能力容器动态生成

## 架构

沿用仓库既有的「声明式工厂 + glob 扫描装载」惯例（同 `agent/tools/`、`classroom/activities/`）：

```
src/prompts/
├── types.ts     PromptModule / PromptVariable 契约
├── define.ts    definePromptModule() 工厂：字段校验 + 归一（对齐 defineAgentTool）
├── groups.ts    分组taxonomy（分组是少量稳定的分类，新增分组在此登记一行）
├── registry.ts  import.meta.glob 扫描 modules/*.prompt.ts → 索引 + 重复 id fail-fast
├── store.ts     localStorage 覆盖值读写（aprilio.prompts.v1）+ promptVersion 响应式
├── resolve.ts   resolvePrompt(id, vars)：取「覆盖值 ?? 默认值」→ 替换占位符
└── modules/     放文件即接入（本目录 12 个模块见下表）
```

装配图：

```
调用方（comment-ai / report-ai / …）
      │  resolvePrompt("content.term-comment", { 评语字数上限: 120 })
      ▼
resolve.ts ──► store.ts（本机覆盖值）
      │            └─ 无覆盖 → 回落
      ▼
registry.ts ──► modules/*.prompt.ts 的 defaultText（内置默认，唯一事实源）
      ▼
最终 system 字符串 → llm.chat({ system })
```

**为什么默认值仍在代码里**：默认文案是随代码演进的「出厂设置」，
必须能随需求一起 review、测试与发版；本机覆盖值只存**差异**。
这样升级版本时新增/修订的默认文案会自动生效（未被自定义过的模块）。

## 模块清单

| 分组 | 模块 id | 界面名 | 占位符（契约） |
| --- | --- | --- | --- |
| 智能助手 | `assistant.agent` | 智能助手主提示词 | `{当前页面}` `{页面概况}` `{补充设定}`（运行期注入） |
| 内容生成 | `content.term-comment` | 学期评语 | `{评语字数上限}`（可编辑，默认 120） |
| 内容生成 | `content.parent-summary` | 家校沟通总结 | `{总结字数上限}`（可编辑，默认 150） |
| 内容生成 | `content.eval-report` | 评价报告 | — |
| 内容生成 | `content.lesson-digest` | 课堂小结 | — |
| 内容生成 | `content.behavior-comment` | 推荐评语 | `{每条字数上限}`=25（契约） |
| 内容生成 | `content.memo-title` | 备忘快速标题 | `{标题字数上限}`=12（契约） |
| 内容生成 | `content.text-polish` | 通用文本润色 | — |
| 信息识别 | `recognize.roster-name-column` | 花名册姓名列识别 | `{输出结构}`（契约） |
| 信息识别 | `recognize.roster-class-name` | 花名册班级推断 | `{输出结构}`（契约） |
| 信息识别 | `recognize.score-sheet` | 成绩单结构识别 | `{输出结构}`（契约） |
| 信息识别 | `recognize.guardian-tag` | 监护人标签倾向 | — |

> 智能助手主提示词只开放**静态段**（身份 + 页面上下文注入位 + 工具使用准则 + 回答风格）；
> 页面上下文的具体内容是运行期状态，仍由 `buildSystemPrompt` 注入到占位符里。

### 通用润色：一个模块服务所有输入点

`content.text-polish` 由可复用的「AI 润色」入口消费（`src/lib/polish-ai.ts` +
`src/components/ui/AiPolishButton.vue`）：按钮挂在各处人工文本输入旁，一键把手输文字
交给模型润色。**场景千差万别，提示词只有一个**——使用场景（`scene`）、场景说明
（`hint`）、业务上下文（`context`）与原文都由挂载点在**用户消息**里给出（对齐
推荐评语「倾向由程序在用户消息里给出」的既有分工），系统提示词只定通用准则：
忠实原意、贴合场景、篇幅格式与原文一致、只输出润色后的文字。

因此**新增人工输入 / 语音输入不需要新增提示词模块**：挂一个按钮、说清楚
`scene` 即可；想整体调整润色口吻，到「提示词管理」页改这一个模块即可全局生效。

### 「写作建议」与「硬上限」是两个概念

学期评语模块上有一处**刻意的不一致**，不是笔误：

- 提示词里的「不超过 120 字」是**写作建议**（变量 `{评语字数上限}`，可编辑）
- `TERM_COMMENT_MAX_LEN`（200）是 `parseTermComment` 的**硬截断上限**

建议值比硬上限短，是为模型留余量。若把两者绑成一个常量，
「调整写作建议」就会连带改变程序截断行为。因此只把硬上限写进模块的 `note` 提示用户，
变量本身保持可编辑。

## 占位符规则

正文里 `{名称}` 是占位符，由代码在调用时替换：

| 规则 | 行为 |
| --- | --- |
| 命中变量 | 替换为传入值 |
| **值为空串** | 该值所在**整行**一并删除（避免留下「补充设定（用户自定义）：」这样的空壳） |
| 未声明的占位符 | 原样保留（用户拼错时看得见，不静默吞掉）；界面提示「未知变量」 |
| 变量值里的花括号 | 不做二次替换（单遍替换，JSON 契约值因此安全） |
| 连续空行 | 折叠为最多一个空行；首尾空白裁掉 |

**契约变量**（`fixedValue`）指由程序固定注入、正文必须保留的占位符——
例如 `{输出结构}` 是解析器期待的 JSON 结构、`{字数上限}` 与代码里的截断长度同源。
界面对契约变量只读展示；用户若从正文里删掉它，保存前会给出警告（不阻断，尊重用户选择）。

**可编辑默认值**（`defaultValue`）是给用户的起点（如写作字数建议），
调用方仍可按场景覆盖；`resolvePrompt` 在调用方没传时用兜底，保证出厂文案稳定。

契约变量的注入**由 `resolvePrompt` 内部完成**，调用方不必也不该重复传：
让每个调用点各自传值，迟早会漂移。调用方传入的同名值优先（便于测试与特例）。

### 叶子契约模块（避免循环依赖）

`src/prompts/contracts.ts` 是**不 import 任何东西**的叶子模块，放双方共享的常量
（字数上限、JSON 输出结构）。原因：提示词模块要读这些常量，业务文件又要读提示词——
互相 import 会形成循环，而 `import.meta.glob(eager)` 会在业务模块初始化前就把各
`*.prompt.ts` 拉起来，读到处于 TDZ 的 `const` 会直接报
`Cannot access before initialization`。业务侧用
`export { X } from "../prompts/contracts"` 保持原有公开 API 不变。

## 存储与兼容

- 键：`aprilio.prompts.v1`，形如 `{ version: 1, overrides: { [模块 id]: { text, updated_at } } }`
- 只存**差异**：正文等于默认值时删除该条覆盖（`text` 清空同样视为恢复默认）
- 损坏 / 非法结构读入时回落空集，等同「全部默认」，不影响任何 AI 功能
- 已下线模块的覆盖值保留在存储里不清理（该模块回归时自定义随之回归）
- **无破坏性变更**：新增本机存储键，不改数据库、不改既有存储格式；
  历史版本没有该键 = 全部走默认，行为与改造前一致

## 界面（提示词管理页）

侧栏「提示词管理」（`/prompts`）→ 顶部双轨导航 + 下方左右分栏（方案 A · 顶部轨道）：

- 页头：已自定义统计 + 全部恢复默认
- 分组 Tab 带（能量线选中态）：全部 / 各分组（附模块数）；右侧为模块搜索与当前分组说明
- 模块胶囊轨道：横向滚动应对模块增多，选中胶囊高亮，「已自定义」模块带 AI 色标识
- 左编辑卡：模块名 + id + 已自定义状态、注意事项、正文编辑、未保存提示、保存（轻反馈 toast）
- 右信息卡：「可用变量 / 预览」分段切换；变量点一下插入到光标处，契约变量只读展示
- 恢复默认：单模块 / 全部（破坏性确认弹层）
- 预览：按当前正文与变量实际值渲染出的最终 system 文本

与设置页「模型方案 → 系统提示词」的关系：那里的字段是**附加在 Agent 主提示词末尾的
全局补充设定**（对应 `assistant.agent` 的 `{补充设定}` 占位符），
本页则是按模块精调系统提示词本身，两者互补、互不覆盖。

## 新增一个提示词模块

1. 在 `src/prompts/modules/` 新建 `<name>.prompt.ts`，`default export definePromptModule({...})`：
   `id`（`分组.名称` 形式）/ `group`（取自 `groups.ts`）/ `label` / `description` /
   `defaultText` / `variables?` / `note?`
2. 调用处把硬编码文案换成 `resolvePrompt("<id>", { 变量名: 值 })`
3. 完事。`import.meta.glob` 自动装载，**不改注册表、不改管理页、不改任何清单文件**

未在 `groups.ts` 登记过的 `group` 不会让模块丢失：会归入「其他」分组渲染（fail-safe）。
补一条 vitest（框架用例 `tests/prompts-lib.test.ts` + 接线用例 `tests/prompt-wiring.test.ts`）。

## 新增一个 AI 特性（调用约定）

生成类 AI 特性**不要手写**「loadAiConfig → 就绪判断 → 建 LLM → chat → parse → catch 回落」
骨架，统一走 `src/lib/ai-run.ts`：

- 生成类（带兜底回落）：`runAiTask({ promptId, messages, parse, llm?, aiReady? })`，
  失败一律返回 `null`，由调用方回落；`parse` 只做输出清洗与校验
- 管道类（调用方自管就绪判断，如导入识别）：`chatOnce({ system, messages, llm?, config })`
- 模型输出里的 JSON 一律用 `extractJsonObject` 提取；列表/引号清洗用
  `stripListDecoration` / `stripQuoteWrap`
- 需要向用户如实报错的主动动作（如 AI 润色）不用 `runAiTask`（它把错误吞成 null），
  参考 `polish-ai.ts` 的自管变体

分层红线：`src/lib` 与 `src/classroom` **不得 import `src/agent`**（含 type-only）。
LLM 消息契约与桌面端传输在 `src/lib/llm.ts`；agent 侧的 `AgentLlm` 等类型是从那里
转发导出的，agent 内部代码照旧从 `agent/types` 引用即可。

## 验收清单

- [x] 框架：扫描装载 / 重复 id 报错 / 未知分组兜底 / 分组排序稳定
- [x] 取值：无覆盖走默认；有覆盖走覆盖；空正文=恢复默认；损坏存储回落空集
- [x] 占位符：替换、空值消行、未知占位符保留、契约变量缺失警告、预览渲染
- [x] 接线：10 处调用点全部走 `resolvePrompt`，且**无覆盖时与原硬编码逐字一致**
- [x] 接线：写入覆盖值后，各处发给模型的 system 随之改变
- [x] 界面：模块切换 / 保存 / 单模块恢复默认 / 全部恢复默认 / 变量插入 / 未保存提示
- [x] 入口：侧栏 + 路由 + Agent `navigate` 可达（`prompts`）
- [x] 门禁：`npm run typecheck`、`npm test` 全绿
