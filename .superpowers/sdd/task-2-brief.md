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
1. 引入 `listBehaviorRecords`、`QuickBehaviorPopover`、`StudentBehaviorTimeline` 以及类型 `StudentBehaviorRecord`、`BehaviorPolarity`；
2. 增加 `behaviors = ref<StudentBehaviorRecord[]>([])` 与 `activeTab = ref<"behaviors" | "photos">("behaviors")`；
3. 增加快捷记表现状态：
   ```ts
   const quickOpen = ref(false);
   const quickAnchor = ref<{ x: number; y: number } | null>(null);
   const toast = ref("");
   let toastTimer: ReturnType<typeof setTimeout> | undefined;

   function openQuickBehavior(e?: MouseEvent) {
     if (e) {
       const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
       quickAnchor.value = { x: rect.right, y: rect.bottom + 6 };
     } else {
       quickAnchor.value = null;
     }
     quickOpen.value = true;
   }

   async function onQuickSaved(payload: { studentName: string; dimensionName: string; polarity: BehaviorPolarity }) {
     toast.value = `已记录 ${payload.studentName} ${payload.dimensionName}`;
     clearTimeout(toastTimer);
     toastTimer = setTimeout(() => (toast.value = ""), 2400);
     behaviors.value = await listBehaviorRecords(id.value);
   }
   ```
4. 在 `refresh()` 中一并并发拉取 `listBehaviorRecords(id.value)` 并赋值给 `behaviors.value`；
5. 顶栏操作区：原有编辑档案与添加图片旁增加 `[+ 记表现]`（带 `data-test="quick-behavior-btn"`）；
6. 档案头部概览文案：`最近更新 {{ formatShort(student.updated_at) }} · 共 {{ photos.length }} 张图片 · 共 {{ behaviors.length }} 条表现记录`；
7. 右侧卡片改为主体 Tab：
   - 顶部提供 Tab 切换按钮：`日常表现 ({{ behaviors.length }})`（带 `data-test="tab-behaviors"`）与 `图片记录 ({{ photos.length }})`（带 `data-test="tab-photos"`）；
   - 当 `activeTab === 'behaviors'` 时，渲染 `<StudentBehaviorTimeline :records="behaviors" :loading="loading" @add="openQuickBehavior" />`；
   - 当 `activeTab === 'photos'` 时，渲染现有的 `PhotoGrid` 和空提示；
8. 挂载 `<QuickBehaviorPopover :open="quickOpen" :student="student" :anchor="quickAnchor" @close="quickOpen = false" @saved="onQuickSaved" />`。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/student-detail-behavior.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 Task 2 成果**

```bash
rtk git add src/views/StudentDetailView.vue tests/student-detail-behavior.test.ts
rtk git commit -m "feat: 学生详情页集成日常表现时间线与快捷记表现"
```
