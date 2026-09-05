# 班级管理导航联动、独立详情交互与数据组织优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全侧边栏「班级管理」入口与常驻框架，实现点击班级卡片下钻「独立班级详情页（本班学生条目 + 班级公共相册）」，增强底层数据组织（支持班级公共活动照片与班级维度精准检索），并严格统一全系统按钮组件风格规范。

**Architecture:** 前端基于 Vue 3 + Vue Router 进行路由与侧边栏激活态解耦；数据层在 `src/lib/db.ts` 增强班级聚合、班级学生检索及班级照片聚合（双轨支持 SQLite 与浏览器 MemoryStore）；UI 层抽象班级专属详情页 `ClassDetailView.vue`，复用与强化 `AppButton` 和 `StudentTable`，提供无缝的下钻与面包屑返回体验。

**Tech Stack:** Vue 3 (Composition API / `<script setup>`), TypeScript, Tailwind CSS, Vue Router 4, Tauri SQL plugin (SQLite), Vitest.

## Global Constraints

- 语言规范：代码注释、提交信息、面向用户的文案严格用中文。
- 按钮规范：页面内所有操作按钮必须统一使用 `src/components/ui/AppButton.vue`（`primary`, `secondary`, `pearl`, `danger`），严禁使用行内自定义样式的原生 `<button>`。
- 兼容性：所有在 `src/lib/db.ts` 中的改动必须同时支持 Tauri SQLite 与浏览器开发环境下的 `MemoryStore` 内存兜底。
- 门禁规则：每项任务完成后必须通过 `npm run typecheck` 与 `npm test`；若修改了 Rust 代码则需执行 `cargo check --manifest-path src-tauri/Cargo.toml`。

---

### Task 1: 核心类型定义与照片班级归属支持

**Files:**
- Modify: `src/types/index.ts:40-56`
- Modify: `src-tauri/src/lib.rs:16-65`
- Test: `tests/class-types.test.ts`

**Interfaces:**
- Consumes: 现有 `Photo`, `Student` 接口。
- Produces: 
  - `ClassSummary` 接口（含 `name`, `studentCount`, `maleCount`, `femaleCount`, `photoCount`, `classPhotoCount`, `studentPhotoCount`）。
  - `Photo` 接口更新（`student_id: number | null`, `grade_class: string | null`）。
  - SQLite 数据库版本 2 迁移（为 `photos` 增加 `grade_class TEXT`）。

- [ ] **Step 1: 编写类型与迁移断言测试**

创建 `tests/class-types.test.ts`，验证 `ClassSummary` 与 `Photo` 类型的结构预期与空值兼容性：

```ts
import { describe, it, expect } from "vitest";
import type { ClassSummary, Photo } from "../src/types";

describe("Class Data Types", () => {
  it("allows photo without student_id for class public photos", () => {
    const classPhoto: Photo = {
      id: 1,
      student_id: null,
      grade_class: "三年级二班",
      file_name: "class-group.jpg",
      caption: "运动会合影",
      taken_at: "2026-09-01",
      created_at: "2026-09-01 10:00:00",
    };
    expect(classPhoto.student_id).toBeNull();
    expect(classPhoto.grade_class).toBe("三年级二班");
  });

  it("conforms to ClassSummary structure", () => {
    const summary: ClassSummary = {
      name: "三年级二班",
      studentCount: 45,
      maleCount: 23,
      femaleCount: 22,
      photoCount: 15,
      classPhotoCount: 5,
      studentPhotoCount: 10,
    };
    expect(summary.studentCount).toBe(summary.maleCount + summary.femaleCount);
    expect(summary.photoCount).toBe(summary.classPhotoCount + summary.studentPhotoCount);
  });
});
```

- [ ] **Step 2: 运行测试以确认失败**

运行：`rtk npx vitest run tests/class-types.test.ts`  
预期：失败，提示 TS 类型错误或找不到 `ClassSummary` 导出。

- [ ] **Step 3: 更新 `src/types/index.ts` 与 `src-tauri/src/lib.rs`**

