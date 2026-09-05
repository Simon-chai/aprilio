# 学生日常表现查看与成长时间线设计规范

> 文档状态：设计完成，待评审  
> 日期：2026-09-05  
> 目标：在学生详情页（`StudentDetailView`）新增「日常表现」成长时间线，支持按日期分组、按倾向与维度过滤，并与快捷记表现浮层闭环联动；同时在 AI Agent 的 `query_data` 工具中接入表现数据实体，支持教师通过自然语言智能检索学生表现。

---

## 1. 背景与业务价值

在已落地的《学生日常表现快速记录与多维数据范式设计》中，系统已实现了：
1. 数据库底层三层数据范式（`behavior_dimensions` / `student_behavior_records` / `behavior_comment_presets`）；
2. 前端表格快捷录入卡片（`+ 记表现` 与 `QuickBehaviorPopover`）；
3. 数据层查询方法 `listBehaviorRecords(studentId?, limit?)`。

然而，目前系统**缺乏表现数据的消费与查看端**：
- 教师在表格记完表现后，无法在学生个人档案中回顾该生近期的表现历史与成长轨迹；
- 详情页仍仅展示基本信息与相册，未能体现班主任全面管理学生“一人一页（成长档案）”的核心目标；
- AI 助手无法感知学生的日常表现记录，无法根据自然语言回答教师关于学生在校情况的询问。

因此，本设计旨在补齐查看与消费链路，打通“快捷录入 → 详情页时间线汇聚 → AI 智能问答”的完整闭环。

---

## 2. 学生详情页（StudentDetailView）UI 与交互规范

### 2.1 顶栏操作区与头部摘要升级

1. **操作区按钮**：
   - 原有：`[编辑档案]` `[添加图片]`
   - 增加：`[+ 记表现]`（主按钮或次按钮，图标/胶囊样式，点击在按钮下方弹出 `QuickBehaviorPopover`）
2. **学生头部概览文案**：
   - 原有：`最近更新 YYYY-MM-DD · 共 M 张图片记录`
   - 升级：`最近更新 YYYY-MM-DD · 共 M 张图片 · 共 N 条日常表现`

### 2.2 右侧主体 Tab 化改造

右侧内容区域从单一图片面板改造为双 Tab 结构（对齐 `ClassDetailView` 的成熟模式）：

```text
┌──────────────────────────────────────────────────────────────┐
│ [ 日常表现 (12) ● ]              [ 图片记录 (3) ]             │
├──────────────────────────────────────────────────────────────┤
│ (Tab 1: 日常表现成长时间线，默认激活)                           │
│ (Tab 2: 图片记录 PhotoGrid，保持现有图片导入与展示能力不变)      │
└──────────────────────────────────────────────────────────────┘
```

### 2.3 日常表现成长时间线组件（`StudentBehaviorTimeline.vue`）

#### (1) 筛选工具条（Filter Bar）
位于时间线上方，提供双重快速过滤能力：
- **倾向切换胶囊**：
  - `全部 (N)`
  - `👍 表扬 (X)`（选中时呈现浅绿激活背景 `#e8f5e9` 与深绿边框/文本 `#248a3d`）
  - `⚠️ 待改进 (Y)`（选中时呈现浅橙激活背景 `#fff3e0` 与深橙边框/文本 `#d97706`）
- **维度过滤下拉/胶囊**：
  - 默认「全部事项」；
  - 选项包含已启用的维度（如作业情况、单元/期中期末成绩、课堂表现、劳动情况等）。

#### (2) 时间线结构与视觉呈现（Timeline Flow）
- **日期分组（Date Grouping）**：
  - 记录按 `recorded_date` 降序排列；同一天内的多条记录聚合展示在同一日期节点下。
- **时间轴与节点样式**：
  - 左侧贯穿细发丝连接线（`border-hairline`）；
  - 节点圆点根据倾向呈现色彩指示：表扬为绿色圆点，待改进为橙色圆点。
- **记录卡片内容**：
  - **维度徽章**：采用 `dimension_name_snap` 灰底胶囊（如 `课堂表现`、`作业情况`），字体小巧精练（`text-fine`）；
  - **倾向标识**：`👍 表扬` 或 `⚠️ 待改进`；
  - **评语正文**：清晰渲染教师评语或 AI 生成的描述，段落间距规整；
  - **记录时间**：展示具体的记录时间（如 14:30）。

