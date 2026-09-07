# 课表整表化与 Excel/CSV 导入设计规范

> 文档状态：设计完成，已经用户确认方案 A
> 日期：2026-09-07
> 关联文档：docs/TIMETABLE.md（课表域总体设计，本 spec 是其「四轮迭代」）
> 决策记录（2026-09-07，四轮反馈：课表首先是一张「表」，行=节次必须画满；录入要可发现）：
> ⑩ **凡叫「课表」的界面必须画出完整节次网格**：行 = 学校节次结构全集（`periodsUnion`），不再由「我有课的节次」决定行数；空格也是格子。
> ⑪ **班级课程表 Tab 默认进周网格**，月历降为「日历视图」切换项；调课/日程仍在日历侧维护。
> ⑫ **Excel/CSV 导入提前落地**（原 P1）：复用花名册文件管道与导入对话框交互骨架；拍照识别维持 P2。

---

## 1. 背景与问题

用户视角的反馈：**「课表，首先是个表？现在看起来像备忘录，只精确到天；课表是要安排每天至少 8 节课的」「用户怎么导入课表都不知道」**。

代码层核实出三个根因：

1. **网格行数缩水**：「我的课表」按科目分块的行数 = 该科有课的最大节次（`MyTimetableView.vue` 的 `maxPeriodOf`），「本周日程」行数 = `weekMaxPeriod`（我有课的最大节次），首页面板同样用 `weekMaxPeriod`（`HomeView.vue:60`）。只有 1~2 节课时，整张「表」真的只有 1~2 行，节次结构根本不出现。
2. **排课入口藏得深**：往课表录课的唯一路径是 班级详情 → 课程表 Tab → **默认显示月历** → 右上角铅笔 → 周网格（`ClassDetailView.vue` 的 `timetableView` 默认 `"calendar"`）。
3. **导入缺失**：Excel/CSV 导入课表在 docs/TIMETABLE.md §8 标为 P1 未实现；录课只有手工逐格一条路，且不可发现。

## 2. 目标与非目标

### 目标

1. 「我的课表」默认视图 = 完整周课表网格：行 = 全部节次（含时间），列 = 周一~五带日期，一格一课、空格留白
2. 「按科目」视图的每科网格同样画满全部节次
3. 班级课程表 Tab 默认进可编辑周网格；月历降为切换项
4. Excel/CSV 课表导入：识别 → 预览 → 落库，附可下载模板；入口在「我的课表」页顶与班级课程表 Tab
5. 空态可发现：无数据时给出「登记任教学科 → 导入 / 去排课」的明确引导

### 非目标

- 拍照/图片识别（维持 P2）
- Agent `import_timetable` 写工具（本轮不做，docs 标注后置）
- 周六补课、教师冲突排课等教务能力（docs/TIMETABLE.md 既有边界不变）
- 首页面板交互定稿不动（只修正行数来源，见 §5.4）

## 3. 现状与证据

| 事实 | 位置 |
| --- | --- |
| 周网格组件已具备完整能力：行 = `timetable.periods ?? defaultPeriods()`，含编辑浮层、节次设置、今天/当前节高亮 | `src/components/TimetableGrid.vue` |
| 班级 Tab 视图切换 `timetableView` 默认 `"calendar"`，网格靠月历 `@edit` 事件进入 | `src/views/ClassDetailView.vue:65,572-595` |
| 我的课表两种形态的行数都由「有课节次」决定 | `src/views/MyTimetableView.vue:84-90,152-154` |
| `TimetableSlotWithClass` 每行已联 `periods`（该班节次配置） | `src/lib/db.ts:2634-2656` |
| 默认节次 = 小学 8 节（上午 4 + 下午 4）；`buildGrid` 按 periods 行序构建 | `src/lib/timetable.ts:71-82,145-158` |
| 文件管道：桌面端 `pickRosterFile()` 走 Rust `roster_read_table`（calamine，xlsx/xls/ods）+ `roster_read_text`；浏览器态 `<input type=file>` 仅 CSV/TSV/TXT | `src/lib/roster.ts:129-190` |
| 导入对话框交互骨架（模式切换/文件选择/识别/预览/落库/结果）可复刻 | `src/components/ImportRosterDialog.vue` |
| 演示数据 `periods: null` → 全部回退 8 节默认 | `src/lib/db.ts:443-504` |

## 4. 数据与纯函数层

### 4.1 `periodsUnion`（lib/timetable.ts）

```ts
/** 合并多班节次配置：按 period 升序去重，时间取首个非空；全空回退 defaultPeriods() */
export function periodsUnion(lists: (TimetablePeriod[] | null)[]): TimetablePeriod[]
```

- 输入来源：`listTimetablePeriodsByClass(semester)` 的各班 `periods`（见 4.2）；失败/为空时由调用方回退「slots 行内 periods 的并集」再回退 `defaultPeriods()`
- 保持 `session`（morning/afternoon）用于分组渲染；同一 period 冲突时时间取第一个非空值

### 4.2 `listTimetablePeriodsByClass`（lib/db.ts，双态）

