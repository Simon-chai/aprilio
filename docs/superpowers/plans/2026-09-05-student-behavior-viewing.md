# 学生日常表现查看与成长时间线实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在学生详情页实现「日常表现」成长时间线组件与双 Tab 布局，并在 AI Agent 的 `query_data` 工具中支持查询日常表现流水，形成完整的表现记录查看与智能问答闭环。

**Architecture:** 保持自底向上分层，新建 `StudentBehaviorTimeline.vue` 纯展示与交互组件（按日期聚合分组、倾向/维度过滤）；在 `StudentDetailView.vue` 改造为双 Tab 结构并串联 `QuickBehaviorPopover` 快捷录入与局部刷新；在 `src/agent/tools/query.ts` 扩展 `entity: "behaviors"` 实体查询与摘要生成。

**Tech Stack:** Vue 3 (Composition API / `<script setup>`), TypeScript, Tailwind CSS, Lucide icons, Vitest, `@vue/test-utils`, Tauri SQLite / MemoryStore。

## Global Constraints

- 遵循中文注释与用户界面文案风格。
- 组件与样式对齐现存 Apple-like 极简质感设计系统（发丝边框 `border-hairline`、柔和底色 `bg-parchment`、主色 `text-primary`、圆角规范）。
- 离线优先：浏览器演示态（`isTauri() === false`）走 `MemoryStore`，桌面端走 SQLite。
- 门禁要求：任务完成后保证 `npm run typecheck` 零错误、`npm test` 全绿，`cargo check` 正常。

---

### Task 1: 创建日常表现时间线组件 `StudentBehaviorTimeline.vue`

**Files:**
- Create: `src/components/StudentBehaviorTimeline.vue`
- Test: `tests/student-behavior-timeline.test.ts`

**Interfaces:**
- Consumes: `StudentBehaviorRecord` (from `src/types`), `formatShort` (from `src/lib/format`)
- Produces: `StudentBehaviorTimeline` 组件，Props: `{ records: StudentBehaviorRecord[]; loading?: boolean }`，Emits: `{ add: [] }`

- [ ] **Step 1: 编写组件单元测试 `tests/student-behavior-timeline.test.ts`**

```ts
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StudentBehaviorTimeline from "../src/components/StudentBehaviorTimeline.vue";
import type { StudentBehaviorRecord } from "../src/types";

const mockRecords: StudentBehaviorRecord[] = [
  {
    id: 1,
    student_id: 1,
    dimension_id: 3,
    dimension_name_snap: "课堂表现",
    category_snap: "behavior",
    type: "praise",
    comment: "积极举手发言，解答疑难问题思路清晰",
    recorded_date: "2026-09-05",
    created_at: "2026-09-05 10:30:00",
  },
  {
    id: 2,
    student_id: 1,
    dimension_id: 1,
    dimension_name_snap: "作业情况",
    category_snap: "study",
    type: "improve",
    comment: "缺少一次课后错题订正",
    recorded_date: "2026-09-05",
    created_at: "2026-09-05 14:00:00",
  },
  {
    id: 3,
    student_id: 1,
    dimension_id: 4,
    dimension_name_snap: "劳动情况",
    category_snap: "behavior",
    type: "praise",
    comment: "主动协助打扫卫生角",
    recorded_date: "2026-09-02",
    created_at: "2026-09-02 16:20:00",
  },
];

describe("StudentBehaviorTimeline.vue", () => {
  it("renders empty state when there are no records", () => {
    const wrapper = mount(StudentBehaviorTimeline, {
      props: { records: [] },
    });
    expect(wrapper.text()).toContain("暂无日常表现记录");
    const addBtn = wrapper.find("[data-test='empty-add-btn']");
    expect(addBtn.exists()).toBe(true);
  });

  it("groups records by recorded_date in descending order", () => {
    const wrapper = mount(StudentBehaviorTimeline, {
      props: { records: mockRecords },
    });
    const dateHeaders = wrapper.findAll("[data-test='timeline-date']");
    expect(dateHeaders.length).toBe(2);
    expect(dateHeaders[0].text()).toContain("2026-09-05");
    expect(dateHeaders[1].text()).toContain("2026-09-02");
  });

  it("filters records by polarity (all / praise / improve)", async () => {
    const wrapper = mount(StudentBehaviorTimeline, {
      props: { records: mockRecords },
    });
    expect(wrapper.findAll("[data-test='timeline-item']").length).toBe(3);

    // 切换到仅看待改进
    const improveFilter = wrapper.get("[data-test='filter-improve']");
    await improveFilter.trigger("click");
    expect(wrapper.findAll("[data-test='timeline-item']").length).toBe(1);
    expect(wrapper.text()).toContain("缺少一次课后错题订正");

    // 切换到表扬
    const praiseFilter = wrapper.get("[data-test='filter-praise']");
    await praiseFilter.trigger("click");
    expect(wrapper.findAll("[data-test='timeline-item']").length).toBe(2);
    expect(wrapper.text()).toContain("积极举手发言");
  });

  it("filters records by dimension", async () => {
    const wrapper = mount(StudentBehaviorTimeline, {
      props: { records: mockRecords },
    });
    const select = wrapper.get("[data-test='dimension-select']");
    await select.setValue("劳动情况");
    const items = wrapper.findAll("[data-test='timeline-item']");
    expect(items.length).toBe(1);
    expect(wrapper.text()).toContain("主动协助打扫卫生角");
  });

  it("emits add event when clicking empty add button", async () => {
    const wrapper = mount(StudentBehaviorTimeline, {
      props: { records: [] },
    });
    await wrapper.get("[data-test='empty-add-btn']").trigger("click");
    expect(wrapper.emitted("add")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/student-behavior-timeline.test.ts`
