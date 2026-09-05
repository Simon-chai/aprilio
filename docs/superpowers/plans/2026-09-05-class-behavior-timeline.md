# 班级管理日常表现分类时间轴 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在班级详情页（`ClassDetailView.vue`）新增「日常表现」Tab，以「分类胶囊 + 时间轴流水」形式聚合展示本班所有学生被记录的表现，支持按大类/倾向/学生/事项交叉过滤、点击学生姓名跳转学生档案以及快捷记表现闭环。

**Architecture:** 在数据层提供关联学生表的 `listBehaviorRecordsByClass`；新增专门的 `ClassBehaviorTimeline.vue` 组件负责分类胶囊、复合过滤与卡片时间轴流；在 `ClassDetailView.vue` 中扩展第三个 Tab 与快捷录入联动。

**Tech Stack:** Vue 3 (Composition API), TypeScript, Tailwind CSS v4, Vitest, Vue Test Utils, SQLite (Tauri plugin SQL).

## Global Constraints

- 语言：代码注释、提交信息、面向用户的文案统一用中文；
- 架构分层：数据操作全部在 `src/lib/db.ts`，类型在 `src/types/index.ts`，组件样式沿用项目纸质温润设计系统（`bg-parchment`、`bg-canvas`、`border-hairline`、`text-ink` 等）；
- 改动后必跑：`npm run typecheck` 与 `npm test`。

---

### Task 1: 数据层扩展与类型契约（Types & listBehaviorRecordsByClass）

**Files:**
- Modify: `src/types/index.ts:101-140`
- Modify: `src/lib/db.ts:1050-1080`
- Test: `tests/behavior-db.test.ts`

**Interfaces:**
- Consumes: `StudentBehaviorRecord`, `BehaviorCategory`, `Gender` from `src/types/index.ts`
- Produces: `BEHAVIOR_CATEGORY_LABEL`, `ClassBehaviorRecord` in `src/types/index.ts`; `listBehaviorRecordsByClass(className: string, limit?: number): Promise<ClassBehaviorRecord[]>` in `src/lib/db.ts`

- [ ] **Step 1: 编写数据层单元测试**

在 `tests/behavior-db.test.ts` 中添加针对 `listBehaviorRecordsByClass` 的测试用例：
```ts
it("listBehaviorRecordsByClass returns records for students in target class and attaches student snapshot", async () => {
  // Setup: 学生 1(林知远, 三年级二班) 和 学生 2(苏晚, 三年级二班)
  const records = await listBehaviorRecordsByClass("三年级二班");
  expect(records).toBeDefined();
  for (const r of records) {
    expect(["林知远", "苏晚"]).toContain(r.student_name);
    expect(r.student_name).toBeTruthy();
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`npm test tests/behavior-db.test.ts`
预期：FAIL，报错提示 `listBehaviorRecordsByClass is not a function`。

- [ ] **Step 3: 扩展类型与实现 listBehaviorRecordsByClass**

在 `src/types/index.ts` 导出：
```ts
export const BEHAVIOR_CATEGORY_LABEL: Record<BehaviorCategory, string> = {
  study: "学习表现",
  behavior: "行为习惯",
  other: "其他表现",
};