```ts
export async function listTimetablePeriodsByClass(
  semester: string
): Promise<{ class_name: string; periods: TimetablePeriod[] | null }[]>
```

- Tauri：`SELECT class_name, periods_json FROM timetables WHERE semester = ?` → `parsePeriodsJson`
- 浏览器演示态：`mem().timetables` 同构过滤
- 目的：覆盖「节次设置配了 8 节但 period 8 还没排过课」的场景（slots 行内联不出该配置）

### 4.3 `lib/timetable-import.ts`（新文件，纯函数，vitest 直测）

```ts
export interface TimetableLayout {
  ok: boolean;
  /** true=行=节次 × 列=星期（标准向）；false=需转置（列=节次 × 行=星期） */
  periodRows: boolean;
  /** 星期表头所在列（periodRows 时）或行（!periodRows 时），0 起 */
  dayIndex: number;
  /** 节次列（periodRows 时）或行（!periodRows 时），0 起 */
  periodIndex: number;
  /** 数据区起点（跳过表头行/列之后） */
  dataStart: number;
  confidence: "high" | "low";
  reason: string;
}

export function detectTimetableLayout(table: RosterTable): TimetableLayout;
export interface TimetableImportCell {
  day_of_week: number;      // 1~5；周六(6)/周日(7)识别但不产出，计入 dropped
  period: number;           // 1~12，越界丢弃
  subject: string;
  note: string | null;
}
export function mapTimetableCells(
  table: RosterTable,
  layout: TimetableLayout
): { cells: TimetableImportCell[]; skippedRows: string[]; droppedWeekendCells: number };
export function downloadTimetableTemplate(): void;
```

识别规则（与 docs/TIMETABLE.md §8 同口径）：

- **星期表头**：单元格命中 `周一|星期一|周一\s|Mon` 等词（含「周一~周五/周六/周日」）的行/列 → 星期表头；允许「星期一」与「周一」混用
- **节次**：`第N节|第N节课|^[N]$|N.` 命中 → 节次；连续纯数字列/行同样接受
- **非节次行剔除**：`午休|大课间|眼保健操|课间操|晨检|放学` 行计入 `skippedRows`，不产出格子
- **单元格拆分**：`数学（去机房）` / `数学(去机房)` → subject=`数学`、note=`去机房`；括号全半角都支持；科目首尾空白剥离
- **方向判定**：默认行=节次 × 列=星期；若星期词出现在首列而非表头行 → `periodRows=false`（转置）
- **置信度**：找不到星期表头 → `confidence="low"`、`ok=false`，由对话框转人工指定

### 4.4 CSV 模板

`downloadTimetableTemplate()` 生成 CSV（`\uFEFF` BOM，Excel 直开不乱码）：首行 `节次,周一,周二,周三,周四,周五`，8 行默认节次 + 示例科目若干 + 注释行说明可改节数。

## 5. 界面设计

### 5.1 导入对话框 `ImportTimetableDialog.vue`（新组件）

Props：`{ open: boolean; presetClass?: string }`；Emits：`close` / `imported: [{ className: string; count: number }]`。

流程（复刻 `ImportRosterDialog` 骨架）：

1. **选班级**：`presetClass` 存在（班级详情入口）则锁定展示；否则下拉选择 `listClasses()` 结果——课表是班级维度事实，不支持凭空建班
2. **选文件**：Tauri 走 `pickRosterFile()`（xlsx/xls/ods/csv 全格式）；浏览器态 `<input type=file accept=".csv,.tsv,.txt">` + `decodeRosterBytes`
3. **自动识别**：`detectTimetableLayout`；`confidence="low"` 时展示原因 + 两个下拉（星期列、节次列）人工指定，指定后重算
4. **预览**：按映射结果渲染真实周网格（复用科目稳定配色 `subjectChipClass`；非节次行剔除提示「已跳过：午休…」；周六/周日列丢弃提示）
5. **导入选项**：勾选框「清空该班现有课表后导入」（默认关；开启时先 `clearTimetableSlots` 再写入——见 5.5）
6. **落库**：逐格 `saveTimetableSlot(timetableId, day, period, subject, note)`，仅写有内容格子；若导入节次超出当前配置，先自动扩展该班节次配置（最多 12 节）；单格失败收集报告不中断
7. **结果**：`导入 N 格 · 跳过 M 个空格 · 周末列丢弃 K 格`；失败清单（如有）

### 5.2 「我的课表」页整表化（MyTimetableView.vue）

- **默认视图改为 `"week"`**（重命名展示为「周课表」；原「本周日程」语义并入：网格下方日程卡保留）
- 行来源：`listTimetablePeriodsByClass(SEMESTER)` → `periodsUnion`（含上下课时间显示，左列同 `TimetableGrid` 样式：节次号 + 时间两行）
- 列 = 本周一~五带日期（现状保留）；格 = `buildMyDays` 结果（科目胶囊配色 + 班级 + 停/调/加徽标，点击跳班级）；空格 = 虚线空格子（同 `TimetableGrid` 空态样式 `border-dashed border-divider bg-pearl/40`）
- **按科目视图**：`maxPeriodOf` 删除，行改 `periodsUnion`；有课格填班级名（现状交互保留），无课格淡显空格子
- **空态三步引导卡**（替换现有 `blocks-empty` 纯文案；置于视图切换之下、**周课表与按科目两视图共用**——无任教学科或全库无格子时展示）：
  1. 登记任教学科 → 「去登记」按钮（未登记时步骤 1 高亮）
  2. 导入课表 → 「导入课表」按钮直开对话框
  3. 手工排课 → 「去班级排课」按钮（跳 `/classes`）
