# 课堂模式（会话 × 活动 × 统一事件流）

> 状态：**P0 已实现（2026-09-17）**。数据层（Rust v9 迁移四表 + `db.ts` 双态 + schema 对账）、框架层（`src/classroom/`）、四个 P0 活动与组件、全屏路由 `/classroom`（`ClassroomView.vue`）、首页与「我的课表」的「上课了」入口、Agent（`query_data` 的 `lessons` 实体 + `NAV_TARGETS.classroom` + 页面动作 `classroom/start` / `classroom/end-lesson`）均已落地。
> 本文回答七个问题：① 一节课怎么建模（会话 × 活动 × 事件流）；② 四张表各管什么、约束在哪；③ 事件 `kind` 的契约与撤销语义；④ 新活动怎么接入；⑤ 会话生命周期与崩溃恢复怎么走；⑥ 课堂表现怎么实时进既有档案；⑦ 哪些是已知边界、哪些口子留给未来。
>
> 决策记录（2026-09-17，编号是本文件局部序号，与 [TIMETABLE.md](TIMETABLE.md) 的 ①~㉘ 不是同一套）：
> 决策① **节课 = 会话 × 活动组合 × 统一事件流**：活动不各自建状态表，一切课堂行为先落 `lesson_events`，活动状态 = `reduce(事件流)`。撤销 = 标记 `revoked_at` 后全量重放；崩溃恢复 = 重放；下课小结 = 聚合。新活动只要写 `reduce` 就能消费全量历史。
> 决策② **档案型数据双写透传**：表扬/待改进事件**同事务**写既有 `student_behavior_records` 与 `lesson_events`（背引用 `settled_record_id`），班级时间轴/学生档案/评价报告/Agent 实时可见，既有消费者零改动；撤销同事务删档案。评语正文只存档案，事件不复制（防双源漂移）。
> 决策③ **不落独立分值表**：小组分数永远是 `group_point` 事件的聚合值，下课把快照写进 `lesson_sessions.stats_json`——避免「事件流说 5 分、分值表说 4 分」。
> 决策④ **开闭原则的两道门**：组合开放（`activity_set_json` 决定一节课有哪些活动）+ 扩展开放（活动放文件即注册、`kind` 是开放字符串）。两道门的代价都由框架兜底：未注册 type 跳过 + toast、未知 `kind` 安全跳过（红线）。
> 决策⑤ **座位表是学期域状态**（`seatings`，与 `timetables` 同类，无 `lesson_` 前缀）：一人一座 + 一格一人，写入是幂等命令（课内外都能改，不撤销）；班级无座位记录时按学号序内存回退推导，**课堂 P0 无需先维护座位也能上课**。
> 决策⑥ **槽位幂等 + 临时课堂**：同班同日同节只允许一个会话，重开 = 恢复（不新建、已结束也不复活）；`period` 为 NULL 的临时课堂同日可开多次（早读/自习），这是有意行为。
> 决策⑦ **组合解析顺序 = 科目专属集 → 通用集（subject 空串）→ 代码默认集**，解析结果在开课时快照进 `activity_set_json`——下课前改配置不影响本次课，历史会话重放永远用当时组合。
> 决策⑧ **考勤只课内标记**：`attendance` 事件可撤销、不进成绩/评语/学期档案；小组**跨课长期积分**不做（本课聚合 + 下课快照）。
> 决策⑨ **小结永不阻塞下课**：AI 优先、数据版兜底，`digest-ai` 未配置/演示态/失败一律回退数据版（永不抛错）。

## 1. 定位与入口

课堂模式是 aprilio 里唯一服务「课中 40 分钟」的**全屏沉浸界面**：一节课 = 会话容器 × 可组合活动 × 统一事件流。四个 P0 活动按科目组合可换：

| 活动 | `type` | 干什么 | 结算 |
| --- | --- | --- | --- |
| 点名台 | `picker` | 随机/加权/手动点名，沉默权重（越久未被点越优先） | `session` |
| 座位表 | `seating` | 座位大屏、座位角标记表扬/待改进、缺勤标记、调座 | **`behavior`** |
| 小组积分赛 | `group-race` | 按组加减分、领先组、撤销刚才一次加分 | `session` |
| 下课小结 | `digest` | 只读：实时统计 + 时间线 + AI/数据版小结预览 | `session` |

