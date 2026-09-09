# 学期化班级与学生管理（设计稿）

> 状态：**已实现（2026-09-09）**。已落地：班级 `entry_grade`/`entry_semester`/`archived_at` + 实时推导（`src/lib/semester.ts`）、`student_term_comments` 学期评语表、班级归档与「历史带过的班」只读详情、学生详情按学期过滤成绩/表现、AI 学期评语草稿（`src/lib/comment-ai.ts`，无 AI 手写）、AI 年级学期识别（`src/lib/semester-ai.ts`，规则优先 + 模型兜底，导入收尾补写班级元信息）、升级提醒、`query_data` 新增 `classes`/`term_comments`、`analyze` 新增 `semester_overview`/`student_term_report` 学期汇总分析器、归档/恢复页面动作（确认门）与 Evals 用例。本文回答：① 班级如何带上「初始年级」并随时间自动升级；② 学生与成绩 / 表现 / 评语如何按学期组织；③ 班级归档与「历史带过的班」怎么落；④ 四类 AI 能力如何「有 AI 更好、没 AI 照常手工」。
>
> 相关文档：[CLASS_MANAGEMENT_DESIGN.md](CLASS_MANAGEMENT_DESIGN.md)（班级框架原始设计）、[TIMETABLE.md](TIMETABLE.md)（学期号 `currentSemester` 已有口径）、[SCORE_IMPORT.md](SCORE_IMPORT.md)（成绩按考试批次）、[AI_DEVELOPMENT_SOP.md](AI_DEVELOPMENT_SOP.md)（spec 先行与验证门禁）。

## 1. 背景与目标

现状：`classes` 只是 `name` 文本；学生的 `grade_class` 也是自由文本。班级没有「年级」概念，成绩（`exams.exam_date`）、表现（`student_behavior_records.recorded_date`）都没有学期归属，评语只有行为流水里的短评语、没有「学期评语」。

要做的四件事：

| # | 目标 | 一句话验收 |
| --- | --- | --- |
| G1 | 班级带「初始年级 + 起始学期」，随当前时间实时推导「现在几年级 / 上还是下」 | 2025 年建的三年级班，2026 年打开显示四年级上学期，数据仍挂在同一个班 |
| G2 | 学生档案唯一，成绩 / 表现 / 学期评语都按学期打标，可跨学期回看 | 同一学生可查「三年级上」「四年级上」的完整轨迹，不复制档案 |
| G3 | 班级归档：移入「历史带过的班」，只读可查、可恢复，不再出现在班级管理 | 归档后班级卡片消失、进入历史班列表，数据全在 |
| G4 | AI 优先、无 AI 可手工：识别年级学期、生成学期评语、学期末汇总、升级提醒 | 不配置任何模型时，所有录入 / 归档 / 评语 / 升级均可手动完成 |

## 2. 非目标

- 不做教务排课 / 跨教师学生转班：单人本地工具，归档即「我不再带这个班」，学生不跨教师迁移
- 不做自动升级写入：升级是**实时推导**，不批量改库、不复制班级记录
- 不做学段（初中 / 高中）完整模型：年级先支持小学 1~6，`grade` 存整数，学段后置
- 不改现有班级 / 成绩 / 课表的 `class_name` 文本关联口径（见决策 D1）

## 3. 核心决策记录

> **D1 班级身份 = 稳定文本 key + 实时推导展示**（2026-09-09 确认）。
> `classes.name` 仍是创建时确定的稳定内部标识，**不因升级自动改名**；「当前年级 / 当前学期」由 `entry_grade` + `entry_semester` 结合 `currentSemester()` 实时算出，只用于展示与分组。好处：`students.grade_class`、`exams.class_name`、`timetables.class_name`、`calendar_events.class_name` 全部沿用，零关联重构；同一班级的课表在换学期时本就是 `(class_name, semester)` 新行，天然契合。

> **D2 学期 / 年级是纯函数推导，不批量落库**（2026-09-09）。学期号沿用 `lib/timetable.ts` 的 `currentSemester()`；成绩按 `exam_date`、表现按 `recorded_date` 实时推导学期；只有「学期评语」需要独立落库（每生每学期一条）。避免升级时全库改数据带来的不一致。

> **D3 归档 = 软状态，只读可恢复**（2026-09-09 确认）。`classes.archived_at` 有值即归档：从班级管理隐藏、进入「历史带过的班」、默认只读、可一键恢复。数据（学生 / 成绩 / 表现 / 照片 / 评语 / 课表）全部保留，与现有「删除进回收站」是两条不同的路（删除会移出主表，归档不会）。

