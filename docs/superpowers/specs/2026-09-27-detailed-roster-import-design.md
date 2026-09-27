# 详细花名册导入设计规范（分组表头 + 多监护人）

> 文档状态：设计完成，待评审
> 日期：2026-09-27
> 数据来源：`四8班学生详细信息_模拟数据.xlsx`（真实学校下发格式；48 人 × 17 列，双行分组表头）
> 目标：学校下发的「学生详细信息表」导入后，学生档案头部 0 手工补录——学生 7 项 + 主/次监护人各 3 项全部落库，且不产生问题行

---

## 1. 背景与现状（实测）

用现有管道（`rosterTableFromGrid` → `detectNameColumn` → `detectFieldMapping` → `prepareRosterRows`）跑这份文件，结果：

| 文件列 | 当前落点 | 结论 |
| --- | --- | --- |
| 学号 / 姓名 / 性别 / 出生日期 / 身份证号 | `students` 对应字段 | ✓ 全部正确（`2017.04.24` → `2017-04-24`） |
| 家庭住址 / 备注 | `students.address` / `note` | ✓（单亲、特困进备注） |
| 监护人1 姓名 / 联系电话 | `guardians[0]` | ✓ 靠「监护人1」父表头 + 电话列**内容嗅探**侥幸命中 |
| 监护人1 单位 / 职务 | — | ✗ 无别名（`guardians.occupation` 字段与「职业」UI 早已存在） |
| 监护人2 全部四列 | — | ✗ 导入端只建 1 位监护人（数据模型本就 1:N） |
| 学籍号 / 籍贯 | — | ✗ 不落库（本轮明确不加字段） |
| 第 2 行（子表头 姓名/联系电话/单位/职务） | 被当数据行 | ✗ 产生 1 条「姓名为空」问题行 |

结论：**只差「子表头行识别」与「监护人分组」两件事**，就能把这份表 100% 吃下。

## 2. 目标与非目标

### 目标

1. **分组表头识别**：父表头（`监护人1`/`监护人2`，合并单元格）+ 子表头行（`姓名`/`联系电话`/`单位`/`职务`）合成复合列名，子表头行不计入数据行、不再报问题行
2. **多监护人落库**：一行最多 2 位监护人，第一位 `is_primary=true`，`relation` 默认「监护人」
3. **单位 + 职务合并进职业**：`guardians.occupation = "顺丰速运鹤山营业点 · 出纳"`（两者缺一时只写存在的那个）
4. **学号优先于学籍号**：同表同时出现「学号」「学籍号」两列时，`student_no` 取「学号」列；只有「学籍号」列时取它（保持现行为）
5. **忽略列可见**：映射区列出「籍贯」「学籍号」等未落库列，用户知道哪些数据没进来

### 非目标（明确不做）

- **不加 `students` 字段**：用户口径「学号就是学籍号」→ 不新增学籍号 / 籍贯字段，`students` 表零迁移
- **不改导入匹配规则**：有学号但匹配不上时**不再回退**姓名+出生日期（保持现行为；同一批学生换学号口径会重复建档属已知取舍）
- 不做导入历史 / 回滚 / 增量字段级合并（重导入仍是整条覆盖，主管护人整条替换）
- 不动成绩导入链路、不动 Rust 侧解码（`grid_from_range` 已满足需要：合并单元格只有左上角有值，这正是分组表头的判据）
- 不给「课后服务登记表」加页面/解析器（另立议题）

## 3. 核心设计

### 3.1 一张图

```
二维网格（Rust：calamine → Vec<Vec<String>>）
        │
        ▼
rosterTableFromGrid      ← ① 表头行嗅探（已有）+ ② 子表头行识别（新增）
        │   headers: ["学号","姓名",…,"监护人1·姓名","监护人1·联系电话","监护人1·单位","监护人1·职务",…]
        │   headerRows: 2（新增，供行号还原）
        ▼
detectNameColumn（已有，不变）
        ▼
detectFieldMapping       ← ③ 列 → 字段槽位，监护人列按「组号 + 属性」分配（新增）
        │   fields: { guardian_name: 8, guardian_phone: 9, guardian_unit: 10, guardian_duty: 11,
        │             guardian2_name: 13, … }
        │   ignored: [{ index: 5, header: "学籍号" }, { index: 7, header: "籍贯" }]（新增）
        ▼
prepareRosterRows        ← ④ guardians[] 变 1~2 条 + occupation 合成（改造）
        ▼
importRosterStudents（已有，不变）
```

