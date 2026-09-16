# 课堂模式后端与活动框架设计规范（会话 × 活动 × 事件）

> 文档状态：设计完成，待评审
> 日期：2026-09-17
> 前置：交互原型已验证（`prototypes/classroom/classroom-mode.html`，冒烟 39/39，见 `prototypes/classroom/smoke.mjs`）
> 目标：为课堂模式设计正式版后端支撑。核心抽象是**「节课 = 会话容器 × 可组合活动 × 统一事件流」**——活动可按科目自由组合，新活动不改表结构、不改核心框架，放一个文件即接入（对齐 Agent 工具 `import.meta.glob` 自动扫描的既有先例）。

---

## 1. 背景

原型验证了四个体验：智能点名、座位大屏、小组积分、下课小结。本 spec 把它落成正式架构，回答原型页脚"落库说明"中悬置的三件事：

1. 点名历史、小组积分、缺勤这些"课堂特有"数据落在哪
2. 表扬/待改进如何**实时**进入既有档案体系（时间轴、评价报告、Agent 立即可见，而非下课才结算）
3. 一节课由不同活动组成（数学课可能有口算竞赛、语文课可能有听写），科目差异如何建模、未想好的功能如何留口子

## 2. 目标与非目标

### 目标

1. 数据模型：**v9 迁移**新增 4 张表（`lesson_sessions` / `lesson_events` / `seatings` / `classroom_activity_sets`），Rust 侧仅改 `lib.rs` 的 `migrations()`
2. 活动框架：`src/classroom/` 模块，活动 = `LessonActivityDef`（事件归约 + UI），注册表自动扫描装配
3. 结算规则：**双写透传**——课堂记表现实时落 `student_behavior_records`（既有消费者零改动），事件流负责回放/撤销/小结
4. 崩溃恢复：会话中断重开后，活动状态由事件流重放重建
5. Agent：`query_data` 新增 `lessons` 实体 + 导航/页面动作注册 + Evals 用例

### 非目标（明确不做）

- 考勤管理系统（缺勤仅课中标记，事件可撤销，不进成绩/评语/学期档案）
- 小组**跨课长期积分**（本 spec 只做课内聚合 + 下课快照；跨课累积等真实需求出现再议）
- 多设备同步、家长端投屏、课堂媒体工具（拍照投屏、噪声计）
- 课堂内写操作的 Agent 工具（P0 只读 + 开/下课动作；写工具待脱敏开关与确认门策略复用后再开）
- `TimetableGrid` / `TimetableCalendar` 死代码复用决策（座位编辑器可参考其网格实现，另立议题）

## 3. 核心抽象

### 3.1 一图看全

```
                 ┌──────────────── ClassroomView（全屏沉浸路由 /classroom）────────────────┐
                 │  启动页（课表节次感知）→ 课堂舞台（活动 Tab 按组合渲染）→ 下课小结        │
                 └──────────────────────────────┬─────────────────────────────────────────┘
                                                │ provide(LESSON_CTX)
                 ┌──────────────────────────── 框架层 ───────────────────────────────────┐
                 │ LessonContext（容器）  registry（活动扫描装配）  emit/revoke + 事件广播   │
                 │        活动状态 = f(事件流)   ← 全量重放（撤销/恢复/重开都在这条路上）      │
                 └──────────────────────────────┬─────────────────────────────────────────┘
                                                │ 纯函数编排（SQL 收口在 db.ts）
                 ┌──────────────────────────── 领域层 ───────────────────────────────────┐
                 │ lesson_sessions（节课）  lesson_events（统一事件流）                     │
                 │ seatings（学期域座位）   classroom_activity_sets（活动组合配置）          │
                 └──────────────────────────────┬─────────────────────────────────────────┘
                                                │ 双写透传（同事务）
                 ┌──────────────────────────── 复用层（零改动）─────────────────────────┐
                 │ student_behavior_records + behavior_dimensions（表现流水/维度字典）      │
                 │ timetables/slots/exceptions + buildMyDays（节次感知）  behavior-ai      │
                 │ 还债组件（AppDialog/ConfirmHost/useToast/AppIcon）                      │
                 └─────────────────────────────────────────────────────────────────────┘
```