在 `src/types/index.ts` 中：
```ts
export interface Photo {
  id: number;
  student_id: number | null;
  grade_class?: string | null;
  file_name: string;
  caption: string | null;
  taken_at: string | null;
  created_at: string;
}

export interface ClassSummary {
  name: string;
  studentCount: number;
  maleCount: number;
  femaleCount: number;
  photoCount: number;
  classPhotoCount: number;
  studentPhotoCount: number;
}
```

在 `src-tauri/src/lib.rs` 的 `migrations()` 中增加版本 2 迁移：
```rust
    Migration {
      version: 2,
      description: "add_class_photos_support",
      sql: r#"
        ALTER TABLE photos ADD COLUMN grade_class TEXT;
      "#,
      kind: MigrationKind::Up,
    },
```

- [ ] **Step 4: 运行测试验证通过**

运行：`rtk npx vitest run tests/class-types.test.ts`  
预期：PASS。

- [ ] **Step 5: 提交改动**

```bash
rtk git add src/types/index.ts src-tauri/src/lib.rs tests/class-types.test.ts
rtk git commit -m "feat: 扩展 Photo 类型与 ClassSummary 领域模型支持班级公共照片"
```

---

### Task 2: 数据层查询与聚合接口增强 (`src/lib/db.ts`)

**Files:**
- Modify: `src/lib/db.ts`
- Test: `tests/class-data.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ClassSummary`, `Photo`, `StudentRow`。
- Produces:
  - `listStudents(keyword?: string, gradeClass?: string): Promise<StudentRow[]>`
  - `listClasses(): Promise<ClassSummary[]>`
  - `getClassSummary(name: string): Promise<ClassSummary | null>`
  - `listPhotosByClass(className: string, filterType?: 'all' | 'public' | 'student'): Promise<Photo[]>`
  - `addClassPhoto(className: string, fileName: string, caption?: string | null, takenAt?: string | null): Promise<number>`

- [ ] **Step 1: 编写数据层接口测试**

创建 `tests/class-data.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  listClasses,
  getClassSummary,
  listStudents,
  listPhotosByClass,
  addClassPhoto,
} from "../src/lib/db";

describe("Class Data Access Layer", () => {
  it("lists aggregated classes with student and photo metrics", async () => {
    const classes = await listClasses();
    expect(classes.length).toBeGreaterThan(0);
    const c32 = classes.find((c) => c.name === "三年级二班");
    expect(c32).toBeDefined();
    expect(c32!.studentCount).toBeGreaterThanOrEqual(2);
    expect(c32!.maleCount + c32!.femaleCount).toBe(c32!.studentCount);
  });

  it("filters students precisely by class name", async () => {
    const students32 = await listStudents("", "三年级二班");
    expect(students32.length).toBeGreaterThan(0);
    expect(students32.every((s) => s.grade_class === "三年级二班")).toBe(true);

    const filtered = await listStudents("林", "三年级二班");
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("林知远");
  });

  it("fetches single class summary", async () => {
    const summary = await getClassSummary("三年级二班");
    expect(summary).not.toBeNull();
    expect(summary!.name).toBe("三年级二班");
  });

  it("adds and retrieves class public photos", async () => {
    const id = await addClassPhoto("三年级二班", "demo-public-1.jpg", "开学合影", "2026-09-01");
    expect(id).toBeGreaterThan(0);

    const photos = await listPhotosByClass("三年级二班", "public");
    expect(photos.some((p) => p.caption === "开学合影")).toBe(true);

    const allPhotos = await listPhotosByClass("三年级二班", "all");
    expect(allPhotos.some((p) => p.caption === "开学合影")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`rtk npx vitest run tests/class-data.test.ts`  
预期：失败，提示 `listClasses` / `listPhotosByClass` / `addClassPhoto` 等未实现。

- [ ] **Step 3: 在 `src/lib/db.ts` 中实现班级查询与操作接口**

实现：
1. `listStudents(keyword = "", gradeClass?: string)`：增加对 `gradeClass` 的过滤逻辑。在内存中判断 `gradeClass === "未分班" ? !s.grade_class : s.grade_class === gradeClass`；在 SQLite 中使用动态或参数化条件拼接。
2. `listClasses(): Promise<ClassSummary[]>`：内存模式与 SQLite 模式分别聚合学生及照片（匹配公共照片 `p.grade_class = name` 与学生照片），计算男女比例及照片分布，中文本地化排序。
3. `getClassSummary(name: string): Promise<ClassSummary | null>`。
4. `listPhotosByClass(className: string, filterType = "all"): Promise<Photo[]>`。
5. `addClassPhoto(className: string, fileName: string, caption?: string | null, takenAt?: string | null): Promise<number>`。
6. 更新 `seedStore()` 包含至少 1 张班级公共照片示例，并在 `deleteStudent` 时维持公共照片不受影响。

- [ ] **Step 4: 运行测试验证通过**

运行：`rtk npx vitest run tests/class-data.test.ts`  
预期：全部通过。

- [ ] **Step 5: 提交改动**

```bash
rtk git add src/lib/db.ts tests/class-data.test.ts
rtk git commit -m "feat: 数据层实现班级聚合、班级学生过滤与班级公共照片查询"
```

---

### Task 3: 侧边栏常驻与路由结构改造

**Files:**
- Modify: `src/App.vue:9-13`
- Modify: `src/components/AppSidebar.vue:7-25, 42-60`
- Modify: `src/router/index.ts:18-20`
- Create placeholder/stub: `src/views/ClassDetailView.vue`
- Test: `tests/navigation-sidebar.test.ts`

**Interfaces:**
- Consumes: Task 1 的路由规划。
- Produces:
  - 侧边栏常驻支持 `/classes` 及 `/classes/:name`。
  - `activeName` 针对 `classes` 及 `class-detail` 正确激活。
  - 注册 `/classes/:name` 路由并开启 `props: true`。

- [ ] **Step 1: 编写侧边栏导航与路由测试**

创建 `tests/navigation-sidebar.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import AppSidebar from "../src/components/AppSidebar.vue";
import { router } from "../src/router";

