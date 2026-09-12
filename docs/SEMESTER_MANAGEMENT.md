# 学期化班级与学生管理（设计稿）

> 状态：**已实现（2026-09-09）；2026-09-12 修订：移除班级「初始年级 / 起始学期」**。已落地：班级 `archived_at` + 归档与「历史带过的班」只读详情（`src/lib/db.ts` 双态读写）、`student_term_comments` 学期评语表 + AI 学期评语草稿（`src/lib/comment-ai.ts`，无 AI 手写）、学生详情按学期过滤成绩/表现（`src/lib/semester.ts` 纯函数）、`query_data` 新增 `classes`/`term_comments`、`analyze` 新增 `semester_overview`/`student_term_report` 学期汇总分析器、归档/恢复页面动作（确认门）与 Evals 用例。本文回答：① 学生与成绩 / 表现 / 评语如何按学期组织；② 班级归档与「历史带过的班」怎么落；③ AI 能力如何「有 AI 更好、没 AI 照常手工」。
>
> **修订说明**：初版曾让班级登记「初始年级 + 起始学期」并随时间实时推导「现在几年级 / 上还是下」，再做新学期升级提醒。实测该设定只服务两个纯展示功能，不承载任何数据组织能力；而成绩 / 表现 / 评语 / 课表本就按各自的日期或学期字段独立归属学期，「有内容的学期自动关联学生信息」已完整成立。维护「初始年级」还要付出表单录入、导入时 AI 识别补写、老库迁移与双态存储的复杂度，且录错会长期显示错误信息、对归档班无意义（老师关心的是带它时的年级，不是「现在会是几年级」），故**已整体移除**：代码不再读写这两列；老库残留列空置无害，不做破坏性 DROP。
>
> 相关文档：[CLASS_MANAGEMENT_DESIGN.md](CLASS_MANAGEMENT_DESIGN.md)（班级框架原始设计）、[TIMETABLE.md](TIMETABLE.md)（学期号 `currentSemester` 口径）、[SCORE_IMPORT.md](SCORE_IMPORT.md)（成绩按考试批次）、[AI_DEVELOPMENT_SOP.md](AI_DEVELOPMENT_SOP.md)（spec 先行与验证门禁）。

## 1. 背景与目标

现状：`classes` 只是一个班级名列表；学生的 `grade_class` 也是自由文本。成绩（`exams.exam_date`）、表现（`student_behavior_records.recorded_date`）没有学期归属，评语只有行为流水里的短评语、没有「学期评语」。

要做的三件事：

| # | 目标 | 一句话验收 |
| --- | --- | --- |
| G1 | 学生档案唯一，成绩 / 表现 / 学期评语都按学期打标，可跨学期回看 | 同一学生可查「2025-2026-2」「2026-2027-1」的完整轨迹，不复制档案 |
| G2 | 班级归档：移入「历史带过的班」，只读可查、可恢复，不再出现在班级管理 | 归档后班级卡片消失、进入历史班列表，数据全在 |
| G3 | AI 优先、无 AI 可手工：生成学期评语、学期末汇总 | 不配置任何模型时，所有录入 / 归档 / 评语 / 汇总均可手动完成 |

## 2. 非目标

- 不做教务排课 / 跨教师学生转班：单人本地工具，归档即「我不再带这个班」，学生不跨教师迁移
- 不做班级年级模型：不登记年级、不推导「现在几年级」、不做升级提醒（见修订说明）
- 不改现有班级 / 成绩 / 课表的 `class_name` 文本关联口径（见决策 D1）
- 不批量落库学期归属：成绩 / 表现按日期实时推导，见决策 D2

## 3. 核心决策记录

> **D1 班级身份 = 稳定文本 key**（2026-09-09 确认）。
> `classes.name` 是创建时确定的稳定内部标识，**不随时间自动变化**；`students.grade_class`、`exams.class_name`、`timetables.class_name`、`calendar_events.class_name` 全部沿用，零关联重构；同一班级的课表在换学期时本就是 `(class_name, semester)` 新行，天然契合。

> **D2 学期归属是纯函数推导，不批量落库**（2026-09-09）。学期号沿用 `lib/timetable.ts` 的 `currentSemester()`；成绩按 `exam_date`、表现按 `recorded_date`、作业按 `homework_date` 实时推导学期；只有「学期评语」需要独立落库（每生每学期一条）。避免升级时全库改数据带来的不一致。

> **D3 归档 = 软状态，只读可恢复**（2026-09-09 确认）。`classes.archived_at` 有值即归档：从班级管理隐藏、进入「历史带过的班」、默认只读、可一键恢复。数据（学生 / 成绩 / 表现 / 照片 / 评语 / 课表）全部保留，与现有「删除进回收站」是两条不同的路（删除会移出主表，归档不会）。