export interface ClassBehaviorRecord extends StudentBehaviorRecord {
  student_name: string;
  student_no?: string;
  student_gender?: Gender;
}
```

在 `src/lib/db.ts` 实现 `listBehaviorRecordsByClass`：
```ts
export async function listBehaviorRecordsByClass(
  className: string,
  limit = 200
): Promise<ClassBehaviorRecord[]> {
  if (!isTauri()) {
    const store = mem();
    const classStudents = store.students.filter((s) => s.grade_class === className);
    const studentMap = new Map(classStudents.map((s) => [s.id, s]));
    return store.behaviorRecords
      .filter((r) => studentMap.has(r.student_id))
      .map((r) => {
        const s = studentMap.get(r.student_id)!;
        return {
          ...r,
          student_name: s.name,
          student_no: s.student_no,
          student_gender: s.gender,
        };
      })
      .sort((a, b) => {
        const da = a.recorded_date || a.created_at;
        const db = b.recorded_date || b.created_at;
        if (da !== db) return da < db ? 1 : -1;
        return b.id - a.id;
      })
      .slice(0, limit);
  }

  const db = await getDb();
  return db.select<ClassBehaviorRecord[]>(
    `SELECT 
      r.*,
      s.name AS student_name,
      s.student_no,
      s.gender AS student_gender
    FROM student_behavior_records r
    INNER JOIN students s ON r.student_id = s.id
    WHERE s.grade_class = ?
    ORDER BY r.recorded_date DESC, r.created_at DESC, r.id DESC
    LIMIT ?`,
    [className, limit]
  );
}
```

- [ ] **Step 4: 运行测试验证通过**

运行：`npm test tests/behavior-db.test.ts`
预期：PASS。

- [ ] **Step 5: 提交数据层代码**

```bash
git add src/types/index.ts src/lib/db.ts tests/behavior-db.test.ts
git commit -m "feat: 新增班级日常表现查询方法与类型契约"
```

---

### Task 2: 班级日常表现时间线组件（ClassBehaviorTimeline.vue）

**Files:**
- Create: `src/components/ClassBehaviorTimeline.vue`
- Create: `tests/class-behavior-timeline.test.ts`

**Interfaces:**
- Consumes: `ClassBehaviorRecord`, `BehaviorCategory`, `BehaviorPolarity`, `BEHAVIOR_CATEGORY_LABEL`, `StudentRow`
- Produces: `ClassBehaviorTimeline.vue` 组件，Props: `{ records: ClassBehaviorRecord[]; loading?: boolean; classStudents?: StudentRow[] }`，Emits: `{ add: []; selectStudent: [studentId: number] }`

- [ ] **Step 1: 编写组件单元测试**

在 `tests/class-behavior-timeline.test.ts` 中编写测试：
```ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ClassBehaviorTimeline from "../src/components/ClassBehaviorTimeline.vue";
import type { ClassBehaviorRecord } from "../src/types";

describe("ClassBehaviorTimeline.vue", () => {
  const mockRecords: ClassBehaviorRecord[] = [
    {
      id: 1,
      student_id: 101,
      student_name: "林知远",
      dimension_id: 1,
      dimension_name_snap: "作业情况",
      category_snap: "study",
      type: "praise",
      comment: "作业规范",
      recorded_date: "2026-09-05",
      created_at: "2026-09-05 10:00:00",
    },
    {
      id: 2,
      student_id: 102,
      student_name: "苏晚",
      dimension_id: 3,
      dimension_name_snap: "课堂表现",
      category_snap: "behavior",
      type: "improve",
      comment: "注意集中",
      recorded_date: "2026-09-05",
      created_at: "2026-09-05 11:00:00",
    },
  ];

  it("renders category capsules with counts and switches category filter", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: mockRecords },
    });
    expect(wrapper.text()).toContain("全部 (2)");
    expect(wrapper.text()).toContain("学习表现 (1)");
    expect(wrapper.text()).toContain("行为习惯 (1)");

    const studyPill = wrapper.findAll("button").find((b) => b.text().includes("学习表现"));
    await studyPill?.trigger("click");
    expect(wrapper.text()).toContain("林知远");
    expect(wrapper.text()).not.toContain("苏晚");
  });

  it("filters by student and emits selectStudent / router navigation when clicking student name", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: mockRecords },
    });
    const studentBtn = wrapper.find("[data-test='student-name-badge']");
    expect(studentBtn.exists()).toBe(true);
    await studentBtn.trigger("click");
    expect(wrapper.emitted("selectStudent")?.[0]).toEqual([101]);
  });

  it("renders empty state when no records exist", () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: [] },
    });
    expect(wrapper.text()).toContain("本班暂无日常表现记录");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`npm test tests/class-behavior-timeline.test.ts`
预期：FAIL，找不到组件文件。