| 入口 | 行为 |
| --- | --- |
| 全屏路由 `/classroom` | `App.vue` 的 `fullBleed`（与首页同口径，不显示侧边栏）；`?session=<id>` 直达既有会话（恢复由槽位幂等保证） |
| 首页课表面板「上课了」 | `startDetectedLesson()`：当前节次命中我的课 → 直接开课并带 session 进课堂；无命中 → 只跳启动页手动选班 |
| 「我的课表」页「上课了」 | 与首页同一函数、同一口径（两处各自跳转，开课逻辑不重复实现） |
| Agent 导航 | `NAV_TARGETS` 注册 `key: "classroom"` / `routeName: "classroom"` / `label: "课堂模式"`（只读导航，无确认门） |
| Agent 页面动作 | `classroom/start`（课表命中或传 `class_name` 开临时课堂）、`classroom/end-lesson`（下课结算）；两者 `dangerous: true`，走确认门 |
| 崩溃恢复横幅 | 启动页列出全部 `status='live'` 会话（多班连堂未下课可能多个），逐个「恢复」→ 重放重建 |

启动页（`ClassroomView.vue` 的 `phase === "start"`）三块：**恢复横幅**（`listResumableSessions()`，无 live 会话则不出现）→ **节次感知命中卡**（`detectCurrentLesson()`，命中才出现「开始上课」）→ **手动开课**（班级下拉 + 可选科目 → `period = null` 开临时课堂）。舞台（`phase === "stage"`）是活动 Tab（顺序即会话快照顺序，`ctx.activities`）+ 降级提示条（`activeEntry.def.fallback(ctx)` 的结果，`fallback` 抛错即视为无提示）+ `<component :is="activeEntry.def.component" :state="ctx.activityState(type)" :config="ctx.activityConfig(type)">`（`v-if="activeEntry"`）；头部显示班级·科目、节次徽标、`已上课 M 分 SS 秒`（按 `started_at` 实时推导，**不持久化**）、退出/下课。

## 2. 核心抽象与三条设计原则

```
ClassroomView（启动页 → 课堂舞台 → 下课小结）
        │ provide(LESSON_CTX)（LessonContextProvider 壳，Vue 要求 setup 同步期 provide）
框架层  LessonContext（容器）  registry（活动扫描装配）  emit/revoke + 事件广播
        活动状态 = f(事件流) ← 全量重放（撤销/恢复/重开都走这条路）
领域层  lesson_sessions（节课）  lesson_events（统一事件流）
        seatings（学期域座位）  classroom_activity_sets（活动组合配置）
复用层  student_behavior_records + behavior_dimensions（双写透传，零改动）
        buildMyDays / resolveDaySlots（节次感知）  AppDialog / ConfirmHost / useToast / AppIcon
```

| 原则 | 含义 | 得到什么 |
| --- | --- | --- |
| **事件流是唯一事实源** | 活动不各自建状态表；课堂行为先变成事件，活动状态 = `reduce(事件流)` | 撤销 = 标记 `revoked_at` 后重放；崩溃恢复 = 重放；下课小结 = 聚合；新活动只写 `reduce` 就能消费全量历史 |
| **档案型数据双写透传** | 表扬/待改进事件同事务写 `student_behavior_records` + `lesson_events`（`settled_record_id` 背引用） | 班级时间轴、学生档案、评价报告、Agent **实时**可见，既有消费者零改动 |
| **开闭原则两道门** | 组合开放（`activity_set_json`）+ 扩展开放（`kind` 开放字符串、活动放文件即注册） | 口算/听写/随机分组/倒计时/桌宠主持都能零表结构变更接入 |

命令 vs 事件（哪些落库、哪些进流）：

| 动作 | 命令落库（实时，档案域） | 课堂事件（回放/归约域） | 撤销语义 |
| --- | --- | --- | --- |
| 点名 | — | `pick` | revoke → 回到未点池，覆盖率与沉默读模型恢复 |
| 记表现 | `student_behavior_records`（即档案） | `behavior`（带 `settled_record_id`） | revoke → **联动删档案**（同事务） |
| 小组加减分 | —（下课快照进 `stats_json`） | `group_point` | revoke → 重算组分与领先组 |
| 缺勤 | — | `attendance` | revoke → 回到在班名单与点名池 |
| 调座 | `seatings` upsert（幂等命令，课内外均可） | `seat_change`（可选，仅摘要） | 命令幂等，无需撤销 |

## 3. 数据模型（迁移 v9 四表 + 前端 ensureSchema 兜底）