### 3.2 三条设计原则

| 原则 | 含义 | 得到什么 |
| --- | --- | --- |
| **事件流是课堂会话的唯一事实源** | 活动不各自建状态表；一切课堂行为先变成事件，活动状态 = `reduce(事件流)` | 撤销 = 标记 revoked 后重放；崩溃恢复 = 重放；下课小结 = 聚合；新活动只写 reduce 就能消费全量历史 |
| **档案型数据双写透传** | 表扬/待改进事件**同事务**写 `student_behavior_records` + `lesson_events`（背引用 `settled_record_id`） | 班级时间轴、学生档案、评价报告、Agent 查询**实时**可见，所有既有消费者零改动 |
| **开闭原则的两道门** | 组合开放：`activity_set_json` 决定一节课有哪些活动；扩展开放：活动放文件即注册，事件 `kind` 是开放字符串 | 未想好的功能（口算/听写/随机分组/倒计时全屏/桌宠主持）零表结构变更接入 |

### 3.3 结算规则（命令 vs 事件）

| 活动 | 命令落库（实时，档案域） | 课堂事件（回放/归约域） | 撤销语义 |
| --- | --- | --- | --- |
| 点名 picker | — | `pick` | revoke → 回到未点池，天数统计随之恢复 |
| 记表现（点名/座位入口） | `student_behavior_records`（即档案） | `behavior`（带 `settled_record_id`） | revoke → **联动删除档案记录**，事务保证一致 |
| 小组积分 group-race | —（下课快照固化进 `stats_json`） | `group_point` | revoke → 重算组分 |
| 缺勤（座位活动内） | — | `attendance` | revoke → 回到在班名单与点名池 |
| 座位调整 | `seatings` upsert（幂等命令，课堂内外均可执行） | `seat_change`（可选，仅摘要用） | 命令幂等，无需撤销 |

**不落独立分值表**：小组分数永远是 `group_point` 事件的聚合值；下课把快照写进 `lesson_sessions.stats_json`，避免"事件流说 5 分、分值表说 4 分"这类双源漂移。

## 4. 数据模型与迁移（v9）

命名说明：`lesson_*` 前缀 = 节课作用域（一次上课一条）；`seatings` 无前缀（学期域状态，与 `timetables` 同类）；`classroom_activity_sets` 带前缀（课堂域配置，避免歧义）。

### 4.1 lesson_sessions（节课会话）

```sql
CREATE TABLE IF NOT EXISTS lesson_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',     -- 科目自由文本（项目惯例：不做字典表）
  lesson_date TEXT NOT NULL,           -- YYYY-MM-DD；学期由 semesterOfDate() 推导，不落库
  period INTEGER,                       -- 课表节次；NULL = 临时课堂（课表外手动开课）
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'live',  -- live | ended
  activity_set_json TEXT NOT NULL DEFAULT '[]',  -- 本次课实际生效的活动组合快照
  stats_json TEXT,                      -- 下课统计快照（点名/表扬/待改进/小组分…）
  digest_md TEXT,                       -- 课堂小结（AI 或数据版）
  digest_source TEXT,                   -- ai | data
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_sessions_slot
  ON lesson_sessions(class_name, lesson_date, period);
CREATE INDEX IF NOT EXISTS idx_lesson_sessions_live ON lesson_sessions(status) WHERE status = 'live';
```

- UNIQUE 槽位：同一班同一天同一节只允许一个会话（重开 = 恢复，不新建）。`period` 为 NULL 时 SQLite 视 NULL 互不相等 → **临时课堂同日可开多次**（早读、自习），这是有意行为。
- `activity_set_json` 存**快照**：即使后续改了默认组合，历史会话重放仍用当时组合。