### 3.2 分组表头识别（`rosterTableFromGrid`）

在既有表头行（`headerIndex`）确定后，检查下一行是否为子表头行：

```ts
// 子表头行判据（三条全中）
// 1. 该行非空单元格 ≥ 2
// 2. 每个非空单元格长度 ≤ 6 且命中子表头词表
// 3. 至少一列满足「父表头为空 + 子表头非空」——合并单元格展开的残缺行特征，普通数据行不会满足
const SUB_HEADER_KEYWORDS = [
  "姓名", "名字", "学号", "性别", "出生", "身份证",
  "联系电话", "电话", "手机", "联系方式", "单位", "工作单位",
  "职务", "职业", "职位", "关系", "称谓", "备注",
];
```

命中后：

- 复合表头 = `父·子`（父为空时取子），分隔符 `·`
- `RosterTable` 新增 `headerRows`（表头占用的行数，默认 `hasHeader ? 1 : 0`），`rows = records.slice(headerIndex + headerRows)`
- 行号还原改为 `(table.hasHeader ? (table.headerRows ?? 1) : 0) + (table.titleRows ?? 0) + i + 1`，保证问题行行号仍与 Excel 一致
- 无子表头的单行表头走原路径（`headerRows = 1`），行为零变化

### 3.3 字段槽位与组号感知映射（`detectFieldMapping`）

`RosterField` 扩展（保留旧 key 语义 = 第 1 位监护人，现有测试与 Agent 路径不破）：

```ts
export type RosterField =
  | "student_no" | "gender" | "birth_date" | "grade_class" | "id_card" | "address" | "note"
  | "guardian_name"  | "guardian_phone"  | "guardian_unit"  | "guardian_duty"
  | "guardian2_name" | "guardian2_phone" | "guardian2_unit" | "guardian2_duty";
```

`ROSTER_FIELD_LABELS` 对应补：`监护人` / `联系电话` / `家长单位` / `家长职务` / `监护人2` / `监护人2电话` / `监护人2单位` / `监护人2职务`。

分配分两遍，**监护人语义列不参与通用字段分配**（否则「监护人2·联系电话」会被 `guardian_name` 抢走，这是当前 bug 的根因）：

```ts
// 第一遍：非监护人字段，维持现有别名表 + 内容嗅探兜底
// 第二遍：监护人列 → (slot, kind)
//   slot：表头命中 /(?:监护|家长|父亲|母亲|爸|妈|父母|guardian|parent)[^0-9]{0,2}?([12１２])/
//          或复合表头命中 /([12１２])\s*·/  → 1 | 2；两者都没有 → 0
//   kind：name(姓名/名字) / phone(联系电话/电话/手机/联系方式) / unit(工作单位/单位) / duty(职务/职业/职位)
//   组号 0 的重复列按列序兜底：第 1 个 name → guardian_name，第 2 个 → guardian2_name（phone/unit/duty 同理）
```

**学号 vs 学籍号（别名优先级）**：同字段出现多个候选列时，按「别名在数组中的索引 → 精确匹配优先 → 列序靠前」取最优。`student_no` 别名重排为
`["学号", "编号", "学籍号", "student no", "student id"]`，即「学号」永远赢「学籍号」，与列顺序无关。

**忽略列**：未被任何字段认领且有表头的列，收集为 `ignored: { index, header }[]` 返回，供对话框展示。

### 3.4 行构建（`prepareRosterRows`）

```ts
function composeOccupation(unit: string, duty: string): string {
  const u = unit.trim(), d = duty.trim();
  if (u && d) return `${u} · ${d}`;
  return u || d;
}

// 每位监护人：name/phone/occupation 全空则不建（结构不写空壳）
// slot 1：{ name: name || "监护人", phone, occupation, relation: "监护人", is_primary: true }
// slot 2：{ …, is_primary: false }
// 顺序：slot 1 在前（列表与详情页按数组序渲染）
```