```sql
-- 节课会话：一次上课一条；活动组合快照 + 下课统计/小结
lesson_sessions  id, class_name, subject, lesson_date, period, started_at, ended_at,
                 status, activity_set_json, stats_json, digest_md, digest_source, created_at
                 UNIQUE(class_name, lesson_date, period)              -- 槽位幂等（period NULL 互不相等 → 临时课堂同日可多次）
                 INDEX(status) WHERE status = 'live'                   -- 崩溃恢复只查 live

-- 统一事件流（append-only）
lesson_events    id, session_id → lesson_sessions(id) ON DELETE CASCADE,
                 student_id → students(id) ON DELETE CASCADE,          -- 可空：小组事件无主体
                 activity, kind, payload, settled_record_id,          -- settled_record_id 无 FK（避免与档案表的级联环）
                 occurred_at, created_at, revoked_at                  -- revoked_at 非空 = 已撤销
                 INDEX(session_id)
                 INDEX(student_id, kind, occurred_at) WHERE revoked_at IS NULL   -- 跨会话沉默查询

-- 学期域座位表：一人一座 + 一格一人
seatings         id, class_name, semester, row_no, col_no, group_no, student_id, created_at
                 UNIQUE(class_name, semester, row_no, col_no)         -- 一格一人
                 UNIQUE(class_name, semester, student_id)             -- 一人一座

-- 课堂活动组合配置：P0 表建好，仅教师自定义时才有数据
classroom_activity_sets  id, name, subject, activities_json, sort_order, created_at
                         -- subject = '' 即通用集；activities_json 有序 [{"type":"picker"},{"type":"seating","config":{...}}]
```

要点：

- **四张表的命名口径**：`lesson_*` 前缀 = 节课作用域（一次上课一条）；`seatings` 无前缀 = 学期域状态（与 `timetables` 同类）；`classroom_activity_sets` = 课堂域配置。
- **槽位幂等就是恢复**：`openLessonSession` 先按槽位查（`period` 为 NULL 时另走 `(period = ? OR (? IS NULL AND period IS NULL))` 匹配），命中即原样返回 `created: false`；`period !== null` 才查重。已结束的会话命中也不复活（不新建、不重置状态）。
- **`student_id` 提升为独立列**（不埋在 payload）：跨会话「距上次被点 N 天」走 `idx_lesson_events_student_pick` 部分索引——`lastPickedAtByStudent(studentIds, beforeIso)` 就是这条查询（从未被点的人不出现在 Map 里）。
- **`seatings.group_no` 显式列**，不由 `col_no` 推导（支持团团坐等任意分组）；`0` = 未入座/未分组，`buildGroups` 跳过。
- **无表回退推导**：`buildClassroomRoster(class_name, lesson_date)` 先按日期推学期（`semesterOfDate`）查 `listSeating`；无记录 → `deriveSeatingGrid(students)` 按学号升序（空学号按 id）铺 `DEFAULT_SEAT_COLS = 6` 列网格，**组号 = 列号**，`SeatingGrid.derived = true`（不落库）；有记录 → 按 `row_no/col_no` 建网格，未入座学生保留 `row_no = col_no = group_no = 0`。
- **座位写入是幂等命令**：`upsertSeating` 单次事务「先 DELETE 该生同班同学期旧座（一人一座），再按 `(class_name, semester, row_no, col_no)` `ON CONFLICT DO UPDATE`（一格一人，原占位者让位）」；`removeSeatingStudent` / `clearSeating` 分别撤座与清空。编排层是 `assignSeat` / `unseat`。
- **组合配置的解析与快照**：`resolveActivitySet(subject)` 按「科目 trim 精确相等的专属集 → `subject` 空串的通用集 → 代码内置 `DEFAULT_ACTIVITY_SET`（picker/seating/group-race/digest）」返回 `{ activities, source: 'subject' | 'common' | 'default' }`；同优先级多条取 `sort_order` 最小、其次 `id` 最小。开课时 `startLesson` 把它快照进 `activity_set_json`。
- **db 层函数清单**（课堂模式段，双态 API 行为一致）：
  - 会话：`openLessonSession` / `getLessonSession` / `findLiveLessonSession` / `listLiveLessonSessions` / `listLessonSessions(filter)` / `endLessonSession(id, { stats, digest_md, digest_source })`
  - 事件：`appendLessonEvent` / `revokeLessonEvent` / `listLessonEvents(sessionId, { includeRevoked })` / `lastPickedAtByStudent`
  - 座位：`listSeating` / `upsertSeating` / `removeSeatingStudent` / `clearSeating`
  - 组合：`listClassroomActivitySets` / `saveClassroomActivitySet`（有 `id` 按 id 更新，否则按 `(name, subject)` 命中更新，否则插入）
  - 解析函数 `parseJsonObject`（坏 JSON / 非对象 → `{}`）；TEXT 列里的 `activity_set_json` / `stats_json` / `activities_json` / `payload` 都有容错解析，坏数据退化而不是抛错。