### 4.2 lesson_events（统一事件流）

```sql
CREATE TABLE IF NOT EXISTS lesson_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES lesson_sessions(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,  -- 可空（小组事件无主体）
  activity TEXT NOT NULL,               -- 发出活动的 type，如 'picker'
  kind TEXT NOT NULL,                   -- 开放字符串：pick | behavior | group_point | attendance | …
  payload TEXT NOT NULL DEFAULT '{}',  -- JSON，随 kind 自由扩展
  settled_record_id INTEGER,           -- 双写背引用 student_behavior_records.id；不加 FK（避免级联环）
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT                       -- 非空 = 已撤销，重放与聚合一律跳过
);
CREATE INDEX IF NOT EXISTS idx_lesson_events_session ON lesson_events(session_id);
CREATE INDEX IF NOT EXISTS idx_lesson_events_student_pick
  ON lesson_events(student_id, kind, occurred_at) WHERE revoked_at IS NULL;
```

- `student_id` 提升为独立列（而非埋在 payload）：跨会话"距上次被点 N 天"要按学生索引查询。
- **未知 kind 必须安全忽略**——归约器遇到不认识的 kind 原样跳过（对齐 Agent"未知工具不崩溃"红线），这是新活动零冲突接入的前提。
- 撤销 = `revoked_at` 置时间戳 +（若 `settled_record_id` 非空）同事务删档案记录。一节课事件量级 ≤ 数百，**撤销后全量重放重建状态**，不做增量撤销。

### 4.3 seatings（座位表，学期域）

```sql
CREATE TABLE IF NOT EXISTS seatings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_name TEXT NOT NULL,
  semester TEXT NOT NULL,               -- 写入时 semesterOfDate() 推导（timetables 同款约定）
  row_no INTEGER NOT NULL,
  col_no INTEGER NOT NULL,
  group_no INTEGER NOT NULL DEFAULT 0,  -- 组号显式列，不由 col 推导（支持团团坐等任意分组）
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seatings_slot ON seatings(class_name, semester, row_no, col_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seatings_student ON seatings(class_name, semester, student_id);
```

- **一人一座**约束（同班同学期学生唯一）：转班/毕业生删除时 CASCADE，与照片、表现同策略。
- **回退推导**：班级无座位记录时，按学号序生成默认网格（组号 = 列号），内存推导不落库——课堂模式 P0 无需先维护座位也能上课。
- 组名/图标 P0 不建表：显示"第 N 组"；教师自定义组名（火箭组/星星组…）列入 P1，届时加 `classroom_group_labels` 轻表。

### 4.4 classroom_activity_sets（活动组合配置）

```sql
CREATE TABLE IF NOT EXISTS classroom_activity_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                   -- 如「数学课」「语文课」「通用」
  subject TEXT NOT NULL DEFAULT '',     -- '' = 通用默认集
  activities_json TEXT NOT NULL,       -- 有序：[{"type":"picker"},{"type":"seating","config":{...}}]
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

- **P0 代码内置默认集** `[picker, seating, group-race, digest]`：表建好但仅在教师自定义时写入；解析顺序 = 科目专属集 → 通用集 → 代码默认。组合管理 UI 是 P1，本表先行是为"不同科目不同组合"不撞表结构。
- 会话打开时把解析结果快照进 `activity_set_json`，下课前改组合不影响本次课。

### 4.5 迁移落点与对账（全按既有惯例）

| 步骤 | 位置 |
| --- | --- |
| v9 Migration | `src-tauri/src/lib.rs` `migrations()`（版本号只增不复用；Cargo 依赖不动） |
| 前端 DDL 同步 | `src/lib/db.ts` `SCHEMA_DDL` + `ensureSchema()` try-ALTER 幂等兜底 |
| 自动对账 | `tests/schema-sync.test.ts`（现有机制覆盖 v9，无需新文件） |
| 演示态 | `db.ts` 内存 store 增加 lesson/seating 集合，双态 API 行为一致 |

## 5. 活动框架

### 5.1 LessonActivityDef（活动定义，接入面唯一接口）

```ts
// src/classroom/types.ts
export interface LessonActivityDef<S = unknown> {
  type: string;                          // 唯一键：'picker' | 'seating' | 'group-race' | 'digest' | 自由扩展
  title: string;
  icon: string;

