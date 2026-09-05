# 班级管理导航联动、独立详情交互与数据组织优化设计

> 文档状态：已完成设计评审  
> 日期：2026-09-05  
> 目标：完善侧边栏导航闭环、实现班级卡片下钻班级详情页（展示本班学生条目与班级公共相册）、优化班级与照片数据组织，并严格统一全系统按钮风格规范。

---

## 1. 背景与现状问题

1. **侧边栏导航缺失与割裂**：
   - 首页「副屏」具有「班级管理」入口，但全局侧边栏菜单（`AppSidebar.vue`）中未注册「班级管理」项。
   - `App.vue` 中将 `classes` 路由归入 `fullBleed`，导致访问班级管理页时侧边栏被隐藏，阻断了在应用内快捷切换导航。
2. **跳转交互逻辑错误**：
   - 班级管理主页（`ClassesView.vue`）中，每个班级卡片直接链接到 `/students`（全局学生档案页），点击后跳出班级上下文，无法针对具体班级浏览其管辖的学生条目。
3. **数据组织与照片归属维度单一**：
   - 现有模型中照片只允许强绑定单个学生（`student_id NOT NULL`），无法直接承载「班级公共活动照片」（如班级合影、黑板报、班级运动会、集体荣誉等）；
   - 班级照片统计应当既包含班级公共照片，也涵盖班内各学生的个人归档照片。
4. **按钮设计规范未统一**：
   - 部分页面（如 `ClassesView.vue` 顶栏）混用了原生 `<button>` 样式与 `AppButton` 组件，存在尺寸、圆角、悬浮态不一致的问题，必须全量统一至 `AppButton` 规范体系。

---

## 2. 交互与信息架构设计

### 2.1 侧边栏与路由全局联动
* **侧边栏菜单注册（`src/components/AppSidebar.vue`）**：
  * 在一级导航中增加「班级管理」，项位于「首页」之后、「学生档案」之前：
    `首页 (/home)` → `班级管理 (/classes)` → `学生档案 (/students)` → `图片记录 (/photos)` → `设计系统 (/design)` → `数据与设置 (/settings)`。
  * 图标采用专有黑板/教学班级 SVG 图标。
  * 激活态高亮：当当前路由为 `/classes`（班级管理列表）或 `/classes/:name`（班级详情）时，侧边栏均高亮「班级管理」。
* **取消全屏限制（`src/App.vue`）**：
  * 将 `fullBleed` 限制收敛至 `route.name === 'home'`，使班级管理（列表及详情）始终在带侧边栏的标准视图框架中渲染。

### 2.2 路由配置（`src/router/index.ts`）
```ts
{
  path: "/classes",
  name: "classes",
  component: ClassesView,
},
{
  path: "/classes/:name",
  name: "class-detail",
  component: ClassDetailView,
  props: true,
}
```

### 2.3 页面交互流程

```
[首页 / 副屏] 
    └── 点击「班级管理」卡片
            ↓
    [班级管理列表页 (/classes)]
        ├── 顶栏：导入花名册按钮、新建班级按钮（统一 AppButton 样式）
        ├── 班级卡片网格（班级名、学生数、公共/个人照片细分统计）
        └── 点击任意班级卡片
                ↓
    [班级详情页 (/classes/:name)]
        ├── 顶部面包屑导航：「← 班级管理」返回链接 + 班级大标题 + 元数据胶囊
        ├── 快捷操作区：统一 AppButton
        │     ├── 「导入本班花名册」（预填并锁定本班级）
        │     ├── 「添加学生」（预填 grade_class）
        │     └── 「上传班级照片」（直接归入本班公共照片）
        ├── 概览指标卡（本班学生人数及男女比、班级照片数、档案更新时间）
        └── Tab 视图切换：
              ├── [Tab 1: 学生条目（默认）]
              │     ├── 班内实时搜索框（姓名 / 学号 / 监护人电话）
              │     ├── 本班学生表格（列：学号、姓名、性别、出生日期、监护人电话、照片数、更新时间、操作）
              │     └── 点击学生行 → 下钻到 `/students/:id` 学生成长档案（支持返回本班详情）
              └── [Tab 2: 班级相册]
                    ├── 筛选：全部照片 / 班级公共照片 / 学生个人照片
                    ├── 瀑布流/网格展示照片卡片（缩略图、说明、拍摄日期、归属标签）
                    └── 空状态与快速上传引导
```

---

## 3. 数据组织与底层接口设计

### 3.1 领域模型类型定义（`src/types/index.ts`）