> **D4 学生档案唯一 + 数据按学期打标**（2026-09-09 确认）。学生只有一条 `students` 记录；升级时学生 `grade_class` 不变（跟着稳定班级自动升年级），学期维度体现在成绩 / 表现 / 评语各自的日期或 `semester` 字段上。

> **D5 学期评语新增独立实体**（2026-09-09 确认）。`student_term_comments`：一个学生在一个学期一条期末评语，支持 AI 生成草稿 + 手工编辑，历史学期可查；与现有「行为评语沉淀」（`behavior_comment_presets`）并存，二者用途不同（前者是学期总结，后者是日常记录用词）。

> **D6 AI 一律「增强层」，手工路径永远可用**（2026-09-09）。所有 AI 能力遵循现有降级范式（`lib/memo-ai.ts` / `lib/behavior-ai.ts`）：未配置模型 / 浏览器演示态 / 调用失败 → 静默回退规则或空，录入与展示永不阻塞。

## 4. 数据模型

### 4.1 改动 `classes`（迁移 + ensureSchema 幂等补列）

```
classes
  name            TEXT PRIMARY KEY      -- 稳定内部标识，创建后不自动变（D1）
  entry_grade     INTEGER               -- 初始年级 1~6（小学）；NULL = 未登记（回退旧行为）
  entry_semester  TEXT                  -- 起始学期，如 2025-2026-1；NULL = 未登记
  archived_at     TEXT                  -- NULL=在用；有值=已归档（D3）
  created_at      TEXT
```

- `entry_grade` / `entry_semester` 允许为空：老库与未登记班级保持现状（卡片不显示升级徽标）
- `archived_at` 允许为空：默认在用
- 不加 `id` 主键：见 D1，文本关联口径不动

### 4.2 新增 `student_term_comments`

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
| 成绩 | `exams.exam_date` → `currentSemester()` | 现有考试批次已带考试时间，零迁移 |
| 表现 | `student_behavior_records.recorded_date` → `currentSemester()` | 零迁移 |
| 照片 | `photos.taken_at`（可空）→ 推导 | 仅用于「按学期浏览」的展示分组，不强制 |

> 若后续数据量上来查询变慢，再评估给 `exams` / `student_behavior_records` 加冗余 `semester` 列（导入 / 录入时落库），本期不做（D2）。

### 4.4 迁移与对账

- `src-tauri/src/lib.rs`：新增迁移 v7（幂等 `ALTER TABLE classes ADD COLUMN ...`、`CREATE TABLE IF NOT EXISTS student_term_comments`）
- `src/lib/db.ts`：`SCHEMA_DDL` 同步建表 + `ensureSchema` 幂等补 `classes` 三列
- `tests/schema-sync.test.ts` 自动对账两侧表集合（新增表会被覆盖）

## 5. 学期 / 年级推导（纯函数，`src/lib/semester.ts`）

与 `lib/timetable.ts` 分离，方便 vitest 直测；`currentSemester()` / `semesterLabel()` 从 `timetable.ts` 复用或迁移为共享函数（迁移时保持 timetable 导出兼容）。

```ts
/** 学期在线性轴上的序号：2025-2026-1 → 4050，2025-2026-2 → 4051，2026-2027-1 → 4052 */
export function semesterIndex(semester: string): number;

/** 当前年级 = 初始年级 + 已过学年数；跨秋季自动 +1 */
export function gradeAt(
  entryGrade: number,
  entrySemester: string,
  at: string | Date = new Date()
): number;

/** 该时刻所属学期在学年内的阶段：1=秋季（上）| 2=春季（下） */
export function semesterTerm(at: string | Date = new Date()): 1 | 2;

/** 班级当前展示：如「四年级 · 上学期」；未登记年级返回 null */
export function classCurrentLabel(
  entryGrade: number | null,
  entrySemester: string | null,
  at?: string | Date
): string | null;
```

推导公式：

```
N      = semesterIndex(当前学期) - semesterIndex(起始学期)
年级增量 = floor(N / 2)          // 秋→春不升级，春→下一秋升级
当前年级 = entry_grade + 年级增量
```

边界：`N < 0`（起始学期在未来）时钳制为 0 并返回告警标记，界面提示「起始学期晚于当前」。

## 6. 功能设计

### 6.1 新建 / 编辑班级（`ClassFormDialog.vue`）

新增两个字段（都可留空）：

| 字段 | 控件 | 无 AI 时 | 有 AI 时 |
| --- | --- | --- | --- |
| 初始年级 | 下拉 1~6（一年级…六年级） | 手选 | 输入班级名后自动预选（见 §7.1） |
| 起始学期 | 文本 / 下拉，默认 `currentSemester()` | 默认当前学期，可改 | 同上 |

- 班级名仍走现有重名校验；年级 / 学期是元信息，不影响 `name` 稳定标识
- 编辑已存在班级时也允许补登 / 修正（老库班级首次打开提示补登）