> **D4 学生档案唯一 + 数据按学期打标**（2026-09-09 确认）。学生只有一条 `students` 记录；学期维度体现在成绩 / 表现 / 评语各自的日期或 `semester` 字段上。

> **D5 学期评语新增独立实体**（2026-09-09 确认）。`student_term_comments`：一个学生在一个学期一条期末评语，支持 AI 生成草稿 + 手工编辑，历史学期可查；与现有「行为评语沉淀」（`behavior_comment_presets`）并存，二者用途不同（前者是学期总结，后者是日常记录用词）。

> **D6 AI 一律「增强层」，手工路径永远可用**（2026-09-09）。所有 AI 能力遵循现有降级范式（`lib/memo-ai.ts` / `lib/behavior-ai.ts`）：未配置模型 / 浏览器演示态 / 调用失败 → 静默回退规则或空，录入与展示永不阻塞。

> **D7 不登记班级年级 / 学期元信息**（2026-09-12 修订确认）。年级与学期是时间维度的派生概念，不属于班级本身；数据组织一律由「数据自带的日期 / 学期字段」承担。删除初版的 `entry_grade` / `entry_semester` 两列及相关 UI、AI 识别、升级提醒。

## 4. 数据模型

### 4.1 `classes`

```
classes
  name        TEXT PRIMARY KEY   -- 稳定内部标识，创建后不自动变（D1）
  archived_at TEXT               -- NULL=在用；有值=已归档（D3）
  created_at  TEXT
```

- `archived_at` 允许为空：默认在用
- 不加 `id` 主键：见 D1，文本关联口径不动
- 老库若残留 `entry_grade` / `entry_semester` 列（初版引入），空置无害，代码不再读写，不做破坏性 DROP

### 4.2 `student_term_comments`

```
student_term_comments
  id          INTEGER PRIMARY KEY AUTOINCREMENT
  student_id  INTEGER NOT NULL
  semester    TEXT NOT NULL            -- YYYY-YYYY-1/2，口径同 currentSemester()
  content     TEXT NOT NULL DEFAULT ''
  source      TEXT NOT NULL DEFAULT 'manual'   -- manual 手工 | ai 采纳 AI 草稿
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  UNIQUE (student_id, semester)
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
```

- 每生每学期一条，upsert 幂等
- 删除学生 / 删除班级连带删除
- 快照：`StudentSnapshot` 增加 `termComments`，回收站恢复时一并还原（与现有 behaviors 同规格）

### 4.3 不新增、靠推导的部分

| 数据 | 学期来源 | 说明 |
| --- | --- | --- |
| 成绩 | `exams.exam_date` → `semesterOfDate()` | 现有考试批次已带考试时间，零迁移 |
| 表现 | `student_behavior_records.recorded_date` → `semesterOfDate()` | 零迁移 |
| 作业 | `student_homework_records.homework_date` → `semesterOfDate()` | 零迁移 |
| 照片 | `photos.taken_at`（可空）→ 推导 | 仅用于「按学期浏览」的展示分组，不强制 |

> 若后续数据量上来查询变慢，再评估给 `exams` / `student_behavior_records` 加冗余 `semester` 列（导入 / 录入时落库），本期不做（D2）。

### 4.4 迁移与对账

- `src-tauri/src/lib.rs`：建表基线只含 `name` / `archived_at` / `created_at`（新库一步到位）
- `src/lib/db.ts`：`SCHEMA_DDL` 同步建表 + `ensureSchema` 幂等补 `archived_at` 列（老库）
- `tests/schema-sync.test.ts` 自动对账两侧表集合

## 5. 学期推导（纯函数，`src/lib/semester.ts`）

与 `lib/timetable.ts` 分离，方便 vitest 直测；`currentSemester()` / `semesterLabel()` 从 `timetable.ts` 复用。

```ts
/** 学期号在线性轴上的序号：2025-2026-1 → 4050，2025-2026-2 → 4051，2026-2027-1 → 4052 */
export function semesterIndex(semester: string): number;

/** 某日期归属的学期号（成绩 / 表现 / 作业按日期实时推导学期用） */
export function semesterOfDate(date: string | Date): string;

/** 最近 N 个学期的候选列表（当前学期在前，向过去回溯），供学期下拉选择 */
export function recentSemesters(count = 8, at?: string | Date): string[];
```

## 6. 功能设计

### 6.1 新建 / 编辑班级（`ClassFormDialog.vue`）

