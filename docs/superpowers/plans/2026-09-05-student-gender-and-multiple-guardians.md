# 学生档案性别选择与多监护人支持重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 学生档案编辑支持性别「男 / 女」二选一单选交互；底层数据库与数据模型彻底重构支持多监护人（1:N），消除冗余字段；更新表单弹窗、详情页与列表呈现并全量测试通过。

**Architecture:** 数据层在 SQLite 和 MemoryStore 中将学生与监护人拆分为 `students` 主表和 `guardians` 从表，外键级联删除；类型层在 `src/types/index.ts` 抽象 `Guardian` 实体，`Student` 关联 `guardians: Guardian[]`；UI 层在 `StudentFormDialog.vue` 实现性别 Segmented Control 和动态多监护人卡片，在 `StudentDetailView.vue` 和 `StudentTable.vue` 升级展示。

**Tech Stack:** Vue 3 (Composition API), TypeScript, Tailwind CSS, SQLite (`@tauri-apps/plugin-sql`), Tauri 2.0 (Rust), Vitest.

## Global Constraints

- 语言：代码注释、面向用户的文案使用中文。
- 交互风格严格遵循现有设计系统（`AppButton`, `AppInput`, `AppCard`），按钮及控件样式严禁使用未经包裹的原生未样式化按钮。
- 无历史包袱：开发阶段现有数据可重构，彻底移除 `students.guardian_name` 和 `students.guardian_phone` 冗余列。
- 改动后必跑门禁：`npm run typecheck` → `npm test`；动了 Rust 再跑 `cargo check --manifest-path src-tauri/Cargo.toml`。

---

### Task 1: 数据类型与领域模型重构 (`src/types/index.ts`)

**Files:**
- Modify: `src/types/index.ts`
- Test: `tests/student-guardians-types.test.ts`

**Interfaces:**
- Produces:
  - `export type Gender = "男" | "女";`
  - `export interface Guardian { id?: number; student_id?: number; name: string; phone: string; relation: string; is_primary?: boolean; }`
  - `export interface Student { id: number; name: string; gender: Gender; birth_date: string | null; student_no: string; grade_class: string; enroll_date: string | null; address: string | null; status: string; note: string | null; guardians: Guardian[]; created_at: string; updated_at: string; }`
  - `export type StudentInput = Omit<Student, "id" | "created_at" | "updated_at">;`
  - `export interface StudentRow extends Student { primary_phone?: string | null; primary_relation?: string | null; photo_count: number; }`
  - `export const emptyStudentInput: () => StudentInput`

- [ ] **Step 1: 编写类型定义测试用例**

创建 `tests/student-guardians-types.test.ts`：
```ts
import { describe, expect, it } from "vitest";
import { emptyStudentInput, type Guardian, type Student, type StudentInput } from "../src/types";

describe("Student and Guardian Types", () => {
  it("emptyStudentInput creates valid input with empty guardians array", () => {
    const input = emptyStudentInput();
    expect(input.gender).toBe("男");
    expect(input.guardians).toEqual([]);
    expect(input.name).toBe("");
  });

  it("supports student with multiple guardians", () => {
    const guardians: Guardian[] = [
      { name: "李建国", phone: "13800001111", relation: "父亲", is_primary: true },
      { name: "王秀英", phone: "13900002222", relation: "母亲", is_primary: false },
    ];
    const student: StudentInput = {
      name: "李小明",
      gender: "男",
      birth_date: "2017-05-01",
      student_no: "20230001",
      grade_class: "三年级一班",
      enroll_date: "2024-09-01",
      address: "测试住址",
      status: "active",
      note: null,
      guardians,
    };
    expect(student.guardians.length).toBe(2);
    expect(student.guardians[0].relation).toBe("父亲");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`rtk vitest run tests/student-guardians-types.test.ts`  
预期：FAIL，由于 `src/types/index.ts` 中尚未定义 `Guardian` 和更新 `Student` 结构。

- [ ] **Step 3: 更新 `src/types/index.ts`**

修改 `src/types/index.ts`：
```ts
export type Gender = "男" | "女";

export interface Guardian {
  id?: number;
  student_id?: number;
  name: string;
  phone: string;
  relation: string;
  is_primary?: boolean;
}

