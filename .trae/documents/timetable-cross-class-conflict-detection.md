# 排课跨班撞课检测

## Context

用户在两个班同一（天，节）都排了自己的课，系统没有检测出冲突。排查结论：现有冲突检测只在「我的课表」页（`/timetable`）聚合时计算横幅（`buildMySchedule.conflicts`），**排课现场（班级网格编辑浮层、Excel 导入落库）完全无检查**；且口径依赖「我的科目」——未登记任教学科/未做班级标记时永不报冲突。

用户已确认两项决策：
1. 编辑保存撞课时 **警告 + 「仍要保存」**（软警告二次确认，不阻断）
2. Excel/CSV 导入 **预览时列出撞课清单**（不阻断导入）

检测口径与「我的课表」conflicts 完全同源：只有 subject ∈ 该班生效「我的科目」（`mineOf` 三态：班级标记 null 回退全局 / []=本班没我的课 / 非空=集合）的格子才参与撞课判定；帮别的老师录的课（非我的科目）同时段多班不算冲突。

## 改动文件

### 1. src/lib/timetable.ts — 新纯函数

在 `MyScheduleConflict` 附近新增（`isMySubject` 之前）：

```ts
export interface CrossClassConflict {
  class_name: string;
  subject: string;
}

export function crossClassConflictsAt(
  rows: TimetableSlotWithClass[],
  mineOf: MineOfClass,
  at: { day_of_week: number; period: number; excludeTimetableId?: number }
): CrossClassConflict[]
```

- 过滤：同 (day, period)、`timetable_id !== excludeTimetableId`、`isMySubject(row.subject, mineOf(row.class_name))`
- 返回按 class_name zh locale 排序；(timetable_id, day, period) 唯一约束保证每班最多一条
- 不做「保存科目是否我的科目」的门——该门在调用方

### 2. src/lib/db.ts — 扩展 listTimetablePeriodsByClass（L2749 附近）

返回类型增加 `my_subjects: string[] | null`（additive，双态各加一行，Tauri 分支用既有 `parseMySubjectsJson` 解析）。理由：导入场景要读目标班「我的科目」标记，该函数覆盖**零格子但已标记的班**（含 `[]` 语义）。既有调用方只消费 periods，无影响。

### 3. src/components/TimetableGrid.vue — 浮层保存状态机

- 新增可选 prop `conflictRows?: TimetableSlotWithClass[]`（本学期全部班级格子联班级名/标记），**未传 = 检测静默关闭，零行为变化**
- import 增加 `crossClassConflictsAt`、`mineOfClassResolver`
- 新增状态：
  - `forceConfirm = ref(false)`：警告已出示、待二次确认
  - `conflictMineOf` computed：`conflictRows` 存在时 `mineOfClassResolver(conflictRows, props.mySubjects)`
  - `editConflicts` computed：`conflictRows && timetable && isMySubject(editSubject, effectiveMine)` 都成立时调 `crossClassConflictsAt(..., {day_of_week: editDay, period: editPeriod, excludeTimetableId: timetable.id})`
- `openEditor` / `closeEditor` 重置 `forceConfirm = false`；`watch([editSubject, editNote])` 改动即重置
- `saveCell()`：`editConflicts` 非空且未武装 → 只武装（显示警告），return；否则照常落库
- `clearCell()` 不动（空科目不参与检测，清空只会减少撞课）
- 模板浮层（L292-345）：备注输入框后插入警告条 `data-test="conflict-warning"`（danger 样式，逐条列 `周X 第N节 · 班级（科目）`）；保存按钮加 `data-test="slot-save"`，武装态文案变「仍要保存」（红色调，AppButton variant 实现时按其 API 选用，若无 danger variant 用 class 补色）

### 4. src/views/ClassDetailView.vue — 注入数据

- `openTimetableTab()`：`findOrCreateTimetable` 后并行 `Promise.all([getTimetableWithSlots, listTimetableSlotsWithClass(TIMETABLE_SEMESTER).catch(() => [])])`，后者存 `conflictRows` ref
- `refreshTimetable()`：重拉本班后同样重拉 conflictRows（catch 兜底静默降级）
- `<TimetableGrid>` 加 `:conflict-rows="conflictRows"`；学期口径两处同用 `TIMETABLE_SEMESTER`，天然一致