### 6.2 班级管理页（`ClassesView.vue`）

- 班级卡片新增：`当前：四年级 · 上学期`（`classCurrentLabel`），未登记则显示「登记年级」轻提示
- 卡片右上角新增「归档」操作（与改名 / 删除并列，hover 显现）
- 页顶新增分段筛选：**在用班级 / 历史带过的班**
- 归档确认对话框：说明「归档后从班级管理移出，进入历史带过的班，数据只读可恢复」

### 6.3 历史带过的班

- 列表按 `archived_at` 倒序，卡片显示「归档于 YYYY-MM-DD」+ 当前年级徽标
- 点击可进入班级详情**只读态**：隐藏导入 / 新增 / 编辑 / 删除入口，成绩 / 表现 / 照片 / 评语 / 课表只读展示
- 「恢复」按钮：置 `archived_at = NULL`，回到在用班级
- 只读是 UI 层控制（路由参数或 `archived` 判定）；数据库层不锁（单人工具，避免过度设计）

### 6.4 学生详情：按学期组织

- 顶部新增学期切换（下拉，默认当前学期，可回看历史学期）
- 「成绩」Tab：现有面板按选中学期过滤（用 `exam_date` 推导）
- 「表现」Tab：时间轴按选中学期过滤（用 `recorded_date` 推导）
- 新增「学期评语」区块：当前学期一条可编辑评语 + 历史学期列表；见 §6.5
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

### 6.7 升级 / 归档提醒

- 进入班级管理或首页时，若检测到「起始学期已跨越 ≥1 个学期」的班级，展示一条轻提示：
  「新的学期开始了：三年级二班现在是四年级上学期。若不再带该班可归档。」
- 仅提醒，不自动改任何数据（D2）
- 用户可关闭 / 忽略，本次会话不再提示（localStorage 记录上次提醒的学期）

## 7. AI 能力（全部有手工兜底）

> 统一降级范式：`isAiConfigured(loadAiConfig())` 为假 → 直接走规则 / 返回空；调用异常 → 静默回退，不阻塞录入。日志只记计数，不落学生姓名 / 评语原文。

### 7.1 智能识别年级与学期

| 路径 | 无 AI | 有 AI |
| --- | --- | --- |
| 输入班级名「三年级二班」 | 正则匹配中文数字 → `entry_grade=3`；`entry_semester` 默认当前 | 同规则优先，规则失败再交给模型从任意描述里推断 |
| 花名册 / 成绩单导入 | 从文件名 / 标题行提取年级（复用 `roster.ts` 的标题嗅探） | 同上，模型兜底模糊命名 |

- 规则永远先跑；AI 只在规则置信度低时补充，且**必须经合法性校验**（年级 1~6、学期格式），防幻觉
- 落点：`src/lib/semester-ai.ts`（新建，与 `memo-ai.ts` 同构）

### 7.2 AI 生成学期评语草稿

- 输入：该生本学期的成绩概要（`score-analysis` 的 `score_student` 口径）+ 表现流水摘要 + 维度倾向分布
- 输出：一段 60~120 字中文期末评语草稿，教师可改
- 无 AI：输入框手写；未配置时按钮置灰 + 提示
- 落点：`src/lib/comment-ai.ts`

### 7.3 学期末智能汇总建议

- 输入：本学期成绩趋势 + 表现记录
- 输出：进步 / 退步点、亮点、需关注点，供教师写评语参考
- 无 AI：显示纯统计摘要（均值 / 趋势 / 表现分布，来自 `score-analysis.ts` 与 `comment-ai.ts` 的 `buildScoreSummary` / `buildBehaviorSummary`），不生成文字建议
- 已实现形态：学期评语面板内的「成绩参考 / 表现参考」纯统计摘要（始终可用）+ AI 草稿生成时作为上下文

### 7.4 自动升级确认提醒

- 进入班级管理时由纯函数 `upgradedClasses` 算出「哪些在用班已升年级」，横幅提示新年级与「不再带可归档」
- 无 AI：只显示规则结论（班级 + 新年级），点「知道了」本次会话不再提示
- 不做自动执行、不做 AI 文案（保持确定性，避免无谓调用）

### 7.5 Agent 工具与 Evals

| 能力 | 类型 | 说明 |
| --- | --- | --- |
| `query_data` 实体扩展 | 只读 | 新增 `classes`（在用 / 历史、当前年级）、`term_comments`（按学生 / 学期） |
| `analyze` 分析器扩展 | 只读 | `semester_overview`（某班某学期成绩汇总）、`student_term_report`（某生某学期成绩 + 表现轨迹），落点 `src/agent/analysis/providers/semester-analysis.ts` |
| 页面动作 | 写 | 「归档班级」「恢复班级」经 `ui_action` 确认门 |
| 学期评语生成 | 写 | Agent 可生成草稿，采纳落库需确认门 |