- **迁移与对账**：`src-tauri/src/lib.rs` 的 `migrations()` 加 version 9（`add_classroom_lesson_tables`，版本号只增不复用）；`src/lib/db.ts` 的 `SCHEMA_DDL` 同构建表 + `ensureSchema()` 幂等兜底；`tests/schema-sync.test.ts` 断言两侧表集合完全相同且全部 `IF NOT EXISTS`。演示态（非 Tauri）在内存 store 里加 `lessonSessions` / `lessonEvents` / `seatings` / `activitySets` 集合，`clearAll` 一并清空。

## 4. kind 契约表（新活动接入前必读）

`kind` 是开放字符串，`payload` 是自由 JSON；**下表是 P0 已登记的全部契约**。payload 的自校验（guard）写在各自的**活动文件内**（`parsePickPayload` / `parseGroupPoint` 先例），非法 payload 一律「事件已入流但本活动不消费」。

| kind | 发出活动 | payload | `student_id` 语义 | 撤销语义 |
| --- | --- | --- | --- | --- |
| `pick` | `picker` | `{ mode: "random" \| "weighted" \| "hand"; weight?: number }`（非法 `mode` 退回 `random`、非法 `weight` 丢弃） | **必带**（被点学生） | revoke → 该生回到点名池，次数/覆盖率/沉默权重随重放恢复 |
| `behavior` | `seating` | `{ dimension_id: number; type: "praise" \| "improve" \| "neutral"; via: "seat" }`；`emit` 时另带 `behavior` 负载（框架同事务双写档案） | **必带** | revoke → 同事务删 `student_behavior_records`（`settled_record_id` 背引用），角标随之回退 |
| `group_point` | `group-race` | `{ group_no: number（≥1 整数）; delta: number（有穷非零）; reason: string }`（组号/分数非法即跳过） | 为 `null`（小组事件无学生主体） | revoke → 重算各组分数、领先组与流水 |
| `attendance` | `seating` | `{ absent: boolean }`（`true` 缺勤 / `false` 归班） | **必带** | revoke → 回到在班名单与点名池（`students`/`groups` 重建） |
| `seat_change` | `seating` | `{ student_id: number; from: { row, col } \| null; to: { row, col } }`（`row/col` 从 1 起） | 一般同 `payload.student_id`（reduce 兼容两者，`payload` 优先） | 摘要事件：revoke 只让回放展示少一条，**真实座位状态以 `seatings` 表为准**（`assignSeat` 幂等、不撤销） |

红线与守卫：

- **未知 `kind` 必须安全跳过**——所有 `reduce` 对不认识的 `kind` 原样返回（引用不变，状态不被污染）；db 层对任意 `kind`/任意 `payload` 原样持久化、不报错。这是新活动零冲突接入的前提，也是「未知工具不崩溃」哲学的课堂版。
- `Context.emit` 的三条硬校验（抛中文错误）：① `behavior` 负载只能由 `settle = "behavior"` 的活动发出（`活动 X 未声明 settle='behavior'，不能发档案级事件`）；② 该活动发 `behavior` 事件必须带 `behavior` 负载；③ `behavior` 事件必须带 `student_id`。
- db 层再兜一层：`缺少课堂会话` / `发出活动不能为空` / `事件类型不能为空` / `档案型事件必须指定学生`。
- `digest` 活动是**只读**的（不发出任何事件），它的 `reduce` 只把未撤销事件按顺序累积成 `{ events }`，统计聚合交给 `digest.ts` 的纯函数。

## 5. 活动接入步骤（新活动 = 一个文件）

1. **建文件**：`src/classroom/activities/xxx.activity.ts`，`default export` 一个 `LessonActivityDef<S>`（P0 里 `picker` / `group-race` 用 `satisfies LessonActivityDef<...>`，`seating` / `digest` 用显式类型标注）。最少只需写 `reduce` + `component`。
2. **声明 `type` / `title` / `icon`**：`type` 是唯一键（`registry` 重复注册启动即抛错）；`icon` 走 `AppIcon` 的语义名（`seating = "podium"`、`digest = "archive"`；`picker` / `group-race` 目前留空字符串，Tab 上不显示图标）。
3. **写 `reduce`**（实际签名以代码为准）：
   ```ts
   reduce(state: S | null, ev: LessonEvent, ctx: LessonReadContext): S
   ```
   纯函数：只认自己认识的 `kind`，未知项原样返回；`bootstrap` 不是接口的一部分——框架统一 `replay = events.reduce(def.reduce, null)`。**空事件流 → `state = null`**，组件必须自己兜住 `null`：P0 的 `picker` / `group-race` 在活动文件里导出空态构造函数（`emptyPickerState(ctx)` / `emptyGroupRaceState(ctx)`），面板用 `props.state ?? emptyXxxState(ctx)` 兜底；`seating` / `digest` 则用可选链取默认值（`props.state?.praise ?? {}` / `props.state?.events ?? []`）。