#### (3) 空状态与极速闭环引导
- 若当前学生无任何表现记录，展示 `EmptyState` 风格占位：
  - 文案：“暂无日常表现记录”；
  - 引导按钮：“+ 记表现”，点击直接触发录入，形成开箱即用的良好体验。

---

## 3. 组件拆分与数据流架构

```
                   StudentDetailView.vue
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
   StudentBehaviorTimeline.vue       PhotoGrid.vue (原有)
            │
            ▼
    (日期分组 / 筛选过滤 / 时间线节点)
            ▲
            │ (触发 + 记表现)
   QuickBehaviorPopover.vue
            │ (saved 事件)
            ▼
   StudentDetailView: 局部仅刷新 listBehaviorRecords(id)
```

### 3.1 核心状态与数据获取

在 `StudentDetailView.vue` 中：
```ts
const activeTab = ref<"behaviors" | "photos">("behaviors");
const behaviors = ref<StudentBehaviorRecord[]>([]);

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    const [s, p, b] = await Promise.all([
      getStudent(id.value),
      listPhotos(id.value),
      listBehaviorRecords(id.value),
    ]);
    student.value = s;
    photos.value = p;
    behaviors.value = b;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// 记表现保存成功后的局部极速刷新
async function onBehaviorSaved() {
  behaviors.value = await listBehaviorRecords(id.value);
}
```

---

## 4. AI Agent 工具协议扩展（`src/agent/tools/query.ts`）

### 4.1 参数扩展与规范

在 `query_data` 工具参数中扩展 `behaviors`：
```ts
properties: {
  entity: {
    type: "string",
    enum: ["students", "photos", "stats", "behaviors"],
    description: "查询实体：学生档案、照片、系统统计、日常表现流水",
  },
  student_id: {
    type: "number",
    description: "按学生 ID 过滤表现流水或照片",
  },
  polarity: {
    type: "string",
    enum: ["praise", "improve"],
    description: "按评价倾向过滤：praise（表扬）| improve（待改进）",
  },
  dimension_name: {
    type: "string",
    description: "按表现维度名称过滤，如「课堂表现」、「作业情况」",
  },
  keyword: {
    type: "string",
    description: "关键词模糊匹配（匹配评语正文或维度名）",
  },
  limit: {
    type: "number",
    description: "最多返回条数，默认 20，上限 100",
  },
}
```

### 4.2 执行逻辑与数据返回

- 调用 `listBehaviorRecords(studentId, limit)` 获取事实流水；
- 结合 `polarity`、`dimension_name`、`keyword` 在内存中精确/模糊过滤；
- 返回格式化摘要供 LLM 上下文推理与直观回答：
  > `日常表现查询：命中 3 条记录，返回前 3 条。\n[2026-09-05] 课堂表现 👍 积极举手发言，思维活跃\n[2026-09-03] 作业情况 ⚠️ 未按时提交作业`

---

## 5. 测试与验证方案

### 5.1 自动化测试矩阵
1. **时间线组件测试 (`tests/student-behavior-timeline.test.ts`)**：
   - 验证根据 `recorded_date` 能够正确对同一天及不同天的流水聚合分组；
   - 验证倾向切换（全部 / 表扬 / 待改进）筛选生效；
   - 验证维度筛选生效；
   - 验证空状态展示与引导按钮。
2. **详情页时间线集成测试 (`tests/student-detail-behavior.test.ts`)**：
   - 验证详情页成功渲染双 Tab；
   - 验证默认展示「日常表现」Tab 并展示记录总数；
   - 验证点击顶栏「+ 记表现」能唤起浮层，并在触发保存后局部更新表现列表。
3. **Agent 工具测试 (`tests/agent-query-tool.test.ts`)**：
   - 补充 `query_data` 查询 `entity: "behaviors"` 测试用例；
   - 验证 `student_id`、`polarity`、`keyword` 等过滤条件。

### 5.2 门禁验证
- `npm run typecheck` 零类型错误；
- `npm test` 全部测试通过；
- `cargo check --manifest-path src-tauri/Cargo.toml` 编译检查通过。