- 表单只有一个「班级名称」字段；班级名走现有重名校验
- 改名 = 只改 `name` 这个稳定标识，关联数据（学生 / 成绩 / 表现 / 照片 / 课表 / 日程）随之迁移；归档状态一并搬过去

### 6.1.1 添加 / 编辑学生：班级栏「可选可输」（`StudentFormDialog.vue`）

- 班级栏 = 可输入框 + 下拉候选：聚焦即列出**在用班级**（排除虚拟「未分班」与已归档班级），输入片段做包含过滤，点选即关联，避免手打错字扩散出重复班级
- 手动输入不存在的班级名时，栏下方提示「将新建班级「xxx」」；保存学生时由 `db.ts` 的 `ensureClassForStudent` 自动建档（`INSERT OR IGNORE INTO classes`）
- 建档落在 `createStudent` / `updateStudent` 内，班级留空的「未分班」不建档；花名册导入、Agent 建学生等入口同样生效

### 6.2 班级管理页（`ClassesView.vue`）

- 班级卡片：班级名、学生数（男 / 女）、照片统计
- 卡片右上角「归档」操作（与改名 / 删除并列，hover 显现）
- 页顶分段筛选：**在用班级 / 历史带过的班**
- 归档确认对话框：说明「归档后从班级管理移出，进入历史带过的班，数据只读可恢复」

### 6.3 历史带过的班

- 列表按 `archived_at` 倒序，卡片显示「归档于 YYYY-MM-DD」
- 点击可进入班级详情**只读态**：隐藏导入 / 新增 / 编辑 / 删除入口，成绩 / 表现 / 照片 / 评语只读展示
- 「恢复」按钮：置 `archived_at = NULL`，回到在用班级
- 只读是 UI 层控制（路由参数或 `archived` 判定）；数据库层不锁（单人工具，避免过度设计）

### 6.4 学生详情：按学期组织

- 顶部学期切换（下拉，默认当前学期，可回看历史学期）；可选学期 = 当前学期 + 最近若干学期兜底 + 该生成绩 / 表现出现过的学期（按日期推导，倒序）
- 「成绩」Tab：现有面板按选中学期过滤（用 `exam_date` 推导）
- 「表现」Tab：时间轴按选中学期过滤（用 `recorded_date` 推导）
- 「作业」Tab / 「评价报告」Tab：同样按选中学期过滤
- 「学期评语」区块：当前学期一条可编辑评语 + 历史学期列表；见 §6.5
- 学生档案本身不因学期复制（D4）

### 6.5 学期评语

- 每生每学期一条，`student_term_comments` upsert
- 编辑区：文本框 + 「AI 生成草稿」（有 AI 时）+ 保存
- AI 草稿生成失败 / 未配置 → 输入框照常可手写，按钮禁用并提示「未配置 AI，可手动填写」
- 采纳 AI 草稿后 `source='ai'`，手工修改保存后 `source='manual'`（可选：展示来源标签）
- 删除学生 / 删除班级连带删除

### 6.6 成绩 / 表现的学期过滤口径

- 纯函数 `semesterOfDate(dateStr)`（= `currentSemester(new Date(dateStr))`）统一口径
- 班级详情与学生的成绩 / 表现面板复用 `score-analysis.ts` 现有统计，只是在取数后按学期筛选，统计口径不变

## 7. AI 能力（全部有手工兜底）

> 统一降级范式：`isAiConfigured(loadAiConfig())` 为假 → 直接走规则 / 返回空；调用异常 → 静默回退，不阻塞录入。日志只记计数，不落学生姓名 / 评语原文。

### 7.1 AI 生成学期评语草稿

- 输入：该生本学期的成绩概要（`score-analysis` 的 `score_student` 口径）+ 表现流水摘要 + 维度倾向分布
- 输出：一段 60~120 字中文期末评语草稿，教师可改
- 无 AI：输入框手写；未配置时按钮置灰 + 提示
- 落点：`src/lib/comment-ai.ts`

### 7.2 学期末智能汇总建议

- 输入：本学期成绩趋势 + 表现记录
- 输出：进步 / 退步点、亮点、需关注点，供教师写评语参考
- 无 AI：显示纯统计摘要（均值 / 趋势 / 表现分布，来自 `score-analysis.ts` 与 `comment-ai.ts` 的 `buildScoreSummary` / `buildBehaviorSummary`），不生成文字建议
- 已实现形态：学期评语面板内的「成绩参考 / 表现参考」纯统计摘要（始终可用）+ AI 草稿生成时作为上下文

### 7.3 Agent 工具与 Evals