export interface Student {
  id: number;
  name: string;
  gender: Gender;
  birth_date: string | null;
  student_no: string;
  grade_class: string;
  enroll_date: string | null;
  address: string | null;
  status: string;
  note: string | null;
  guardians: Guardian[];
  created_at: string;
  updated_at: string;
}

export type StudentInput = Omit<Student, "id" | "created_at" | "updated_at">;

/** 列表行：额外带主联系人电话与一张图片计数 */
export interface StudentRow extends Student {
  primary_phone?: string | null;
  primary_relation?: string | null;
  photo_count: number;
}

export const emptyStudentInput = (): StudentInput => ({
  name: "",
  gender: "男",
  birth_date: null,
  student_no: "",
  grade_class: "",
  enroll_date: null,
  address: null,
  status: "active",
  note: null,
  guardians: [],
});
```

- [ ] **Step 4: 重新运行测试验证通过**

运行：`rtk vitest run tests/student-guardians-types.test.ts`  
预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add src/types/index.ts tests/student-guardians-types.test.ts
git commit -m "refactor: 重构学生类型支持性别枚举与多监护人实体"
```

---

### Task 2: SQLite 数据库迁移与 Rust 层初始化 (`src-tauri/src/lib.rs`)

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces:
  - SQLite Migration 4：新建 `guardians` 表，建立 `idx_guardians_student_id` 索引，外键级联删除。
  - 清理 Migration 1，将 `students` 表直接对齐为不含旧监护人冗余字段的纯净结构。

- [ ] **Step 1: 编写 SQLite Migration 4 与初始表定义**

在 `src-tauri/src/lib.rs` 的 `migrations()` 函数中：
```rust
  }, Migration {
    version: 4,
    description: "create_guardians_table",
    sql: r#"
      CREATE TABLE IF NOT EXISTS guardians (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        name       TEXT NOT NULL DEFAULT '',
        phone      TEXT NOT NULL DEFAULT '',
        relation   TEXT NOT NULL DEFAULT '监护人',
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_guardians_student_id ON guardians(student_id);
    "#,
    kind: MigrationKind::Up,
  }]
```

- [ ] **Step 2: 运行 `cargo check` 校验 Rust 代码**

运行：`rtk cargo check --manifest-path src-tauri/Cargo.toml`  
预期：PASS (0 warnings / errors)。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(db): 增加 guardians 子表数据库迁移与索引"
```

---

### Task 3: 数据访问层重构 (`src/lib/db.ts`)

**Files:**
- Modify: `src/lib/db.ts`
- Test: `tests/student-guardians-db.test.ts`

**Interfaces:**
- Consumes: `StudentInput`, `Student`, `Guardian`, `StudentRow` from `src/types/index.ts`
- Produces:
  - `listStudents(keyword?: string, gradeClass?: string): Promise<StudentRow[]>`
  - `getStudent(id: number): Promise<Student | null>`
  - `createStudent(input: StudentInput): Promise<number>`
  - `updateStudent(id: number, input: StudentInput): Promise<void>`
  - `deleteStudent(id: number): Promise<void>`

- [ ] **Step 1: 编写针对多监护人 CRUD 的单元测试**

创建 `tests/student-guardians-db.test.ts`：
```ts
import { describe, expect, it } from "vitest";
import { createStudent, deleteStudent, getStudent, listStudents, updateStudent } from "../src/lib/db";
import type { StudentInput } from "../src/types";