- [ ] **Step 3: 编写 ClassBehaviorTimeline.vue 组件实现**

实现功能：
1. 顶部分类胶囊：`全部 (N)`、`📚 学习表现 (N1)`、`🌱 行为习惯 (N2)`、`✨ 其他表现 (N3)`；
2. 次级筛选条：评价倾向（全部/表扬/待改进/中立）、学生筛选下拉、事项筛选下拉、右侧 `+ 记表现`；
3. 时间轴流水卡片：左侧垂直基线 `bg-hairline`、状态圆点、学生姓名可点击胶囊、维度徽章、倾向标签、评语正文；
4. 全空状态及筛选无结果友好提示。

- [ ] **Step 4: 运行测试验证通过**

运行：`npm test tests/class-behavior-timeline.test.ts`
预期：PASS。

- [ ] **Step 5: 提交组件代码**

```bash
git add src/components/ClassBehaviorTimeline.vue tests/class-behavior-timeline.test.ts
git commit -m "feat: 新增班级日常表现分类时间轴组件"
```

---

### Task 3: 班级详情页集成与联动（ClassDetailView.vue）

**Files:**
- Modify: `src/views/ClassDetailView.vue`
- Modify: `tests/class-detail-view.test.ts`

**Interfaces:**
- Consumes: `ClassBehaviorTimeline.vue`, `listBehaviorRecordsByClass`, `QuickBehaviorPopover.vue`
- Produces: `ClassDetailView.vue` 支持 `activeTab = "behaviors"`，刷新行为数据，提供记表现联动与学生档案跳转。

- [ ] **Step 1: 在 class-detail-view.test.ts 中补充测试用例**

```ts
it("renders 日常表现 tab, displays ClassBehaviorTimeline, and switches content when toggled", async () => {
  const router = createTestRouter();
  await router.push("/classes/三年级二班");
  await router.isReady();

  const wrapper = mount(ClassDetailView, {
    props: { name: "三年级二班" },
    global: { plugins: [router] },
  });
  await flushPromises();

  const behaviorsTab = wrapper.findAll("button").find((b) => b.text().includes("日常表现"));
  expect(behaviorsTab).toBeDefined();

  await behaviorsTab!.trigger("click");
  await flushPromises();
  expect(wrapper.findComponent({ name: "ClassBehaviorTimeline" }).exists()).toBe(true);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`npm test tests/class-detail-view.test.ts`
预期：FAIL（找不到日常表现 Tab 或 ClassBehaviorTimeline）。

- [ ] **Step 3: 升级 ClassDetailView.vue**

1. 引入 `ClassBehaviorTimeline`、`listBehaviorRecordsByClass`、`QuickBehaviorPopover`；
2. 增加状态 `const behaviorRecords = ref<ClassBehaviorRecord[]>([])`；
3. 在 `refresh()` 中并行调用 `listBehaviorRecordsByClass(props.name)`；
4. 在 Tab 栏中添加 `日常表现 ({{ behaviorRecords.length }})`；
5. 在主体区域渲染 `activeTab === 'behaviors'` 分支；
6. 绑定学生姓名点击直达 `/students/:id`，绑定 `+ 记表现` 弹窗。

- [ ] **Step 4: 运行测试验证通过**

运行：`npm test tests/class-detail-view.test.ts`
预期：PASS。

- [ ] **Step 5: 提交页面集成代码**

```bash
git add src/views/ClassDetailView.vue tests/class-detail-view.test.ts
git commit -m "feat: 班级详情页集成日常表现分类时间轴 Tab"
```

---

### Task 4: 全量质量门禁验证

**Files:**
- All touched files

- [ ] **Step 1: 执行 TypeScript 类型检查**

运行：`npm run typecheck`
预期：零错误，输出无报错。

- [ ] **Step 2: 执行全量单元测试套件**

运行：`npm test`
预期：所有测试套件 100% 通过（PASS）。

- [ ] **Step 3: 最终 Git 状态与提交核查**

执行 `rtk git status`，核对改动与提交记录。