- **页顶常驻**「导入课表」按钮（header 右侧，任一视图可见）

### 5.3 班级课程表 Tab 默认周网格（ClassDetailView.vue）

- `timetableView` 默认值 `"calendar"` → `"grid"`；`openTimetableTab` 不再自动建课表逻辑变化（`findOrCreateTimetable` 保持，网格需要 timetable 对象承载节次设置）
- Tab 内容头部加**双态切换**：「课表 | 日历」（样式复用现有 Tab 胶囊）；原月历右上角铅笔 `@edit` 事件保留（日历视图内仍可一键进网格）
- 网格视图头部右侧加「导入课表」按钮（`presetClass` 锁定当前班）+ 一行提示「换课 / 停课 / 日程在日历视图维护」
- 「完成，返回日历」按钮移除（切换已有双态按钮承担）

### 5.4 首页面板同源修正（HomeView.vue）

- `weekMaxPeriod`（`HomeView.vue:60`）改为 `periodsUnion` 行数；交互、视觉、入口定稿全部不动

### 5.5 db.ts 补充

- 新增 `clearTimetableSlots(timetableId): Promise<number>`（双态）：删除该课表全部 slot 行，返回删除数；供导入「清空后导入」选项使用
- 新增 `listTimetablePeriodsByClass`（见 4.2）
- 无 DDL、无迁移（纯新增只读/清理函数）

## 6. 测试计划

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 纯函数 | `tests/timetable-import.test.ts`（新） | layout 识别（标准向/转置/低置信度）、节次词与数字节次、非节次行剔除、括号备注拆分、周末列丢弃计数、越界节次丢弃、模板下载内容 |
| 纯函数 | `tests/timetable-lib.test.ts`（增） | `periodsUnion`：并集去重、时间取非空、全空回退默认 |
| db | `tests/timetable-db.test.ts`（增） | `listTimetablePeriodsByClass` 双态、`clearTimetableSlots` 计数与联动 |
| 组件 | `tests/import-timetable-dialog.test.ts`（新） | 浏览器态 CSV 注入（`loadText` 模式）→ 识别 → 预览断言 → 落库断言（saveTimetableSlot 调用参数）→「清空后导入」开关 |
| 组件 | `tests/my-timetable-view.test.ts`（改） | 默认视图=周课表；**空数据也有完整 8 行**；按科目网格行数 = 全部节次；空态引导卡按钮 |
| 组件 | `tests/class-detail-view.test.ts` / `tests/timetable-calendar.test.ts`（改） | 进 Tab 默认显示周网格；切换日历正常；铅笔入口仍可进网格 |
| 组件 | `tests/home-view.test.ts`（改） | 面板行数 = 全部节次（不随我的课缩水） |

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 导入识别歧义（无表头、多工作表、合并单元格） | 识别结果必须经预览确认；低置信度强制人工指定；合并单元格由 calamine 展开为左上值（Rust 管道现状），预览兜底 |
| 「清空后导入」误删 | 默认关 + 二次确认文案展示将删除的格数 |
| 默认视图变更影响既有用户习惯 | 班级 Tab 月历入口仍在（双态切换一键可达）；不丢任何既有能力 |
| periodsUnion 行数过多（12 节）撑爆面板 | 网格容器保持现有滚动策略；节次上限 12（`TimetableGrid` 既有约束） |

## 8. 验收清单

- [ ] 「我的课表」默认显示完整周网格：未登记任教学科也有 7（或节次设置的全部）行 × 5 列，空格可见
- [ ] 按科目视图每科网格行数 = 全部节次，不再只有有课的行
- [ ] 周网格格内：科目稳定配色 + 班级名 + 停（划线）/调/加徽标 + 上下课时间（左列），点击跳班级
- [ ] 今天列与当前节次高亮正常
- [ ] 空态引导卡三步按钮全部可达（资料 / 导入对话框 / 班级列表）
- [ ] 班级课程表 Tab 进 Tab 即见可编辑周网格；「日历」切换后月历、调课、日程、铅笔入口全部照旧
- [ ] Excel(.xlsx) 导入：选班 → 选文件 → 自动识别 → 预览与实际一致 → 落库后网格/我的课表/首页同步出现
- [ ] CSV 导入（浏览器演示态）走通同流程；下载的模板可直接被导入识别
- [ ] 低置信度文件可人工指定星期列/节次列后完成导入
- [ ] 「清空后导入」默认关；开启后旧格子被清且仅剩导入内容
- [ ] 非节次行（午休等）与周末列不落库，且有明确提示
- [ ] 首页面板行数不再随「我的课」缩水；交互无变化
- [ ] `npm run typecheck`、`npm test` 全绿