Expected: FAIL（找不到 `StudentBehaviorTimeline.vue`）

- [ ] **Step 3: 实现 `src/components/StudentBehaviorTimeline.vue`**

```vue
<script setup lang="ts">
import { computed, ref } from "vue";
import type { BehaviorPolarity, StudentBehaviorRecord } from "../types";

const props = defineProps<{
  records: StudentBehaviorRecord[];
  loading?: boolean;
}>();

const emit = defineEmits<{
  add: [];
}>();

const selectedPolarity = ref<"all" | BehaviorPolarity>("all");
const selectedDimension = ref<string>("all");

// 提取所有已存在的维度供下拉选择
const availableDimensions = computed(() => {
  const set = new Set<string>();
  for (const r of props.records) {
    if (r.dimension_name_snap) set.add(r.dimension_name_snap);
  }
  return Array.from(set);
});

// 统计各倾向数量
const stats = computed(() => {
  let praise = 0;
  let improve = 0;
  for (const r of props.records) {
    if (r.type === "praise") praise++;
    else if (r.type === "improve") improve++;
  }
  return { all: props.records.length, praise, improve };
});

// 过滤后的列表
const filteredRecords = computed(() => {
  return props.records.filter((r) => {
    if (selectedPolarity.value !== "all" && r.type !== selectedPolarity.value) {
      return false;
    }
    if (selectedDimension.value !== "all" && r.dimension_name_snap !== selectedDimension.value) {
      return false;
    }
    return true;
  });
});

// 按 recorded_date 倒序分组
interface DateGroup {
  date: string;
  items: StudentBehaviorRecord[];
}

const groupedRecords = computed<DateGroup[]>(() => {
  const map = new Map<string, StudentBehaviorRecord[]>();
  for (const r of filteredRecords.value) {
    const date = r.recorded_date || r.created_at.slice(0, 10);
    const list = map.get(date) ?? [];
    list.push(r);
    map.set(date, list);
  }
  return Array.from(map.entries())
    .sort(([dateA], [dateB]) => (dateA < dateB ? 1 : -1))
    .map(([date, items]) => ({
      date,
      items: items.sort((a, b) => b.id - a.id),
    }));
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 筛选控制栏 -->
    <div v-if="records.length > 0" class="flex flex-wrap items-center justify-between gap-3 border-b border-divider pb-3">
      <!-- 倾向过滤胶囊 -->
      <div class="flex items-center gap-1.5 text-fine">
        <button
          data-test="filter-all"
          type="button"
          class="rounded-full px-3 py-1 transition-colors font-medium"
          :class="selectedPolarity === 'all' ? 'bg-primary text-white' : 'bg-parchment text-weak hover:text-ink'"
          @click="selectedPolarity = 'all'"
        >
          全部 ({{ stats.all }})
        </button>
        <button
          data-test="filter-praise"
          type="button"
          class="rounded-full px-3 py-1 transition-colors font-medium"
          :class="selectedPolarity === 'praise' ? 'bg-[#e8f5e9] text-[#248a3d] border border-[#a3e635]' : 'bg-parchment text-weak hover:text-ink'"
          @click="selectedPolarity = 'praise'"
        >
          👍 表扬 ({{ stats.praise }})
        </button>
        <button
          data-test="filter-improve"
          type="button"
          class="rounded-full px-3 py-1 transition-colors font-medium"
          :class="selectedPolarity === 'improve' ? 'bg-[#fff3e0] text-[#d97706] border border-[#fcd34d]' : 'bg-parchment text-weak hover:text-ink'"
          @click="selectedPolarity = 'improve'"
        >
          ⚠️ 待改进 ({{ stats.improve }})
        </button>
      </div>

      <!-- 维度过滤下拉 -->
      <div v-if="availableDimensions.length > 1" class="flex items-center gap-2">
        <span class="text-fine text-weak">维度：</span>
        <select
          data-test="dimension-select"
          v-model="selectedDimension"
          class="h-7 rounded-md border border-hairline bg-canvas px-2 text-fine text-ink focus:border-primary focus:outline-none"
        >
          <option value="all">全部事项</option>
          <option v-for="dim in availableDimensions" :key="dim" :value="dim">
            {{ dim }}
          </option>
        </select>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="py-12 text-center text-caption text-weak">
      加载日常表现…
    </div>

    <!-- 空状态：一条记录都没有 -->
    <div
      v-else-if="records.length === 0"
      class="flex flex-col items-center justify-center py-12 text-center"
    >
      <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-parchment text-weak">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </div>
      <p class="text-body font-medium text-ink">暂无日常表现记录</p>
      <p class="mt-1 text-fine text-weak">
        可点击右上角或下方按钮，为该学生快速记录课堂表现、作业情况等。
      </p>
      <button
        data-test="empty-add-btn"
        type="button"
        class="mt-4 rounded-full bg-primary px-4 py-1.5 text-caption font-medium text-white transition-opacity hover:opacity-90"
        @click="emit('add')"
      >
        + 记表现
      </button>
    </div>

    <!-- 筛选后无结果 -->
    <div
      v-else-if="filteredRecords.length === 0"
      class="py-10 text-center text-caption text-weak"
    >
      没有符合筛选条件的表现记录
    </div>

    <!-- 时间线列表 -->
    <div v-else class="space-y-6">
      <div
        v-for="group in groupedRecords"
        :key="group.date"
        class="relative pl-6"
      >
        <!-- 时间轴纵向发丝基线 -->
        <div class="absolute bottom-0 left-2 top-2 w-[1.5px] bg-hairline" />

        <!-- 日期标记 -->
        <div class="mb-3 flex items-center gap-2">
          <span
            data-test="timeline-date"
            class="rounded-full bg-parchment px-2.5 py-0.5 text-[11px] font-semibold text-muted"
          >
            {{ group.date }}
          </span>
          <span class="text-[11px] text-faint">
            {{ group.items.length }} 项表现
          </span>
        </div>

        <!-- 当天流水事项 -->
        <div class="space-y-2.5">
          <div
            v-for="item in group.items"
            :key="item.id"
            data-test="timeline-item"
            class="group relative flex items-start gap-3 rounded-lg border border-divider bg-canvas p-3.5 transition-colors hover:border-hairline hover:bg-parchment/40"
          >
            <!-- 节点圆点锚定在时间线上 -->
            <div
              class="absolute -left-[19px] top-4.5 flex h-2.5 w-2.5 items-center justify-center rounded-full ring-4 ring-canvas"
              :class="item.type === 'praise' ? 'bg-[#248a3d]' : 'bg-[#d97706]'"
            />

            <!-- 内容区 -->
            <div class="min-w-0 flex-1 space-y-1.5">
              <div class="flex items-center gap-2">
                <!-- 维度微胶囊 -->
                <span class="rounded bg-parchment px-2 py-0.5 text-fine font-medium text-ink">
                  {{ item.dimension_name_snap }}
                </span>
                <!-- 倾向徽章 -->
                <span
                  class="rounded-full px-2 py-0.5 text-[11px] font-medium"
                  :class="item.type === 'praise' ? 'bg-[#e8f5e9] text-[#248a3d]' : 'bg-[#fff3e0] text-[#d97706]'"
                >
                  {{ item.type === "praise" ? "👍 表扬" : "⚠️ 待改进" }}
                </span>
                <!-- 时间戳 -->
                <span class="ml-auto text-[11px] text-weak">
                  {{ item.created_at.slice(11, 16) || "" }}
                </span>
              </div>

              <!-- 评语文本 -->
              <p class="text-caption text-ink leading-relaxed whitespace-pre-wrap">
                {{ item.comment }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/student-behavior-timeline.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 Task 1 成果**

```bash
rtk git add src/components/StudentBehaviorTimeline.vue tests/student-behavior-timeline.test.ts
rtk git commit -m "feat: 增加学生日常表现成长时间线组件"
```

---

### Task 2: 在学生详情页集成时间线与「+ 记表现」交互

**Files:**
- Modify: `src/views/StudentDetailView.vue`
- Test: `tests/student-detail-behavior.test.ts`

**Interfaces:**
- Consumes: `listBehaviorRecords` (from `src/lib/db`), `StudentBehaviorTimeline.vue`, `QuickBehaviorPopover.vue`
- Produces: 升级后的 `StudentDetailView.vue`，支持 Tab 切换与表现记录增查联动

- [ ] **Step 1: 编写学生详情页时间线集成测试 `tests/student-detail-behavior.test.ts`**

```ts
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import StudentDetailView from "../src/views/StudentDetailView.vue";
import { addBehaviorRecord } from "../src/lib/db";