4. **声明 `requires`**：`("students" | "seating" | "dimensions" | "events")[]`，是能力清单口径（`picker` = 名单+维度；`seating` = 名单+座位+维度；`group-race` = 名单+座位；`digest` = 名单+维度）。**当前 `buildLessonContext` 恒装配名单/座位/维度/事件**（`requires` 尚未驱动条件装配，是留给未来按需瘦身的声明面，见 §10 口子四）。
5. **声明 `settle`**：`"behavior"` = 本活动会产生档案级记录，`emit` 时走双写通道；`"session"` = 纯课堂事件，零双写。**需要双写的判据只有一条**：这条事件对应的动作是否要在班级时间轴/学生档案/评价报告里留下长期档案（P0 只有座位表的记表现走这条路）。
6. **可选 `fallback(ctx)`**：数据缺失的降级文案（不是错误），`null` = 无需降级。P0 先例（文案以代码为准）：`seating` 命中回退网格 → 「未维护座位表，本次按学号临时排座（调整结果会写入学期座位表）」；`group-race` 无分组 → 「本班尚无座位分组，先排座位再开积分赛」；`picker` 全班缺勤 → 「本班当前无在班学生，无法点名」；`digest` 不声明 `fallback`。视图把结果渲染成舞台顶部的提示条（`fallback` 抛错时静默为空）。
7. **写组件**：`src/components/classroom/XxxPanel.vue`，props = `{ state, config? }`，内部 `useLessonContext()` 取容器（未 provide 即抛错，fail-fast）。所有写操作走 `ctx.emit(...)` / `ctx.revoke(eventId)`，反馈走 `ctx.ui.toast`，危险动作走 `ctx.ui.confirm`（`confirmAction`）；跨活动联动用 `ctx.onEvent(cb)`（返回取消订阅函数）。
8. **`config` 透传**：组合里每项可写 `{ type, config }`，`config` 是活动自解释对象（如 `group-race` 的组数、`picker` 的权重模式默认值），框架不解释其内容；组件用 `ctx.activityConfig(type)` 读，框架已深拷一份避免污染配置源。

注册与装配（**不需要改 registry**）：

- `registry.ts` 用 `import.meta.glob<LessonActivityDef>("./activities/*.activity.ts", { import: "default", eager: true })` 构建期扫描（与 `src/agent/manifest.ts` 扫描 tools/page-actions 同构）。`scanActivities()` 过滤出「对象且含 `type`/`reduce`/`component`」的模块；`createActivityRegistry(defs)` 按 `type.trim()` 建 Map，**空 `type` 或重复 `type` 直接抛错**（fail-fast）；`getActivityRegistry()` 是懒装配单例（测试可传 defs 覆盖）。
- `resolveActivityEntries(entries, defs?)` 把会话快照解析成 `{ activities, skipped }`：未注册的 `type`（教师配置了未安装的活动）进 `skipped` 并**跳过**，上层 toast 提示、不阻断开课（`ClassroomView` 装配时就地把 `skipped` 拼成一句 toast）。
- 能力清单自动多出一项：新活动不改表、不改 registry、不改 Context、不碰其他活动。

## 6. 会话生命周期（detect → open → live → end，加崩溃恢复）

```
detect ──open──▶ live ──end──▶ ended
  │               │
  │  无课表匹配    │ 崩溃/退出 → 启动恢复横幅（重放事件重建）
  └─▶ 手动选班 ────┘
```