describe("db student guardians CRUD operations", () => {
  it("creates student with multiple guardians and retrieves them via getStudent", async () => {
    const input: StudentInput = {
      name: "多监护人测试生",
      gender: "女",
      birth_date: "2017-09-01",
      student_no: "GUARD_TEST_001",
      grade_class: "三年级一班",
      enroll_date: "2024-09-01",
      address: "杭州市西湖区",
      status: "active",
      note: "测试学生",
      guardians: [
        { name: "张三", phone: "13811112222", relation: "父亲", is_primary: true },
        { name: "李四", phone: "13933334444", relation: "母亲", is_primary: false },
      ],
    };

    const id = await createStudent(input);
    expect(id).toBeGreaterThan(0);

    try {
      const student = await getStudent(id);
      expect(student).not.toBeNull();
      expect(student?.name).toBe("多监护人测试生");
      expect(student?.gender).toBe("女");
      expect(student?.guardians.length).toBe(2);
      expect(student?.guardians[0].name).toBe("张三");
      expect(student?.guardians[0].relation).toBe("父亲");
      expect(student?.guardians[0].is_primary).toBe(true);
      expect(student?.guardians[1].name).toBe("李四");

      const rows = await listStudents("多监护人测试生");
      expect(rows.length).toBe(1);
      expect(rows[0].primary_phone).toBe("13811112222");
      expect(rows[0].primary_relation).toBe("父亲");
    } finally {
      await deleteStudent(id);
    }
  });

  it("updates student guardians properly by replacing existing guardians", async () => {
    const input: StudentInput = {
      name: "更名测试生",
      gender: "男",
      birth_date: "2017-01-01",
      student_no: "GUARD_TEST_002",
      grade_class: "三年级一班",
      enroll_date: "2024-09-01",
      address: null,
      status: "active",
      note: null,
      guardians: [
        { name: "原监护人", phone: "13500000000", relation: "监护人", is_primary: true },
      ],
    };
    const id = await createStudent(input);

    try {
      await updateStudent(id, {
        ...input,
        gender: "男",
        guardians: [
          { name: "新监护人A", phone: "13611111111", relation: "父亲", is_primary: true },
          { name: "新监护人B", phone: "13622222222", relation: "母亲", is_primary: false },
          { name: "新监护人C", phone: "13633333333", relation: "爷爷", is_primary: false },
        ],
      });

      const updated = await getStudent(id);
      expect(updated?.guardians.length).toBe(3);
      expect(updated?.guardians.map((g) => g.name)).toEqual(["新监护人A", "新监护人B", "新监护人C"]);
    } finally {
      await deleteStudent(id);
    }
  });

  it("cascades delete of guardians when student is deleted", async () => {
    const id = await createStudent({
      name: "待删学生",
      gender: "男",
      birth_date: "2017-01-01",
      student_no: "GUARD_TEST_003",
      grade_class: "",
      enroll_date: null,
      address: null,
      status: "active",
      note: null,
      guardians: [{ name: "待删监护人", phone: "13000000000", relation: "其他", is_primary: true }],
    });

    await deleteStudent(id);
    const notFound = await getStudent(id);
    expect(notFound).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`rtk vitest run tests/student-guardians-db.test.ts`  
预期：FAIL。

- [ ] **Step 3: 实现 `src/lib/db.ts` 中的内存与 SQLite 双轨监护人存取**

1. 更新 `MemoryStore`：
```ts
interface MemoryStore {
  students: Student[];
  photos: Photo[];
  classes: string[];
  guardians: Guardian[];
  nextStudentId: number;
  nextPhotoId: number;
  nextGuardianId: number;
}
```
2. 更新 `seedStore()`：
为示例学生生成父亲、母亲等多监护人数据。
3. 更新 `createStudent`：
先写学生，再将 `input.guardians` 遍历写入 `guardians`。
4. 更新 `updateStudent`：
更新学生基础字段，同时清理旧监护人并重新写入新的 `input.guardians`。
5. 更新 `getStudent`：
查询学生后查出该学生的全部监护人（按 `is_primary DESC, id ASC` 排序）。
6. 更新 `listStudents`：
在内存和 SQLite 中分别带出 `primary_phone` 与 `primary_relation`。
7. 更新 `deleteStudent`：
级联删除学生的 `guardians`。

- [ ] **Step 4: 运行测试验证通过**

运行：`rtk vitest run tests/student-guardians-db.test.ts`  
预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/db.ts tests/student-guardians-db.test.ts
git commit -m "feat(db): 数据访问层实现学生多监护人双轨 CRUD 与级联清理"
```

---

### Task 4: 学生表单编辑弹窗重构 (`src/components/StudentFormDialog.vue`)

**Files:**
- Modify: `src/components/StudentFormDialog.vue`
- Test: `tests/student-form-dialog.test.ts`

**Interfaces:**
- Consumes: `StudentInput`, `Guardian`, `Gender` from `src/types/index.ts`
- Props: `open: boolean; initial?: Partial<StudentInput> | null; title?: string;`
- Emits: `close: []; submit: [input: StudentInput];`

- [ ] **Step 1: 编写组件交互测试**

创建 `tests/student-form-dialog.test.ts`：
```ts
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StudentFormDialog from "../src/components/StudentFormDialog.vue";

describe("StudentFormDialog.vue", () => {
  it("renders gender segmented control with 男 and 女 options, defaulting to 男", async () => {
    const wrapper = mount(StudentFormDialog, {
      props: { open: true },
    });

    const genderBtns = wrapper.findAll("[data-test='gender-option']");
    expect(genderBtns.length).toBe(2);
    expect(genderBtns[0].text()).toBe("男");
    expect(genderBtns[1].text()).toBe("女");
    expect(genderBtns[0].classes()).toContain("bg-ink"); // selected
  });

  it("switches gender when clicking 女", async () => {
    const wrapper = mount(StudentFormDialog, {
      props: { open: true },
    });

    const genderBtns = wrapper.findAll("[data-test='gender-option']");
    await genderBtns[1].trigger("click");
    expect(genderBtns[1].classes()).toContain("bg-ink");
  });

  it("allows adding and removing guardians dynamically", async () => {
    const wrapper = mount(StudentFormDialog, {
      props: { open: true },
    });

    // Initial has at least 1 guardian row
    let rows = wrapper.findAll("[data-test='guardian-row']");
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // Click add guardian
    const addBtn = wrapper.get("[data-test='add-guardian-btn']");
    await addBtn.trigger("click");

    rows = wrapper.findAll("[data-test='guardian-row']");
    expect(rows.length).toBe(2);

    // Click remove on second guardian
    const removeBtns = wrapper.findAll("[data-test='remove-guardian-btn']");
    await removeBtns[1].trigger("click");

    rows = wrapper.findAll("[data-test='guardian-row']");
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`rtk vitest run tests/student-form-dialog.test.ts`  
预期：FAIL。

- [ ] **Step 3: 重构 `StudentFormDialog.vue`**

1. 将性别输入替换为 Segmented Control：
```html
<div class="space-y-1.5">
  <span class="text-fine text-weak">性别</span>
  <div class="flex h-9 rounded-sm border border-hairline bg-parchment p-0.5">
    <button
      type="button"
      data-test="gender-option"
      class="flex-1 rounded-sm text-caption font-medium transition-colors"
      :class="form.gender === '男' ? 'bg-ink text-canvas shadow-sm' : 'text-weak hover:text-ink'"
      @click="form.gender = '男'"
    >
      男
    </button>
    <button
      type="button"
      data-test="gender-option"
      class="flex-1 rounded-sm text-caption font-medium transition-colors"
      :class="form.gender === '女' ? 'bg-ink text-canvas shadow-sm' : 'text-weak hover:text-ink'"
      @click="form.gender = '女'"
    >
      女
    </button>
  </div>
</div>
```
2. 增加动态多监护人编辑模块（关系下拉/输入、姓名、联系电话、设为主联系人单选、删除按钮、+ 增加监护人按钮）。
3. 表单模型管理 `guardians: Guardian[]`，提交时进行数据清理并发出 `submit` 事件。

- [ ] **Step 4: 运行测试验证通过**

运行：`rtk vitest run tests/student-form-dialog.test.ts`  
预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add src/components/StudentFormDialog.vue tests/student-form-dialog.test.ts
git commit -m "feat(ui): 学生表单支持性别二选一与多监护人动态维护"
```

---

### Task 5: 学生详情页与列表展示适配 (`StudentDetailView.vue` & `StudentTable.vue`)

**Files:**
- Modify: `src/views/StudentDetailView.vue`
- Modify: `src/components/StudentTable.vue`
- Modify: `src/views/StudentsView.vue`

**Interfaces:**
- Consumes: `Student`, `StudentRow`, `Guardian`
- Displays:
  - `StudentDetailView.vue` 家长联系卡片展示全部监护人（称谓标签、姓名、电话、主联系人标识）。
  - `StudentTable.vue` 展示主联系人电话及称谓。

- [ ] **Step 1: 适配 `StudentDetailView.vue`**

在 `StudentDetailView.vue` 的「家长联系」卡片中：
```html
<AppCard>
  <h3 class="mb-2 text-body font-semibold text-ink">家长联系 ({{ student.guardians?.length ?? 0 }})</h3>
  <div v-if="student.guardians?.length" class="space-y-2.5">
    <div
      v-for="g in student.guardians"
      :key="g.name + g.phone"
      class="flex items-center justify-between border-b border-divider pb-2 last:border-b-0 last:pb-0"
    >
      <div class="flex items-center gap-2">
        <span class="rounded bg-parchment px-2 py-0.5 text-fine font-medium text-ink">
          {{ g.relation || '监护人' }}
        </span>
        <span class="text-caption font-medium text-ink">{{ g.name }}</span>
        <span v-if="g.is_primary" class="rounded-pill bg-primary-soft px-2 py-0.2 text-[11px] text-primary">
          主要
        </span>
      </div>
      <span class="text-caption text-muted">{{ g.phone || '—' }}</span>
    </div>
  </div>
  <p v-else class="py-2 text-fine text-weak">未登记监护人信息</p>
</AppCard>
```

- [ ] **Step 2: 适配 `StudentTable.vue`**

将联系电话列读取 `row.primary_phone`，并在有关系时展示轻量标签：
```html
<span class="text-muted">
  {{ row.primary_phone ?? "—" }}
  <span v-if="row.primary_relation" class="text-fine text-weak ml-1">
    ({{ row.primary_relation }})
  </span>
</span>
```

- [ ] **Step 3: 运行类型检查与现有视图测试**

运行：`rtk npm run typecheck`  
预期：PASS。

- [ ] **Step 4: 提交**

```bash
git add src/views/StudentDetailView.vue src/components/StudentTable.vue
git commit -m "feat(ui): 详情页展示多监护人卡片，列表呈现主联系人信息"
```

---

### Task 6: 关联模块适配与花名册导入兼容 (`roster.ts`, `student-ops.ts`)

**Files:**
- Modify: `src/lib/roster.ts`
- Modify: `src/agent/tools/student-ops.ts`
- Modify: `tests/smoke-roster.test.ts`
- Modify: `tests/agent-student-ops.test.ts`

**Interfaces:**
- Adapt:
  - `src/lib/roster.ts` 将解析出的监护人与电话构造成 `guardians: [{ name, phone, relation: '监护人', is_primary: true }]`。
  - `src/agent/tools/student-ops.ts` 工具支持创建/更新带监护人的学生。

- [ ] **Step 1: 适配 `src/lib/roster.ts`**

在表格导入记录生成处：
```ts
const gName = cellOf(cells, mapping.fields.guardian_name) || "";
const gPhone = cellOf(cells, mapping.fields.guardian_phone) || "";
const guardians: Guardian[] = (gName || gPhone)
  ? [{ name: gName, phone: gPhone, relation: "监护人", is_primary: true }]
  : [];
```

- [ ] **Step 2: 适配 `src/agent/tools/student-ops.ts`**

当 agent 传入 `guardian_name` / `guardian_phone` 时，自动映射并组装为 `guardians` 数组写入，保证智能助手操作无缝衔接。

- [ ] **Step 3: 适配已有受影响的测试用例并执行全量测试**

运行：
```bash
rtk npm run typecheck
rtk npm test
rtk cargo check --manifest-path src-tauri/Cargo.toml
```
预期：全部通过。

- [ ] **Step 4: 提交**

```bash
git add src/lib/roster.ts src/agent/tools/student-ops.ts tests/
git commit -m "feat: 适配花名册导入与 Agent 工具支持多监护人数据结构"
```

---

### Task 7: 整体回归复核与交付

- [ ] **Step 1: 全量执行自动化测试**

运行：`rtk npm test`，确认所有测试用例 100% 绿色通过。

- [ ] **Step 2: 构建与代码质量验证**

运行：`rtk npm run typecheck && rtk cargo check --manifest-path src-tauri/Cargo.toml`。

- [ ] **Step 3: 状态更新与交付总结**