describe("StudentDetailView behavior tab integration", () => {
  function createTestRouter() {
    return createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/students", name: "students", component: { template: "<div>Students</div>" } },
        {
          path: "/students/:id",
          name: "student-detail",
          component: StudentDetailView,
        },
      ],
    });
  }

  it("renders tabs for behaviors and photos, with behaviors as default", async () => {
    // 写入一条模拟数据
    await addBehaviorRecord({
      student_id: 1,
      dimension_id: 3,
      dimension_name_snap: "课堂表现",
      category_snap: "behavior",
      type: "praise",
      comment: "课堂专注度高",
      recorded_date: "2026-09-05",
    });

    const router = createTestRouter();
    await router.push("/students/1");
    await router.isReady();

    const wrapper = mount(StudentDetailView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    // 检查顶栏有「+ 记表现」按钮
    const addBtn = wrapper.find("[data-test='quick-behavior-btn']");
    expect(addBtn.exists()).toBe(true);

    // 检查 Tab 标签存在
    const behaviorTab = wrapper.get("[data-test='tab-behaviors']");
    const photosTab = wrapper.get("[data-test='tab-photos']");
    expect(behaviorTab.text()).toContain("日常表现");
    expect(photosTab.text()).toContain("图片记录");

    // 默认展示日常表现内容
    expect(wrapper.text()).toContain("课堂专注度高");

    // 切换到图片记录
    await photosTab.trigger("click");
    expect(wrapper.findComponent({ name: "PhotoGrid" }).exists()).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/student-detail-behavior.test.ts`
Expected: FAIL（找不到 `[data-test='quick-behavior-btn']` 或 `[data-test='tab-behaviors']`）

- [ ] **Step 3: 修改 `src/views/StudentDetailView.vue`**

在 `StudentDetailView.vue` 中：
1. 引入 `listBehaviorRecords`、`QuickBehaviorPopover`、`StudentBehaviorTimeline` 以及类型 `StudentBehaviorRecord`；
2. 增加 `behaviors = ref<StudentBehaviorRecord[]>([])` 与 `activeTab = ref<"behaviors" | "photos">("behaviors")`；
3. 在 `refresh()` 中一并拉取 `listBehaviorRecords(id.value)`；
4. 挂载 `QuickBehaviorPopover` 并在保存后刷新 `behaviors`；
5. 右侧面板支持 Tab 切换，渲染 `StudentBehaviorTimeline` 和 `PhotoGrid`。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/student-detail-behavior.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 Task 2 成果**

```bash
rtk git add src/views/StudentDetailView.vue tests/student-detail-behavior.test.ts
rtk git commit -m "feat: 学生详情页集成日常表现时间线与快捷记表现"
```

---

### Task 3: 扩展 AI Agent `query_data` 工具查询日常表现

**Files:**
- Modify: `src/agent/tools/query.ts`
- Test: `tests/agent-query-tool.test.ts`

**Interfaces:**
- Consumes: `listBehaviorRecords` (from `src/lib/db`)
- Produces: `query_data` 支持 `entity: "behaviors"` 查询

- [ ] **Step 1: 在 `tests/agent-query-tool.test.ts` 中增加测试用例**

在 `tests/agent-query-tool.test.ts` 的 `describe("query_data tool")` 内添加：

```ts
  it("queries student behavior records with polarity and keyword filters", async () => {
    // 预置表现记录
    const { addBehaviorRecord } = await import("../../src/lib/db");
    await addBehaviorRecord({
      student_id: 1,
      dimension_id: 3,
      dimension_name_snap: "课堂表现",
      category_snap: "behavior",
      type: "praise",
      comment: "智能助手表现查询测试：数学课主动发言",
      recorded_date: "2026-09-05",
    });

    const res = await tool.execute(
      {
        entity: "behaviors",
        student_id: 1,
        polarity: "praise",
        keyword: "主动发言",
      },
      ctx
    );

    expect(res.ok).toBe(true);
    expect(res.summary).toContain("日常表现查询：命中");
    expect(res.summary).toContain("数学课主动发言");
    const data = res.data as { comment: string }[];
    expect(data.some((d) => d.comment.includes("主动发言"))).toBe(true);
  });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/agent-query-tool.test.ts`
Expected: FAIL（未知查询实体 "behaviors"）

- [ ] **Step 3: 修改 `src/agent/tools/query.ts`**

1. 引入 `listBehaviorRecords`；
2. 在 `parameters.properties` 中扩展 `entity.enum` 为 `["students", "photos", "stats", "behaviors"]`；
3. 添加 `polarity` 和 `dimension_name` 参数定义；
4. 在 `execute` 中增加 `entity === "behaviors"` 分支：
   - 获取 `student_id`（可选）；
   - 获取 `listBehaviorRecords(studentId, limit)`；
   - 根据 `polarity`、`dimension_name`、`keyword` 过滤；
   - 构造 summary 与 data 并返回。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/agent-query-tool.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 Task 3 成果**

```bash
rtk git add src/agent/tools/query.ts tests/agent-query-tool.test.ts
rtk git commit -m "feat: AI Agent query_data 工具支持查询学生日常表现"
```

---

### Task 4: 全量回归与类型检查验证（Verification Gate）

**Files:**
- None (Verification only)

- [ ] **Step 1: 运行 TypeScript 类型检查**

Run: `npm run typecheck`
Expected: 0 errors

- [ ] **Step 2: 运行全量 Vitest 测试集**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: 运行 Rust 后端编译检查**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过，无报错

---