```ts
export interface Photo {
  id: number;
  student_id: number | null;   // null 表示班级公共照片
  grade_class: string | null;  // 所属班级名称
  file_name: string;
  caption: string | null;
  taken_at: string | null;
  created_at: string;
}

export interface ClassSummary {
  name: string;              // 班级名称（如 "三年级二班"，或 "未分班"）
  studentCount: number;      // 本班学生总数
  maleCount: number;         // 男生人数
  femaleCount: number;       // 女生人数
  photoCount: number;        // 照片总数（公共照片 + 学生个人照片）
  classPhotoCount: number;   // 班级公共活动照片数
  studentPhotoCount: number; // 班内学生个人档案照片数
}
```

### 3.2 数据层查询与操作接口（`src/lib/db.ts`）

1. **`listClasses(): Promise<ClassSummary[]>`**
   - 提取全部学生和照片的班级属性，按班级名称聚合计算：
     - 学生总人数、男女人数；
     - 归属于该班级的公共照片数（`p.grade_class = ? AND p.student_id IS NULL`）；
     - 属于该班级学生的个人照片数（`p.student_id IN (SELECT id FROM students WHERE grade_class = ?)`）；
     - 两者求和得出 `photoCount`；
   - 按照中文 locale 字典序排序；学生未填班级信息的统一归档至「未分班」。
2. **`getClassSummary(name: string): Promise<ClassSummary | null>`**
   - 单独读取并返回指定班级的详细统计指标。
3. **`listStudents(keyword?: string, gradeClass?: string): Promise<StudentRow[]>`**
   - 增加可选参数 `gradeClass`：
     - 若传入 `"未分班"`：匹配 `s.grade_class IS NULL OR s.grade_class = ''`；
     - 若传入具体班级名：精确匹配 `s.grade_class = ?`；
     - 配合 `keyword` 关键词检索，返回该班符合条件的全部学生条目。
4. **`listPhotosByClass(className: string, filterType: 'all' | 'public' | 'student' = 'all'): Promise<Photo[]>`**
   - 查询该班级全部相关照片或按类型（仅公共 / 仅学生个人）过滤，按最新拍摄/录入时间降序返回。
5. **`addClassPhoto(className: string, fileName: string, caption?: string | null, takenAt?: string | null): Promise<number>`**
   - 录入班级公共照片（`student_id = null`, `grade_class = className`）。

### 3.3 存储与 SQLite 迁移适配

* **Tauri 本地数据库迁移**：
  * 在 `src-tauri/src/lib.rs` 中增加迁移项版本 2：
    - 在 `photos` 表中添加 `grade_class TEXT`；
    - 兼容老数据库中已有的学生照片与公共照片查询。
* **浏览器演示内存模式（MemoryStore）**：
  * 同步更新 `seedStore()`，补充班级公共照片种子数据（如运动会班级合影 `demo-class-1.jpg`，`student_id: null, grade_class: "三年级二班"`）；
  * 内存中的 `listClasses`, `listStudents`, `listPhotosByClass` 与 SQLite 行为完全保持一致。

---

## 4. UI 视觉与按钮规范统一

* **全量统一使用 `AppButton`（`src/components/ui/AppButton.vue`）**：
  * 主动作按钮（如「新建班级」、「新建学生」、「上传照片」）：统一采用 `variant="primary"`（圆角 pill，高度 `h-9`，主色背景高亮）；
  * 次动作按钮（如「导入花名册」、「导入本班花名册」）：统一采用 `variant="secondary"`（圆角 pill，高度 `h-9`，主色边框）；
  * 危险动作按钮（如「删除」）：采用 `variant="danger"`；
  * 辅助按钮：采用 `variant="pearl"`；
  * 严禁在页面内编写行内自定义内边距、自定义圆角、自定义颜色的原生 `<button>`，彻底消除视觉杂音与样式冲突。

---

## 5. 测试与自检计划

1. **单元测试与集成测试**：
   - 编写 `tests/class-detail.test.ts`：测试 `listClasses` 班级聚合逻辑、`listStudents(keyword, gradeClass)` 班级过滤逻辑、`listPhotosByClass` 公共与个人照片聚合；
   - 更新现有 `tests/home-view.test.ts` 与路由测试，确保新路由与侧边栏激活逻辑正确；
   - 验证花名册导入在班级详情中的预填联动。
2. **代码质量与运行验证**：
   - 执行 `npm run typecheck` 保证 TypeScript 类型无报错；
   - 执行 `npm test` 保证所有既有测试（24 test files）及新增测试全部通过；
   - 若改动 Rust 代码，执行 `cargo check --manifest-path src-tauri/Cargo.toml` 验证编译。