### 5. src/components/ImportTimetableDialog.vue — 预览撞课清单

- open watcher 的 Promise.all 增加 `listTimetableSlotsWithClass(currentSemester()).catch(() => [])`；`listTimetablePeriodsByClass` 结果保留填 `marksByClass: Map<class_name, my_subjects | null>`
- computed `importConflicts`：目标班 `importClassName = presetClass || selectedClass`；`targetMine = resolveClassMySubjects(marksByClass.get(目标班) ?? null, profile.my_subjects)`；对 `mapping.cells` 逐格——`isMySubject(cell.subject, targetMine)` 命中才评估 `crossClassConflictsAt(otherRows(排除目标班 by class_name), mineOf, cell)`，非空收进清单，按 天→节 排序
- `doImport` / `canImport` **不动**（软警告不阻断）
- 模板：「共识别 N 格」行后、清空选项前插入警告块 `data-test="import-conflict-warning"`，每条 `data-test="import-conflict-item"`，文案如「周一 第4节 语文 与 三(1)班（语文）撞课」，标注「仍可导入」

## 测试（vitest，不新建文件）

- **tests/timetable-lib.test.ts**：`crossClassConflictsAt` 7 例——命中返回、excludeTimetableId 排除本班、他班标记 `[]` 不算、null 回退全局、非我的科目（体育）不算、不同天/节为空、排序与 trim
- **tests/timetable-grid.test.ts**：conflictRows prop 注入——① 撞课时点保存 → 警告出现、按钮变「仍要保存」、未落库；② 再点 → `saveTimetableSlot` 调用一次 + changed + 浮层关；③ 武装后改科目 → 重置；④ 非我的科目一次落库无警告；⑤ 不传 conflictRows 零行为变化；⑥ 本班 classMarked=[] 不警告；⑦ 空科目不武装
- **tests/import-timetable-dialog.test.ts**：`profile.value` 显式设 `my_subjects:["语文"]` 并在 afterEach 还原——① 撞课清单出现且导入仍成功（用演示种子没有的第 4 节保证干净）；② 非我的科目不警告；③ 目标班自身行被排除；④ 目标班标记 [] 不警告；⑤ profile 空且无标记不警告

## 文档（docs/TIMETABLE.md）

- 决策记录追加 **㉒**（2026-09-08 八轮）：跨班撞课软警告——口径与 conflicts 同源（crossClassConflictsAt + mineOf 三态、仅我的科目、排除本班）；编辑浮层「仍要保存」二次确认、导入预览撞课清单，均不阻断；conflictRows 由调用方注入，未注入静默关闭
- §4.1 加浮层警告 bullet；§8 预览加撞课清单 bullet；§11 实施范围表加「八轮（2026-09-08）」行；§13 验收清单加两项

## 边界情况

- **学期**：conflictRows 与被编辑课表同用 `TIMETABLE_SEMESTER` / `currentSemester()`，跨学期班被 db 查询天然过滤
- **空科目/清空**：`isMySubject` 对空串恒 false，不检测；clearCell 绕过状态机
- **零退化**：conflictRows 未传或拉取失败（catch→[]）时保存流程与现状一致；现有测试按文案「保存」定位不受影响（非武装态文案不变）
- **演示态**：内存 store 已含三(1)/三(2)班周一第 2 节双语文，登记任教学科后可自然演示撞课
- **性能**：几百行线性过滤，computed 一次，无需优化

## 验证

1. `npm run typecheck` → `npm test`（不动 Rust，无需 cargo check）
2. 手动验证（dev 模式）：登记任教学科「语文」→ A 班周一第 1 节排语文 → B 班周一第 1 节排语文 → 出现警告条 + 「仍要保存」→ 强制保存后 `/timetable` 冲突横幅同步出现；导入含撞课的 CSV → 预览下方出现撞课清单 → 导入仍成功