  /** 能力声明：Context 启动时按此装配（容器思想，对齐 agent 容器/manifest 先例） */
  requires: Array<'students' | 'seating' | 'dimensions' | 'events'>;

  /** 结算声明：'behavior' = 本活动产生档案级记录（emit 时走双写通道） */
  settle: 'behavior' | 'session';

  /**
   * 事件归约：活动状态 = f(事件流)。纯函数——撤销、恢复、重开全部靠重放它。
   * 只处理自己认识的 kind，未知 kind 必须原样跳过（红线）。
   */
  reduce(state: S | null, ev: LessonEvent, ctx: LessonReadContext): S;

  /** 数据缺失降级文案；null = 无需降级。例：seating 无座位时返回回退提示而非报错 */
  fallback?: (ctx: LessonReadContext) => string | null;

  /** UI 组件；框架 provide(LESSON_CTX)，组件内 inject 拿 Context */
  component: Component;
}
```

- `bootstrap` 不是接口的一部分：`bootstrap(events) = events.reduce(reduce, null)` 由框架统一实现——**新活动最少只需写 `reduce` + UI**。
- `config`：`activities_json` 每项可带 `{type, config}`，config 透传给组件（如 group-race 的组数、picker 的权重模式默认值），框架不解释其内容。

### 5.2 LessonContext（容器与运行时）

```ts
// src/classroom/context.ts
export interface LessonContext {
  session: LessonSession;
  students: ClassroomStudent[];         // 在班名单（已应用 attendance 事件）
  seating: SeatingGrid;                 // 座位网格（无表时回退推导）
  groups: ClassroomGroup[];             // 组号（+P1 名称）
  dimensions: BehaviorDimension[];     // 复用表现维度字典

  /** 统一事件入口：settle='behavior' 的活动发 behavior 事件时自动同事务双写 */
  emit(ev: LessonEventInput): Promise<LessonEvent>;
  /** 撤销：behavior 事件联动删档案，随后广播重放 */
  revoke(eventId: number): Promise<void>;
  /** 活动间联动：座位表扬 → group-race 计分跳动、digest 计数，都靠这个总线 */
  onEvent(cb: (ev: LessonEvent) => void): () => void;

  ui: { toast; confirm };               // 复用还债组件（useToast / confirmAction）
}
```

- emit 的双写通道是 Context 的职责而非活动的：活动只声明 `settle`，不关心事务——框架层一次实现，所有活动受益（含未来活动）。
- 事件先 insert、后广播；各活动收到后各自 reduce 自增量。**广播失败不回滚事件**（事件已是事实），活动状态下次重放自愈。

### 5.3 注册表（放文件即接入）

```ts
// src/classroom/registry.ts
const modules = import.meta.glob<LessonActivityDef>("./activities/*.activity.ts", { eager: true });
// 与 src/agent/manifest.ts 扫描 tools/page-actions 完全同构：
// 构建期已知、启动期注册、能力清单可枚举（为 Agent 描述与调试面板服务）
```

- 唯一性校验：重复 `type` 启动即报错（fail-fast，对齐容器启动对账惯例）。
- `activity_set_json` 引用未注册的 type（教师配置了未安装的活动）→ 该项**跳过 + toast 提示**，不阻断开课（对齐未知工具安全兜底哲学）。

## 6. 会话生命周期

```
detect ──open──▶ live ──end──▶ ended
  │               │
  │  无课表匹配    │ 崩溃/退出 → 启动恢复横幅（重放事件重建）
  └─▶ 手动选班 ────┘