| 环节 | 实现口径 |
| --- | --- |
| **detect** 节次感知 | `detectCurrentLesson(now = new Date())`：并行取 `listTimetableSlotsWithClass(semester)` + `listTimetableExceptionsWithClass(semester, today, today)` + `getProfile()` → `mineOfClassResolver(rows, profile.my_subjects ?? [])` → `buildMyDays(rows, exceptions, mineOf, [today])`（首页课表面板同款投影）→ 过滤 `state !== "cancelled"` 且 `sessionIsNow(s, now)` → 按 `period` 升序、再按班级名（`localeCompare("zh")`）取第一。无命中返回 `null` → 手动选班开临时课堂（`period = null`） |
| **open** 开课 | `startLesson({ class_name, subject, lesson_date, period })`：`resolveActivitySet(subject)` → `openLessonSession`（槽位幂等，`period = null` 不查重）→ **以会话里的快照为准**再 `resolveActivityEntries(session.activities)` 得 `skipped`（恢复既有会话时用当时组合，而非当前配置）。入口快捷函数 `startDetectedLesson(now?)` = detect 命中才开课，否则 `null` 由调用方跳启动页 |
| **live** 课中 | 一切写入走 `ctx.emit` → `appendLessonEvent` → 单事件增量归约 `applyEvent`（`attendance` → 重建在班名单/组 + 全量重放；`pick` 先更新沉默读模型再归约）+ 广播；计时 = `started_at` 实时推导，**不持久化**。`ctx.revoke(eventId)` → `revokeLessonEvent` → 重拉事件流 + 重建名单 + 重拉沉默读模型 + 全量重放（一节课事件量级 ≤ 数百，不做增量撤销） |
| **end** 下课 | `ClassroomView` 下课按钮 → `confirmAction` 确认门 → `finishLesson(target)`：`buildClassroomRoster`（全班在册**含缺勤**）+ `listLessonEvents`（只取未撤销）+ `lastPickedAtByStudent` → `computeLessonStats` + `generateLessonDigest`（AI 优先）→ `endLessonSession(id, { stats, digest_md, digest_source })` 落 `stats_json` / `digest_md` / `digest_source` + `status='ended'` / `ended_at` → 弹层展示小结（「留在本页」/「返回」） |
| **崩溃恢复** | 启动页 `listResumableSessions()` = `listLiveLessonSessions()`（`status='live'`，按 `started_at DESC, id DESC`）→ 逐个「恢复」→ `buildLessonContext` 全量重放重建各活动状态。退出课堂模式**不自动下课**（未下课的留在恢复横幅里，`leave()` 会 toast 提示） |
| **事后修正** | 已结束会话的档案修正走既有「表现时间轴」的删改；事件流 append-only，不追改历史 |

`buildLessonContext({ session, students?, seating?, groups?, dimensions?, events?, registry? }) → { ctx, skipped }` 的装配顺序：缺省从 db + `seating.ts` 编排取名单/座位（`buildClassroomRoster`）、`listBehaviorDimensions()` 取维度、`listLessonEvents()` 取事件 → 聚合 `attendance` 缺勤集合 → 在班名单与分组（`filterInClass` + `buildGroups`）→ 沉默读模型快照（`lastPickedAtByStudent`）→ 解析活动组合 → `replay` 建 `stateMap`。`ctx.activityState(type)` 读某活动状态（重放产物）、`ctx.activityConfig(type)` 读 config、`ctx.daysSincePicked(id)` 读「距上次被点天数」（`null` = 从未被点）。

## 7. 双写透传（课堂表现实时进档案）

- **通道**：`seating` 活动（`SeatGridPanel`）`ctx.emit({ activity: "seating", kind: "behavior", student_id, payload: { dimension_id, type, via: "seat" }, behavior: { dimension_id, dimension_name_snap, category_snap, type, comment } })`。
- **事务**：`appendLessonEvent` 发现 `input.behavior` 时走**单次 `execute` + 显式事务**：
  ```sql
  BEGIN IMMEDIATE;
  INSERT INTO student_behavior_records (student_id, dimension_id, dimension_name_snap, category_snap, type, comment, recorded_date) VALUES (...);
  INSERT INTO lesson_events (session_id, student_id, activity, kind, payload, settled_record_id, occurred_at, created_at)
    VALUES (..., (SELECT id FROM student_behavior_records WHERE rowid = last_insert_rowid()), ?, datetime('now','localtime'));
  COMMIT;
  ```
  `recorded_date` 取**会话的 `lesson_date`**（不是当前日期），保证补记场景落对日子。演示态内存 store 同原子语义（先推 `behaviorRecords` 再推 `lessonEvents`）。
- **撤销**：`revokeLessonEvent(eventId)` 同样单次事务：`UPDATE lesson_events SET revoked_at = ... WHERE id = ? AND revoked_at IS NULL` + `DELETE FROM student_behavior_records WHERE id = (SELECT settled_record_id FROM lesson_events WHERE id = ?)`。已撤销/不存在都不报错（幂等）；`settled_record_id` 为 NULL 时删除命中 0 行。
- **消费者零改动**：`student_behavior_records` 就是既有的表现流水，所以班级时间轴、学生档案、评价报告、Agent `query_data{entity:'behaviors'}` 全部**立即可见**；撤销后同步消失。
- **事件不复制正文**：`behavior` 事件的 payload 只存 `{ dimension_id, type, via }`，评语正文留在档案行里（`settled_record_id` 反查）——防双源漂移。
- **红线**：只有声明 `settle = "behavior"` 的活动能带 `behavior` 负载；`behavior` 事件必须带 `student_id`（见 §4 的 `emit` 三条校验）。