describe("Sidebar Navigation and Routing", () => {
  it("contains 班级管理 in sidebar items", async () => {
    const wrapper = mount(AppSidebar, {
      global: { plugins: [router] },
    });
    expect(wrapper.text()).toContain("班级管理");
  });

  it("activates 班级管理 when on classes or class-detail route", async () => {
    await router.push("/classes");
    const wrapper = mount(AppSidebar, {
      global: { plugins: [router] },
    });
    const activeItem = wrapper.find(".bg-canvas.font-semibold");
    expect(activeItem.text()).toContain("班级管理");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`rtk npx vitest run tests/navigation-sidebar.test.ts`  
预期：失败，侧边栏不包含「班级管理」。

- [ ] **Step 3: 改造 `App.vue`, `AppSidebar.vue`, `src/router/index.ts`**

1. `src/App.vue`：
   ```ts
   const fullBleed = computed(() => route.name === "home");
   ```
2. `src/components/AppSidebar.vue`：
   - 在 `NavItem` 中增加 `classes`，在 `items` 数组中放在 `home` 之后：
     ```ts
     { name: "classes", label: "班级管理", icon: "classes" },
     ```
   - 增加专有班级 SVG 图标（书本/黑板样式）；
   - 更新 `activeName` 计算属性：
     ```ts
     const activeName = computed(() => {
       if (route.name === "student-detail") return "students";
       if (route.name === "class-detail") return "classes";
       return String(route.name ?? "");
     });
     ```
3. 创建极简桩文件 `src/views/ClassDetailView.vue`，并在 `src/router/index.ts` 中注册：
   ```ts
   { path: "/classes", name: "classes", component: ClassesView },
   { path: "/classes/:name", name: "class-detail", component: ClassDetailView, props: true },
   ```

- [ ] **Step 4: 运行测试验证通过**

运行：`rtk npx vitest run tests/navigation-sidebar.test.ts`  
预期：PASS。

- [ ] **Step 5: 提交改动**

```bash
rtk git add src/App.vue src/components/AppSidebar.vue src/router/index.ts src/views/ClassDetailView.vue tests/navigation-sidebar.test.ts
rtk git commit -m "feat: 侧边栏常驻挂载班级管理并配置班级详情路由"
```

---

### Task 4: 班级主页 (`ClassesView.vue`) 交互升级与按钮风格规范统一

**Files:**
- Modify: `src/views/ClassesView.vue`
- Test: `tests/classes-view.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `listClasses()` 与 `ClassSummary`。
- Produces:
  - 班级卡片点击准确跳转至 `/classes/:name`（进行 URL 编码）。
  - 卡片展示学生数、公共照片数与学生个人照片数细分。
  - 顶栏与各处按钮统一使用 `AppButton` 规范。

- [ ] **Step 1: 编写 ClassesView 单元测试**

创建 `tests/classes-view.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ClassesView from "../src/views/ClassesView.vue";
import { router } from "../src/router";

describe("ClassesView", () => {
  it("renders class cards pointing to class-detail routes", async () => {
    await router.push("/classes");
    const wrapper = mount(ClassesView, {
      global: { plugins: [router] },
    });
    // 等待 onMounted 加载完成
    await new Promise((r) => setTimeout(r, 50));
    const links = wrapper.findAllComponents({ name: "RouterLink" });
    const classLinks = links.filter((l) =>
      String(l.props("to")?.path ?? l.props("to")).startsWith("/classes/")
    );
    expect(classLinks.length).toBeGreaterThan(0);
  });

  it("uses AppButton for all action buttons", async () => {
    const wrapper = mount(ClassesView, {
      global: { plugins: [router] },
    });
    await new Promise((r) => setTimeout(r, 50));
    // 验证无任何没有 AppButton 类的原生裸 button
    const rawButtons = wrapper.findAll("button:not(.inline-flex)");
    expect(rawButtons.length).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`rtk npx vitest run tests/classes-view.test.ts`  
预期：失败（卡片当前是指向 `/students`，且存在原生裸 button）。

- [ ] **Step 3: 优化 `ClassesView.vue`**

1. 改用 `listClasses()` 获取结构化 `groups`。
2. 顶栏按钮严格统一：
   ```html
   <div class="flex items-center gap-3">
     <AppButton variant="secondary" @click="goImportRoster">导入花名册</AppButton>
     <AppButton variant="primary" @click="openCreateClassModal">新建班级</AppButton>
   </div>
   ```
3. 班级卡片跳转由 `to="/students"` 改为：
   ```html
   <RouterLink
     v-for="g in groups"
     :key="g.name"
     :to="{ name: 'class-detail', params: { name: g.name } }"
     class="..."
   >
     ...
     <div class="flex items-center justify-between">
       <span class="text-caption text-weak">
         照片 {{ g.photoCount }} 张 (公共 {{ g.classPhotoCount }} · 个人 {{ g.studentPhotoCount }})
       </span>
       <span class="text-caption text-primary">查看班级条目 →</span>
     </div>
   </RouterLink>
   ```

- [ ] **Step 4: 运行测试验证通过**

运行：`rtk npx vitest run tests/classes-view.test.ts`  
预期：PASS。

- [ ] **Step 5: 提交改动**

```bash
rtk git add src/views/ClassesView.vue tests/classes-view.test.ts
rtk git commit -m "feat: 班级列表页卡片下钻详情并统一按钮规范"
```

---

### Task 5: 独立班级详情页 (`ClassDetailView.vue`) 完整实现与花名册导入联动

**Files:**
- Create/Implement: `src/views/ClassDetailView.vue`
- Modify: `src/components/ImportRosterDialog.vue` (增加 `presetClass` 属性支持)
- Modify: `src/views/StudentDetailView.vue` (优化面包屑返回路径)
- Test: `tests/class-detail-view.test.ts`

**Interfaces:**
- Consumes: `getClassSummary`, `listStudents`, `listPhotosByClass`, `addClassPhoto`。
- Produces:
  - 完整的班级专属详情页，包含班级概况、本班学生条目表格与搜索、班级相册。
  - 针对本班的花名册一键导入并默认锁定当前班级。
  - 统一全部按钮至 `AppButton`。

- [ ] **Step 1: 编写 ClassDetailView 完整功能测试**

创建 `tests/class-detail-view.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ClassDetailView from "../src/views/ClassDetailView.vue";
import { router } from "../src/router";

describe("ClassDetailView", () => {
  it("renders class name in header and breadcrumb", async () => {
    await router.push("/classes/%E4%B8%89%E5%B9%B4%E7%BA%A7%E4%BA%8C%E7%8F%AD");
    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: { plugins: [router] },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(wrapper.text()).toContain("三年级二班");
    expect(wrapper.text()).toContain("班级管理");
  });

  it("lists students belonging only to this class", async () => {
    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: { plugins: [router] },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(wrapper.text()).toContain("林知远");
    expect(wrapper.text()).toContain("苏晚");
    expect(wrapper.text()).not.toContain("陈嘉树"); // 陈嘉树是四年级一班
  });

  it("allows switching between students tab and photos tab", async () => {
    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: { plugins: [router] },
    });
    await new Promise((r) => setTimeout(r, 50));
    const photoTab = wrapper.findAll("button").find((b) => b.text().includes("班级相册"));
    expect(photoTab).toBeDefined();
    await photoTab!.trigger("click");
    expect(wrapper.text()).toContain("班级公共照片");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`rtk npx vitest run tests/class-detail-view.test.ts`  
预期：失败（桩文件尚未实现完整内容）。

- [ ] **Step 3: 完善 `ImportRosterDialog.vue` 与 `StudentDetailView.vue`**

1. `src/components/ImportRosterDialog.vue`：
   - 增加 `defineProps<{ presetClass?: string }>()`；
   - 当导入的表格没有班级列或者用户选择时，自动以 `presetClass` 作为默认班级。
2. `src/views/StudentDetailView.vue`：
   - 顶部返回按钮与面包屑，优先返回其所在的班级详情页（`/classes/${student.grade_class}`）或历史路径。

- [ ] **Step 4: 实现 `src/views/ClassDetailView.vue`**

构建完整页面：
1. 顶部 Header：
   - 面包屑：`← 班级管理` 链接 + `h1` 班级名称 + 元信息胶囊（学生数、男女分布、照片数）。
   - 操作按钮（严格使用 `AppButton`）：
     - `<AppButton variant="secondary" @click="openClassImport">导入本班花名册</AppButton>`
     - `<AppButton variant="secondary" @click="openAddPhotoModal">添加班级照片</AppButton>`
     - `<AppButton variant="primary" @click="openCreateStudentModal">新建学生</AppButton>`
2. 概览指标卡片（Metric Cards）：
   - 在读学生（人数 + 男女构成）
   - 班级照片（总张数 + 公共/个人构成）
   - 花名册状态（最新更新时间）
3. Tab 切换与主体内容：
   - 选项卡：`学生条目 (N)` 与 `班级相册 (M)`；
   - **学生条目 Tab**：
     - 检索输入框（`AppInput`）；
     - 渲染该班级专有学生表格，点击行直接跳转进入个人成长档案；
     - 空状态使用 `EmptyState.vue`。
   - **班级相册 Tab**：
     - 顶部过滤：全部 / 班级公共 / 学生个人；
     - 照片网格列表，显示缩略图、拍摄日期、说明、归属标（公共 / 个人）；
     - 提供直接上传公共合影弹窗。
4. 对话框接入：复用并传入预填参数的 `StudentFormDialog` 与 `ImportRosterDialog`。

- [ ] **Step 5: 运行测试验证通过**

运行：`rtk npx vitest run tests/class-detail-view.test.ts`  
预期：PASS。

- [ ] **Step 6: 提交改动**

```bash
rtk git add src/views/ClassDetailView.vue src/components/ImportRosterDialog.vue src/views/StudentDetailView.vue tests/class-detail-view.test.ts
rtk git commit -m "feat: 实现独立班级详情页与本班花名册定向导入"
```

---

### Task 6: 全局类型检查与全量测试套件回归验证

**Files:**
- All modified/created files

- [ ] **Step 1: 运行 TypeScript 类型检查**

运行：`rtk npm run typecheck`  
预期：输出零错误（Found 0 errors）。

- [ ] **Step 2: 运行全量 Vitest 测试套件**

运行：`rtk npm test`  
预期：全部现有及新增测试文件（28+ 个文件，250+ 个用例）全部绿色通过。

- [ ] **Step 3: 运行 Rust 编译检查**

运行：`cargo check --manifest-path src-tauri/Cargo.toml`  
预期：Finished dev [unoptimized + debuginfo] 编译无告警与错误。

- [ ] **Step 4: 检查 git status 并提交最终改动**

```bash
rtk git status
rtk git add .
rtk git commit -m "chore: 完成班级管理导航联动、独立详情交互与数据组织优化全量验证"
```