```

| 环节 | 行为 |
| --- | --- |
| detect 节次感知 | 复用 `buildMyDays`/`resolveDaySlots`（首页课表面板同款投影）：按当前时间命中"今天第 N 节 → 班级/科目/起止"；无命中 → 手动选班（period NULL） |
| open | 唯一槽位已 live → **恢复而非新建**；解析活动组合 → 快照进 `activity_set_json` → 装配 Context |
| live | 全部写入走 `lesson_events`；计时器 = `started_at + 节次起止` 实时推导，**不持久化** |
| 崩溃恢复 | 启动时查 `status='live'` 会话（可能多个，多班连堂未下课）：横幅逐个列出，恢复一个重放一个；其余提示"有未下课的课堂" |
| end（下课） | confirmAction 确认门 → 全量聚合事件写 `stats_json` → digest 生成（`digest-ai`，失败回退数据版）→ `status='ended', ended_at, digest_md, digest_source` → toast + 返回来源页 |
| 事后修正 | 已结束会话的档案修正走既有表现时间轴删除/编辑；事件流 append-only 不追改历史 |

## 7. P0 活动与事件契约

| 活动 | emits | reduce 产出 |
| --- | --- | --- |
| `picker` | `pick {mode, weight}` | 已点名单、覆盖率、点名池（attendance 已过滤） |
| `seating` | `behavior {dimension_id, type, via}`、`attendance {absent}`、（可选 `seat_change`） | 网格渲染态、缺勤名单、本周表扬角标（读表现流水） |
| `group-race` | `group_point {group_no, delta, reason}` | 各组分数、领先组 |
| `digest` | —（只读活动） | 覆盖/表扬/待改进统计、沉默预警名单、时间线 |

payload 字段遵循最小充分：`behavior` 事件 payload 存 `{dimension_id, type, via}`，评语正文在档案记录里（事件不复制长文本，防双源漂移；`settled_record_id` 反查）。

**沉默权重的读模型**（picker 启动时装配）：`daysSincePicked(studentId)` = 跨会话查询最后一条未撤销 `pick` 事件（走 `idx_lesson_events_student_pick`）；"本周发言 N 次" = 表现流水按维度+时间窗聚合。两者都是纯函数读模型，vitest 可测。

## 8. 模块结构

```
src/classroom/
  types.ts            LessonSession / LessonEvent / SeatingGrid / LessonActivityDef / LessonContext
  registry.ts         import.meta.glob 扫描 activities/*.activity.ts，唯一性校验
  context.ts          Context 装配（requires 注入）、emit/revoke、事件广播、恢复重放
  session.ts          detect（课表命中/手动）/ open / end / 恢复查询
  seating.ts          座位 CRUD 编排 + 无表回退推导 + 换座 upsert
  activity-sets.ts    组合解析（科目集 → 通用集 → 代码默认）+ 快照
  digest.ts           数据版小结：stats 聚合、沉默预警（纯函数）
  digest-ai.ts        AI 增强（report-ai 同款降级范式：未配置/演示态/失败 → 数据版，永不阻塞）
  activities/
    picker.activity.ts / seating.activity.ts / group-race.activity.ts / digest.activity.ts
src/views/ClassroomView.vue            全屏沉浸路由（fullBleed 同款机制），启动页 + 舞台
src/components/classroom/*             活动组件（picker/seating/group-race/digest UI）
src/lib/db.ts                          新增 lesson/seating 集合 SQL（双态一致，SCHEMA_DDL 同步）
src/router/index.ts                    /classroom 路由
```

- 路由与导航：`NAV_TARGETS` 注册 `classroom`；入口 = 首页课表面板"上课了"按钮 + 课表页 + Agent。
- 页面动作：`src/agent/page-actions/` 新增 `classroom.ts`（`classroom/start`、`classroom/end-lesson`，写操作带 confirm 确认门）。
- Rust 零新命令：全部走 tauri-plugin-sql；仅 `lib.rs` 迁移改动。

## 9. Agent 集成

| 项 | 改动 |
| --- | --- |
| `query_data` | `tools/query.ts` 新增 `lessons` 实体（第 11 个）：按班级/日期查询会话 + 事件摘要（点名名单、表扬次数、小组分）；mock provider 同步规则 |
| `prompt.ts` | 工具描述补一句 lessons 实体用法 |
| Evals | `tests/evals/dataset.ts` 加用例（只加数据）："今天三(2)班数学课点了谁" → `query_data{entity:'lessons'}`；"开始上课" → `ui_action classroom/start`（确认门拦截断言）；"下课" → `ui_action classroom/end-lesson`（先拒后 confirm） |
| 写工具 | P0 不开（非目标）；`manage_students`/`import_*` 确认门先例原样沿用 |

## 10. 留给未来的口子（本 spec 的核心承诺）

**扩展点一：新活动 = 一个文件**。以"口算倒计时"为例的接入成本：

```ts
// src/classroom/activities/countdown.activity.ts —— 放文件即完成接入
export const countdownActivity: LessonActivityDef<CountdownState> = {
  type: "countdown",
  title: "口算倒计时", icon: "⏱",
  requires: ["students"],            // 不需要座位/维度，Context 自动瘦身装配
  settle: "session",                 // 不产生档案记录，零双写
  reduce: (s, ev) =>
    ev.kind === "countdown_run" ? { ...s, runs: [...(s?.runs ?? []), ev.payload] } : (s ?? { runs: [] }),
  component: CountdownPanel,         // UI 任意；emit('countdown_run') 的事件自动入流
};
```

不改表、不改 registry、不改 Context、不碰其他活动；Agent 的能力清单自动多出一项。

**扩展点二：kind 与 payload 开放**。新事件先写后约——`kind` 是开放字符串，payload JSON 随活动自定义；老活动/老会话重放遇未知 kind 一律安全跳过。给未来"听写批改""随机分组""桌宠主持点名"预留的是同一根管道。

**扩展点三：组合可配**。`classroom_activity_sets` 表已建，P1 做管理 UI 时（按科目拖拽组合活动、课时常用配置）零迁移。

**扩展点四：requires 能力注入**。未来要接"计时服务""语音播报""桌宠事件桥"（ROADMAP 中 P1~P3 桌宠计划），在 Context 增加能力项 + 活动 `requires` 声明即可，活动代码不感知装配细节（借 Spring 四样的既有容器哲学）。

**扩展点五：digest 素材出口**。`lesson_sessions.digest_md/stats_json` 是结构化快照；评价报告（report-ai）P1 可直接引作"课堂侧素材"，无需回放事件。

## 11. 测试计划（TDD，先写失败测试）

| 文件 | 覆盖 |
| --- | --- |
| `tests/schema-sync.test.ts` | v9 对账（现有机制自动覆盖，补断言 4 表存在） |
| `tests/classroom-session-db.test.ts` | 会话 CRUD、槽位 UNIQUE 幂等（同班同日同节重开=恢复）、临时课堂 NULL 节次可重复、live/ended 状态迁移 |
| `tests/classroom-events-db.test.ts` | 事件 append/revoke、**双写事务性**（档案删除 ⇄ revoked 置位原子）、跨会话 daysSincePicked 索引查询、未知 kind 持久化不报错 |
| `tests/classroom-seating-db.test.ts` | 座位 CRUD、一人一座约束、换座幂等、**无表回退推导**（按学号网格+列组号） |
| `tests/classroom-registry.test.ts` | 扫描装配、重复 type fail-fast、未注册 type 的组合跳过不阻断 |
| `tests/classroom-reducers.test.ts` | 四活动 reduce 纯函数：点名池/覆盖率、组分聚合、缺勤过滤、沉默预警名单、**未知 kind 跳过**、撤销后重放一致 |
| `tests/classroom-context.test.ts` | emit 双写通道（settle 路由）、revoke 联动删档案、广播总线、恢复重放 = 手工操作序列等价 |
| `tests/classroom-digest.test.ts` | stats 聚合、数据版小结模板、digest-ai 失败回退 |
| `tests/agent-query-tool.test.ts` | `lessons` 实体查询与 mock 规则 |
| `tests/evals/` | 第 9 节新用例；黄金集 100% 红线不豁免 |

演示态（内存 store）与 SQLite 双态在以上 db 类测试中**同一套用例跑两遍**（项目既有模式）。

## 12. 任务拆解与排期（约 10.5 个工作日）

| 任务 | 内容 | 天 |
| --- | --- | --- |
| T1 | v9 迁移四表 + db.ts 双态 SQL + schema-sync | 1.5 |
| T2 | types/registry/context：扫描装配、emit/revoke 双写、广播重放 | 2 |
| T3 | session.ts 生命周期（detect/open/end/恢复）+ seating 回退推导 + activity-sets 解析 | 1.5 |
| T4 | 四活动定义 + reduce 纯函数 + 组件（迁移原型 UI，接入还债组件） | 2.5 |
| T5 | digest/digest-ai + Agent 集成（query lessons、NAV、page-actions、Evals） | 1.5 |
| T6 | ClassroomView 全屏路由 + 首页/课表入口接线 + 崩溃恢复横幅 | 1 |
| T7 | 全量回归 + `docs/CLASSROOM.md`（登记 AGENTS.md 索引）+ 缓冲 | 0.5 |

每任务独立过 `npm run typecheck` → `npm test` 门禁；T1 起加 `cargo check`（动了 lib.rs）。

## 13. 验收清单

- [ ] typecheck / test / cargo check 全绿；Evals 黄金集 100%
- [ ] **双写演练**：课堂记表扬 → 班级时间轴与学生档案**立即可见**；撤销该事件 → 档案记录同步消失
- [ ] **恢复演练**：开课中强杀进程重开 → 恢复横幅 → 各活动状态与强杀前一致（重放验证）
- [ ] **回退演练**：新班级无座位表 → 默认网格开课；无课表时段 → 手动开临时课堂同日可多次
- [ ] **组合演练**：activity_set 引用不存在活动 → 跳过+提示，课堂正常
- [ ] 小结：AI 配置时生成 AI 版、未配置时数据版；下课统计与手工点算一致
- [ ] Agent：三句口头禅（"今天数学课点了谁"/"开始上课"/"下课"）走对工具且确认门不绕过
- [ ] `docs/CLASSROOM.md` 已登记 AGENTS.md 索引

## 14. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 双写不一致（事件在、档案丢失） | 同一事务边界（db.ts 单次 execute 事务封装）；演示态同样原子；专项测试用例 |
| 事件流被滥用成"垃圾抽屉"（payload 无 schema） | kind→payload guard 纯函数注册于活动文件内（自校验）；文档维护 kind 契约表；payload 超长截断保护 |
| 全量重放性能 | 一节课事件 ≤ 数百，实测门槛写入测试；超大量课（全校广播场景不存在于单班）再引入增量，接口不变 |
| 多 live 会话（忘下课就开新课） | open 时检测同班已有 live → 强制恢复；恢复横幅列出全部 live 供逐个处理 |
| 学生删除的级联影响 | lesson_events.student_id CASCADE（与表现流水同策略）；学生先入回收站，7 天可恢复 |
| `settled_record_id` 无 FK 的悬挂 | 撤销即删档案；悬挂检测进 events-db 测试（revoked 为空但档案不存在的用例报警） |
| 组号漂移（座位未分组/团团坐） | group_no 显式列；回退网格按列赋组号；跨组号变动只影响当次聚合，不追改历史事件 |