| 能力 | 类型 | 说明 |
| --- | --- | --- |
| `query_data` 实体扩展 | 只读 | 新增 `classes`（在用 / 历史）、`term_comments`（按学生 / 学期） |
| `analyze` 分析器扩展 | 只读 | `semester_overview`（某班某学期成绩汇总）、`student_term_report`（某生某学期成绩 + 表现轨迹），落点 `src/agent/analysis/providers/semester-analysis.ts` |
| 页面动作 | 写 | 「归档班级」「恢复班级」经 `ui_action` 确认门 |
| 学期评语生成 | 写 | Agent 可生成草稿，采纳落库需确认门 |

按 [AI_DEVELOPMENT_SOP.md](AI_DEVELOPMENT_SOP.md) §6，Agent 行为变更同步补 `tests/evals/dataset.ts` 用例。

## 8. 任务拆解（按依赖顺序）

| 步 | 内容 | 落点 |
| --- | --- | --- |
| 1 | 纯函数 + 单测：`semesterIndex` / `semesterOfDate` / `recentSemesters` | `src/lib/semester.ts`、`tests/semester-lib.test.ts` |
| 2 | 数据层：`classes`.`archived_at` + `student_term_comments` 建表 / 迁移 / ensureSchema / 双态读写 | `src-tauri/src/lib.rs`、`src/lib/db.ts`、`src/types/index.ts`、`tests/semester-db.test.ts` |
| 3 | 班级表单与卡片：班级名录入、归档按钮与筛选 | `ClassFormDialog.vue`、`ClassesView.vue`、`tests/class-semester-view.test.ts` |
| 4 | 历史带过的班：列表 + 只读详情 + 恢复 | `ClassesView.vue`、`ClassDetailView.vue`、路由 / 只读判定 |
| 5 | 学生按学期：学期切换 + 成绩 / 表现过滤 | `StudentDetailView.vue`、`StudentScorePanel.vue`、`StudentBehaviorTimeline.vue` |
| 6 | 学期评语：表读写 + 编辑区 + 历史列表 | `db.ts`、`StudentDetailView.vue`、`components/TermCommentPanel.vue` |
| 7 | AI 评语 + 降级 + 单测 | `lib/comment-ai.ts`、`tests/*-ai.test.ts` |
| 8 | Agent 工具 / 分析器 + Evals | `src/agent/tools/*`、`tests/evals/dataset.ts` |
| 9 | 文档：本文验收清单回填、README / AGENTS.md 索引 | `README.md`、`AGENTS.md` |
| 10 | 2026-09-12 修订：移除 `entry_grade` / `entry_semester` 及升级提醒、AI 识别补写 | `db.ts`、`lib.rs`、`ClassFormDialog.vue`、`ClassesView.vue`、`ClassDetailView.vue`、删除 `lib/semester-ai.ts` |

## 9. 验收清单

- [x] 新建 / 改名班级只维护班级名；改名后学生 / 成绩 / 照片 / 课表关联随之迁移，归档状态保留
- [x] 添加 / 编辑学生：班级栏可点选已有班级，也可手动输入新班级名（保存时自动建档，班级管理页可见）
- [x] 归档班级 → 从班级管理消失、进入「历史带过的班」、详情只读、可恢复
- [x] 归档后成绩 / 表现 / 照片 / 评语 / 课表全部保留；恢复后编辑入口回来
- [x] 学生档案唯一，成绩 / 表现可按学期切换查看，统计口径与现有 `score-analysis.ts` 一致
- [x] 学期评语每生每学期一条，重复保存覆盖不新增；删除学生 / 班级连带删除
- [x] 未配置 AI：评语可手写、汇总显示纯统计
- [x] 配置 AI：评语可生成草稿（`comment-ai.ts`）；调用失败自动回退不报错
- [x] `query_data` 可查班级（在用 / 历史）与学期评语
- [x] 归档 / 恢复经 Agent 写操作确认门拦截（Evals 用例覆盖）
- [x] `npm run typecheck`、`npm test`、`cargo check --manifest-path src-tauri/Cargo.toml` 全绿；`schema-sync` 对账通过
- [x] 班级不再登记年级 / 学期，界面不出现年级徽标与升级提醒；导入流程不做年级学期识别补写

## 10. 待确认 / 后置

1. **班级展示名**：`name` 是稳定标识（D1），不随时间自动变化；班级名里带不带年级由老师自己决定。
2. **学段扩展**：若未来需要按学段统计（小学 / 初中 / 高中），再评估独立字段，本期不做。
3. **跨教师学生转班**：本设计不做；若未来要支持，需引入学生-班级历史关系表（`student_class_history`），与本期「档案唯一 + 班级稳定」并存。
4. **冗余 `semester` 列**：数据量增大后再评估（D2）。