## 8. Agent 集成

| 项 | 落点与口径 |
| --- | --- |
| `query_data` 的 `lessons` 实体 | `src/agent/tools/query.ts`（第 11 个实体）。参数 `class_name` / `date` / `start` / `end`（这四项**仅 lessons 生效**，`date` 与 `start`+`end` 二选一）；`limit` 是**所有实体共用的通用参数**（默认 20、上限 100，带 `class_name` 查询时先不限条数、宽容匹配后再截断，避免先截断丢命中）。班级名宽容匹配 `matchLessonClassName`：精确 → 归一相等 → 归一包含逐级放宽（`normalizeLessonClassName` 把「三(2)班」「三年二班」都落成 `32`）。摘要行 `LessonDigestRow`：`digest_source` 优先 `"stats"`（下课快照，避免与事件流双源漂移）、未下课才回放到事件流现算（`"events"`，聚合函数对未知 `kind` 安全跳过）；字段 `picks` / `praise_count` / `improve_count` / `groups` / `absent` |
| `prompt.ts` | 工具描述已补 lessons 用法（「今天数学课点了谁」「这节课点了哪些人」）。`providers/mock.ts` 同步规则：`LESSON_WORDS`（点了谁/点名/课堂/上课/提问…，不含裸「课」以免误吃「课表」）触发 lessons 查询；`LESSON_ACTION_RE`（开始上课/开课/下课/结束课堂）让位给 `ui_action`；`matchNavTarget` 命中时让位给 `navigate` |
| NAV 注册 | `NAV_TARGETS` 的 `classroom`（`label: "课堂模式"`，`description: "全屏上课界面…"`）→ 路由 `/classroom`（测试 `agent-navigation-tool.test.ts` 断言注册表与路由对齐） |
| 页面动作 | `page-actions/classroom-start.ts`（`page: "classroom"` / `key: "start"` / `dangerous: true`）：按当前时间课表命中开课，或传 `class_name`（`resolveClassName` 查库校验）开临时课堂；开课成功后 `router.push({ name: "classroom", query: { session } })`，summary 区分「已开始」/「继续」（幂等恢复）。`page-actions/classroom-end-lesson.ts`（`key: "end-lesson"` / `dangerous: true`）：取 `listResumableSessions()`，无 live 报错、多个 live 必须用 `session_id` 指定；`finishLesson` 落库后用 `emitPageAction("classroom/end-lesson", {...})` 把小结递进已挂载的视图（未挂载则忽略，小结已落库）。两者都走确认门，不绕过 |
| `ClassroomView` 接住动作 | `onPageAction("classroom/end-lesson", payload)` 只处理当前这场课（`payload.session_id === session.value?.id`），把小结开成弹层 |
| Evals | `tests/evals/dataset.ts`：`query-lessons-picked`（「今天三(2)班数学课点了谁」→ `query_data{ entity: "lessons", class_name: "三(2)班", date: 今天 }`）、`nav-classroom`（「打开课堂模式」走 `navigate`，含「开课」二字也不被动作劫持）、`gate-classroom-start-unconfirmed` / `-confirmed`、`gate-classroom-end-unconfirmed` / `-confirmed`（先拒后 confirm，`shouldGate` 断言） |
| 课堂内写工具 | P0 不开（写工具待脱敏开关与确认门策略复用后再开） |

## 9. 测试地图

