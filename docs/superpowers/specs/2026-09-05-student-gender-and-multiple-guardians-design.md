# 学生档案性别选择与多监护人支持重构设计

> 文档状态：设计完成，待评审  
> 日期：2026-09-05  
> 目标：学生档案编辑支持性别「男 / 女」二选一单选交互；底层数据库与数据模型彻底重构支持多监护人（1:N），消除字段冗余；更新编辑弹窗、详情页与列表呈现。

---

## 1. 背景与目标

当前学生档案系统在人员信息维护中存在两个明显的交互与数据限制：
1. **性别输入为自由文本输入框**：用户需要手动输入「男」或「女」，既不便捷又缺乏枚举约束，存在输入不一致的风险。
2. **仅支持单监护人且字段平铺在学生表**：原设计在 `students` 表直接记录 `guardian_name` 和 `guardian_phone`，无法承载真实教学场景中双家长（父亲、母亲）或隔代监护人（祖父母、外祖父母）的多联系人管理需求。

由于本项目处于核心开发阶段，用户明确指示**无需保留历史包袱，现有数据可直接重构并清空**。本方案从数据库范式、业务领域模型到前端 UI 进行自底向上的规范化重构。

---

## 2. 数据库与数据架构重构

### 2.1 实体关系模型（ERD）

```
+--------------------+           +------------------------+
|      students      | 1       N |       guardians        |
+--------------------+-----------+------------------------+
| id (PK)            |           | id (PK)                |
| name               |           | student_id (FK CASCADE)|
| gender ('男'/'女') |           | name                   |
| birth_date         |           | phone                  |
| student_no         |           | relation (关系称谓)   |
| grade_class        |           | is_primary (主要联系人)|
| enroll_date        |           | created_at             |
| address            |           +------------------------+
| status             |
| note               |
| created_at         |
| updated_at         |
+--------------------+
```

### 2.2 SQLite 表结构（`src-tauri/src/lib.rs`）

在 SQLite 初始化中重构建表：
```sql
CREATE TABLE IF NOT EXISTS students (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL DEFAULT '',
  gender      TEXT NOT NULL DEFAULT '男',
  birth_date  TEXT,
  student_no  TEXT NOT NULL UNIQUE,
  grade_class TEXT NOT NULL DEFAULT '',
  enroll_date TEXT,
  address     TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS guardians (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  relation    TEXT NOT NULL DEFAULT '监护人',
  is_primary  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_guardians_student_id ON guardians(student_id);
```

### 2.3 前端 TypeScript 类型定义（`src/types/index.ts`）

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

export interface StudentRow extends Student {
  primary_phone?: string | null;
  primary_relation?: string | null;
  photo_count: number;
}
```

---

## 3. 前端交互与视觉设计

### 3.1 性别选择器交互（`src/components/StudentFormDialog.vue`）
- 替换原有 `<AppInput v-model="form.gender" />` 为**二选一分段单选按钮组**。
- 选项：`男` 与 `女`。
- 样式遵循设计系统规范：
  - 选中态：`bg-ink text-canvas font-medium shadow-sm`。
  - 未选态：`bg-canvas border border-hairline text-weak hover:text-ink hover:bg-pearl`。
  - 默认值：若初始值为空则默认选中「男」。

### 3.2 多监护人动态编辑卡片（`src/components/StudentFormDialog.vue`）
- 将原有的单行监护人输入框，扩展为独立的**监护人列表模块**。
- 每条监护人包含：
  - **关系/称谓**：预设常用快捷选项（`父亲`、`母亲`、`爷爷`、`奶奶`、`外公`、`外婆`、`监护人`）及自定义输入。
  - **姓名**：必填输入框。
  - **联系电话**：手机/电话输入框。
  - **主要联系人单选/高亮**：首位默认为主联系人，支持勾选切换。
  - **删除操作**：每行右侧提供删除图标按钮（当存在多位时可移除）。
- 模块底部提供「`+ 增加监护人`」按钮，支持无限制追加。

### 3.3 学生详情页展示（`src/views/StudentDetailView.vue`）
- 在「家长联系」卡片中，遍历展示全部已登记的监护人：
  - 每一行展示：`关系徽标（如 [父亲]）+ 姓名 + 联系电话`。
  - 若标注为主联系人，在后方辅以 `主要联系` 徽标。
- 若无监护人信息，展示优雅的空占位态「未登记监护人」。

### 3.4 学生列表与花名册（`src/components/StudentTable.vue`）
- 表格的「联系电话」列直接读取 `primary_phone`，并可气泡或副文本展示主联系人关系（例如 `138xxxx (父亲)`），兼顾一览性。

---

## 4. 数据访问层（`src/lib/db.ts`）实现设计

1. **内存兜底（`MemoryStore`）**：
   - 增加 `guardians: Guardian[]` 集合与 `nextGuardianId` 自增序列。
   - `seedStore()` 生成内置学生示例数据时，为每位学生配置 1~2 位监护人（如父亲与母亲）。
2. **学生创建（`createStudent`）**：
   - 写入 `students` 表后取得 `student_id`。
   - 批量将 `input.guardians` 插入 `guardians` 表（关联 `student_id`，并设置 `is_primary`）。
3. **学生更新（`updateStudent`）**：
   - 更新 `students` 表基本信息。
   - 先清理当前学生原有关联监护人：`DELETE FROM guardians WHERE student_id = ?`。
   - 重新批量插入传入的 `input.guardians`。
4. **学生删除（`deleteStudent`）**：
   - SQLite 外键级联删除监护人；内存模式同步过滤删除。
5. **学生详情获取（`getStudent`）**：
   - 查询学生基本字段，并联查 `guardians` 数组绑定至学生实体返回。
6. **学生列表获取（`listStudents`）**：
   - 子查询或左连接获取主要监护人电话 `primary_phone` 与关系 `primary_relation`。
7. **花名册导入适配（`src/lib/roster.ts`）**：
   - 解析表格中导入的监护人与电话，自动构造成 `guardians: [{ name, phone, relation: '监护人', is_primary: true }]`。
8. **Agent 工具适配（`src/agent/tools/student-ops.ts`）**：
   - 对应参数适配支持传递监护人列表或快捷监护人字段。

---

## 5. 测试与验证策略

1. **数据层测试（`tests/class-data.test.ts` 或新增 `tests/student-guardians.test.ts`）**：
   - 测试创建带多位监护人（父亲、母亲）的学生，验证 `getStudent` 完整还原监护人列表。
   - 测试更新学生监护人（增加、修改称谓、删除），验证数据同步更新。
   - 测试删除学生时监护人级联删除。
   - 测试 `listStudents` 正确携带 `primary_phone`。
2. **组件渲染与交互测试（`tests/student-form-dialog.test.ts`）**：
   - 测试性别选择器支持二选一点击切换，默认「男」。
   - 测试点击「增加监护人」动态追加输入行。
   - 测试删除监护人行功能。
   - 测试保存提交的数据结构包含 `guardians` 数组。
3. **全局回归与标准验证**：
   - `npm run typecheck`
   - `npm test`
   - `cargo check --manifest-path src-tauri/Cargo.toml`