其它字段落点不变；`students.note` 继续承接「单亲 / 特困」。

### 3.5 兼容与影响面

| 受影响处 | 影响 |
| --- | --- |
| 单行表头老式表（`监护人` + `联系电话`） | 组号 0 → 第 1 位监护人，行为不变 |
| `detectScoreSheet` | 复合表头不含科目关键词，且「学号/学籍号」仍在 `ROSTER_HEADER_EXCLUDE` 内 → 不受影响 |
| 模板导入（`ROSTER_TEMPLATE_HEADERS`） | 不变（模板保持「监护人 / 联系电话」单监护人，多监护人靠原始 Excel） |
| Agent 工具 `import_student_roster` / `runSmartImport` | 共用同一管道，自动受益；汇总文案可加「监护人 N 位」 |
| 重导入 | `updateStudent` 仍整条替换监护人 → 幂等，不产生重复监护人 |
| 「人员名单」「课后服务」两份表 | 副作用改善：「家长联系电话1/2」不再是「电话被当成姓名」，落为两位只有电话的监护人 |

## 4. 任务拆解

| # | 任务 | 文件 |
| --- | --- | --- |
| T1 | 子表头行识别 + 复合表头 + `headerRows` + 行号还原 | `src/lib/roster.ts` |
| T2 | `RosterField` / `ROSTER_FIELD_LABELS` / 别名表扩展 + 组号感知映射 + 学号优先级 + `ignored` | `src/lib/roster.ts` |
| T3 | 多监护人构建 + `composeOccupation` | `src/lib/roster.ts` |
| T4 | 映射区展示忽略列（可选：显示将写入的监护人数） | `src/components/ImportRosterDialog.vue` |
| T5 | 脱敏 fixture + 模拟导入测试（对齐 `tests/score-import-simulation.test.ts` 先例） | `docs/examples/详细花名册样例.tsv`、`tests/roster-detailed-simulation.test.ts` |
| T6 | 文档更新（映射表、分组表头与多监护人说明、验收清单） | `docs/ROSTER_IMPORT.md` |

TDD 顺序：T1 → T2 → T3 先写失败断言再实现；T4/T5/T6 随后。门禁：`npm run typecheck`、`npm test`（不动 Rust，免 `cargo check`）。

## 5. 测试与验收清单

### 单元测试（`tests/roster-lib.test.ts` 扩展）

- 分组表头：`rosterTableFromGrid` 对「学号|姓名|…|监护人1|∅|∅|∅|监护人2|∅|∅|∅|备注 + 子表头行」输出复合表头，`headerRows === 2`，`rows` 不含子表头行，`prepareRosterRows` 问题行为 0
- 多监护人：一行两组姓名/电话/单位/职务 → `guardians.length === 2`，`[0].is_primary === true`，`occupation === "顺丰速运鹤山营业点 · 出纳"`
- 职业合成：只有单位 / 只有职务 / 两者都有 / 两者都空（不建监护人）
- 学号优先级：「学号」在「学籍号」之后列出现时仍取「学号」；只有「学籍号」时取它
- 忽略列：返回 `ignored` 含「籍贯」「学籍号」
- 回归：现有 25KB 用例全绿（单行表头、模板、未命名班级、成绩单分流等）

### 手工验收

- [ ] 导入 `四8班学生详细信息_模拟数据.xlsx` → 48 人、0 问题行；学生详情页显示 2 位监护人（含「职业 顺丰速运鹤山营业点 · 出纳」）、学号/性别/出生日期/身份证/住址/备注齐全
- [ ] 同一文件重复导入 → 全部计「更新」，学生总数与 id 不变，监护人不重复
- [ ] 班级管理页导入（无班级列）→ 提示将新建「未命名班级1」；班级详情页导入 → 学生进当前班
- [ ] 预览区显示已忽略列（籍贯、学籍号）
- [ ] 「人员名单」「课后服务」两份表的导入结果不劣化（不再出现「姓名=电话号码」的监护人）
- [ ] `npm run typecheck`、`npm test` 全绿