| 文件 | 覆盖 |
| --- | --- |
| `tests/classroom-session-db.test.ts` | 会话开课快照、槽位幂等（重开=恢复、已结束的槽位不新建也不复活）、`period NULL` 同日多开、live 列表（跨班恢复）、下课落库、列表过滤与排序、中文校验错误 |
| `tests/classroom-events-db.test.ts` | 事件 append（默认 payload / `occurred_at`）、未知 `kind` 与任意 payload 原样持久化、双写通道、撤销联动删档案、幂等撤销与悬挂容忍、跨会话 `lastPickedAtByStudent`、坏 JSON 容错 |
| `tests/classroom-seating-db.test.ts` | 座位 upsert 与行列排序、一人一座（移座删旧座）、同格覆盖幂等、班级/学期隔离、撤座与清空；活动组合保存（按 `(name, subject)` 更新、`sort_order` 排序）、中文校验错误 |
| `tests/classroom-session.test.ts` | `detectCurrentLesson`（命中/当天无课/非时段/停课例外跳过/非我科目/多命中取第一）、`startLesson`（快照默认集、幂等、临时课堂、skipped 不阻断、校验错误）、`startDetectedLesson`、`listResumableSessions`、`resolveActivitySet`（默认/通用/科目专属/同优先级取序） |
| `tests/classroom-registry.test.ts` | `activities/*.activity.ts` 扫描、单例懒装配、重复或空 `type` fail-fast、顺序与 config 透传、未知 type 跳过、空集/全未注册不阻断 |
| `tests/classroom-context.test.ts` | 双写通道守卫、双写并折进活动状态、未知 `kind` 引用不变、广播与监听器异常容忍、`attendance` 影响名单/分组/点名池、撤销后状态回滚、**重放等价（恢复演练）** |
| `tests/classroom-reducers.test.ts` | picker：已点名单（次数/最后时间）、点名池扣减、覆盖率（分母 = 在班）、缺勤不进池与分母、沉默权重单调与封顶、未知 `kind` 跳过、撤销重放一致、空流 = `null`；group-race：多组/多次/负分聚合、领先组与流水、事件引入新组、非法 payload 跳过、撤销后领先易主、空流；活动定义契约（两个活动只消费自己的 kind、`settle = "session"`） |
| `tests/classroom-seating-reduce.test.ts` | 记表现角标、缺勤与归班、调座摘要与未知 `kind`、撤销后重放一致 |
| `tests/classroom-digest.test.ts` | `computeLessonStats`（覆盖率分母、表扬/待改进计数、缺勤末态、名单有但无事件的组显示 0、沉默预警排序、撤销不计入、课长、空流）、`renderDataDigest` 模板（临时课堂/空数据文案）、`generateLessonDigest` 回退数据版、`generateAiLessonDigest` 永不抛错 |
| `tests/classroom-picker-panels.test.ts` / `tests/classroom-seat-digest-panels.test.ts` | 组件层：`PickerPanel` / `GroupRacePanel` / `SeatGridPanel` / `DigestPanel` 的渲染与交互断言（注入 `LESSON_CTX`） |
| `tests/schema-sync.test.ts` | v9 四表在 `lib.rs` 与 `db.ts` 两侧表集合完全相同、全部 `IF NOT EXISTS`（幂等前提） |
| `tests/agent-query-tool.test.ts` / `tests/agent-navigation-tool.test.ts` / `tests/evals/` | `lessons` 实体查询与 mock 规则、NAV 表与路由对齐（`classroom` 一项）、黄金集里的课堂查询与开/下课确认门用例（`query-lessons-picked`、`nav-classroom`、`gate-classroom-start-*`、`gate-classroom-end-*`） |

## 10. 已知边界与留给未来的口子

**已知边界（明确不做）**：

- 考勤不是考勤管理系统：缺勤只在课内标记（`attendance` 事件可撤销），**不进成绩/评语/学期档案**。
- 小组积分不做跨课长期累积：本课聚合 + 下课快照进 `stats_json`；跨课累积等真实需求再议。
- 多设备同步、家长端投屏、课堂媒体工具（拍照投屏、噪声计）不做。
- 课堂内写操作的 Agent 工具 P0 不开。
- 活动组合管理 UI、教师自定义组名（火箭组/星星组）、`classroom_group_labels` 轻表都是 P1；P0 组名统一「第 N 组」。
- `TimetableGrid` / `TimetableCalendar` 死代码复用另立议题（座位编辑器只是参考了同类网格实现）。

**留给未来的口子**：

1. **新活动 = 一个文件**：以「口算倒计时」为例，`activities/countdown.activity.ts` 里 `type: "countdown"` / `requires: ["students"]` / `settle: "session"` + 一个 `reduce`（认 `countdown_run`）+ 一个组件即可，不改表、不改 registry、不改 Context、不碰其他活动。
2. **`kind` 与 payload 开放**：新事件先写后约；老活动/老会话重放遇未知 `kind` 一律安全跳过，给「听写批改」「随机分组」「桌宠主持点名」预留同一根管道。
3. **组合可配**：`classroom_activity_sets` 表已建、`resolveActivitySet` 已支持科目专属/通用，P1 做管理 UI 时零迁移。
4. **`requires` 能力注入扩展点**：未来接「计时服务」「语音播报」「桌宠事件桥」（ROADMAP 的 P1~P3）时，在 `LessonContext` 增加能力项 + 活动 `requires` 声明即可，活动代码不感知装配细节（当前 `requires` 尚未驱动条件装配，是这类扩展的声明面）。
5. **digest 素材出口**：`lesson_sessions.digest_md` / `stats_json` 是结构化快照，评价报告（`report-ai`）P1 可直接引作「课堂侧素材」，无需回放事件。
6. **座位分组自由度**：`seatings.group_no` 是显式列，团团坐等任意分组天然支持；组号变动只影响当次聚合，不追改历史事件。