按 [AI_DEVELOPMENT_SOP.md](AI_DEVELOPMENT_SOP.md) §6，Agent 行为变更同步补 `tests/evals/dataset.ts` 用例。

## 8. 任务拆解（按依赖顺序）

| 步 | 内容 | 落点 |
| --- | --- | --- |
| 1 | 纯函数 + 单测：`semesterIndex` / `gradeAt` / `classCurrentLabel` / `semesterOfDate` | `src/lib/semester.ts`、`tests/semester-lib.test.ts` |
| 2 | 数据层：`classes` 三列 + `student_term_comments` 建表 / 迁移 / ensureSchema / 双态读写 | `src-tauri/src/lib.rs`、`src/lib/db.ts`、`src/types/index.ts`、`tests/semester-db.test.ts` |
| 3 | 班级表单与卡片：初始年级 / 学期录入、当前年级徽标、归档按钮与筛选 | `ClassFormDialog.vue`、`ClassesView.vue`、`tests/classes-view.test.ts` |
| 4 | 历史带过的班：列表 + 只读详情 + 恢复 | `ClassesView.vue`、`ClassDetailView.vue`、路由 / 只读判定 |
| 5 | 学生按学期：学期切换 + 成绩 / 表现过滤 | `StudentDetailView.vue`、`StudentScorePanel.vue`、`StudentBehaviorTimeline.vue` |
| 6 | 学期评语：表读写 + 编辑区 + 历史列表 | `db.ts`、`StudentDetailView.vue`、`components/TermCommentPanel.vue` |
| 7 | AI 四能力 + 降级 + 单测 | `lib/semester-ai.ts`、`lib/comment-ai.ts`、`tests/*-ai.test.ts` |
| 8 | 升级提醒 + Agent 工具 / 分析器 + Evals | `ClassesView.vue`、`src/agent/tools/*`、`tests/evals/dataset.ts` |
| 9 | 文档：本文验收清单回填、README / AGENTS.md 索引 | `README.md`、`AGENTS.md` |

## 9. 验收清单

- [x] 新建班级填「三年级 + 2025-2026-1」→ 当前时间下显示实时推导的年级（数据未复制、班级 `name` 未变）
- [x] 未登记年级的老班级照常显示，可补登；起始学期晚于当前时钳制为初始年级
- [x] 归档班级 → 从班级管理消失、进入「历史带过的班」、详情只读、可恢复
- [x] 归档后成绩 / 表现 / 照片 / 评语 / 课表全部保留；恢复后编辑入口回来
- [x] 学生档案唯一，成绩 / 表现可按学期切换查看，统计口径与现有 `score-analysis.ts` 一致
- [x] 学期评语每生每学期一条，重复保存覆盖不新增；删除学生 / 班级连带删除
- [x] 未配置 AI：年级学期可手填、评语可手写、汇总显示纯统计、升级提醒只给规则结论
- [x] 配置 AI：评语可生成草稿（`comment-ai.ts`）；调用失败自动回退不报错
- [x] `query_data` 可查班级（在用 / 历史 / 当前年级）与学期评语
- [x] 归档 / 恢复经 Agent 写操作确认门拦截（Evals 用例覆盖）
- [x] `npm run typecheck`、`npm test`、`cargo check --manifest-path src-tauri/Cargo.toml` 全绿；`schema-sync` 对账通过
- [x] 花名册 / 成绩单导入时识别年级学期（规则优先 + 已配置模型时 AI 兜底），导入收尾补写班级元信息
- [x] `analyze` 学期汇总分析器（`semester_overview` / `student_term_report`）

## 10. 待确认 / 后置

1. **班级展示名是否跟随年级自动变**？当前设计是「内部 `name` 不变、只显示当前年级徽标」（D1）。若希望卡片主标题直接显示「四年级二班」，需要从 `name` 拆出「班号」再拼接，改动面更大——建议先用徽标，后续按反馈再定。
2. **`entry_grade` 的语义**：是「建档时年级」还是「入学年级」？本设计取「建档时年级」，`entry_semester` 与之配对。若老师希望按入学年份算，需要改字段语义（数据模型不变，仅文案与算法）。
3. **学段扩展**：`grade` 整数 1~6 为小学；初中 / 高中需要学段字段与 3+1+2 等，本期不做。
4. **跨教师学生转班**：本设计不做；若未来要支持，需引入学生-班级历史关系表（`student_class_history`），与本期「档案唯一 + 班级稳定」并存。
5. **冗余 `semester` 列**：数据量增大后再评估（D2）。
