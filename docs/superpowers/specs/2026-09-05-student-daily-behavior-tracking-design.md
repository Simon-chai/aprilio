# 学生日常表现快速记录与多维数据范式设计

> 文档状态：设计完成，待评审  
> 日期：2026-09-05  
> 目标：在学生列表页为每位学生提供轻量快捷操作卡片，支持老师手动快速（2~3秒内）记录日常表现；底层建立规范的元数据字典与事实流水三层数据范式，涵盖学习（作业、单元测试/期中期末成绩）与行为（课堂表现、劳动情况）等维度，并支持未来任意种类事项的零代码扩展；实现“高频常用评语自学习”与“AI 动态推荐评语”双引擎提速。

---

## 1. 背景与业务痛点

在班级日常管理中，记录学生的日常表现（作业质量、测验反馈、课堂纪律与互动、劳动值日等）是一线教师极其高频但又容易因流程繁重而被搁置的操作。
当前系统的痛点在于：
1. **缺乏日常表现的数据追踪**：系统只有基础档案与相册，没有记录学生每天具体表现的流水与评价体系。
2. **记录操作路径长、门槛高**：如果每次记录都要进入详情页、打开繁重的大弹窗并手动打长文本，老师课间仅有的 2~3 分钟根本无法完成多个学生的记录。
3. **不同事项数据维度难以统一**：作业、考试、纪律、劳动等事项各有特点，如果为每种事项独立建表或平铺字段，不仅难以横向聚合统计，后续新增“体育健康”、“社团活动”等事项时也面临高昂的重构成本。
4. **评语输入繁重且单调**：完全靠老师手打效率低，单纯靠固定选项又无法体现个性化教学反馈。

因此，本设计旨在构建一个**“高度规范的数据范式”**与**“极致敏捷的快捷交互”**相结合的日常表现记录体系。

---

## 2. 数据架构与维护范式（Data Paradigm & Maintenance Schema）

### 2.1 整体架构：三层关系范式

为了兼顾高扩展性与极速录入，采用**元数据字典层 + 事实流水层 + 评语知识沉淀层**的三层范式：

```
+-------------------------------------------------------------+
|                      1. 维度字典表                          |
|                  behavior_dimensions                        |
|  (元数据驱动：大分类 category + 指标维度 code/name，任意扩展)   |
+-------------------------------------------------------------+
            │ 1                                  │ 1
            │ N                                  │ N
            ▼                                    ▼
+------------------------------------+  +-------------------------------------+
|        2. 表现事实流水表            |  |          3. 评语沉淀知识库           |
|     student_behavior_records       |  |      behavior_comment_presets       |
| (学生行为流水事件：事实、快照、时间戳) |  | (高频词自沉淀 + AI 语料池 + 使用频率) |
+------------------------------------+  +-------------------------------------+
```

### 2.2 数据表详细定义（SQLite & Tauri Migrations）

在 `src-tauri/src/lib.rs` 中追加新 Migration 版本（例如 Migration version 5）：

#### (1) 维度元数据字典表 (`behavior_dimensions`)
用于集中维护全校或全班的表现评价维度。未来新增任意事项（如“体育健康”、“考勤纪律”），仅需插入一条记录，零表结构变更、零代码破坏。

```sql
CREATE TABLE IF NOT EXISTS behavior_dimensions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL DEFAULT 'study', -- 大类：'study' (学习) | 'behavior' (行为) | 'other' (扩展)
  code        TEXT NOT NULL UNIQUE,          -- 唯一标识码：如 'homework', 'exam', 'classroom', 'labor'
  name        TEXT NOT NULL,                 -- 显示名称：如 '作业情况', '单元/期中期末成绩', '课堂表现', '劳动情况'
  icon        TEXT,                          -- 图标标识（Lucide 图标名）
  sort_order  INTEGER NOT NULL DEFAULT 0,    -- 排序号
  is_system   INTEGER NOT NULL DEFAULT 1,    -- 1=系统预置（不可删），0=用户自定义扩展
  is_active   INTEGER NOT NULL DEFAULT 1,    -- 是否启用 (1=启用, 0=停用)
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 初始系统预置种子数据
INSERT OR IGNORE INTO behavior_dimensions (id, category, code, name, icon, sort_order, is_system) VALUES
  (1, 'study',    'homework',  '作业情况',         'BookOpen',     1, 1),
  (2, 'study',    'exam',      '单元/期中期末成绩', 'GraduationCap', 2, 1),
  (3, 'behavior', 'classroom', '课堂表现',         'MessageSquare', 3, 1),
  (4, 'behavior', 'labor',     '劳动情况',         'Sparkles',      4, 1);
```

#### (2) 表现事实流水表 (`student_behavior_records`)
以事件事实为中心的时间序列记录表，承载每次日常记录的落地。

```sql
CREATE TABLE IF NOT EXISTS student_behavior_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id          INTEGER NOT NULL,                -- 关联学生 ID
  dimension_id        INTEGER NOT NULL,                -- 关联维度 ID
  dimension_name_snap TEXT NOT NULL,                   -- 维度名称快照（防字典更名导致历史显示异常）
  category_snap       TEXT NOT NULL,                   -- 大分类快照 ('study' | 'behavior')
  type                TEXT NOT NULL DEFAULT 'praise',  -- 评价倾向：'praise' (表扬 👍) | 'improve' (待改进 ⚠️)
  comment             TEXT NOT NULL,                   -- 评语内容正文
  recorded_date       TEXT NOT NULL,                   -- 业务发生日期 (YYYY-MM-DD)，默认当天
  created_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (dimension_id) REFERENCES behavior_dimensions(id)
);

-- 核心索引配置
CREATE INDEX IF NOT EXISTS idx_behavior_student_date ON student_behavior_records(student_id, recorded_date);
CREATE INDEX IF NOT EXISTS idx_behavior_recorded_date ON student_behavior_records(recorded_date);
CREATE INDEX IF NOT EXISTS idx_behavior_dimension ON student_behavior_records(dimension_id);
```

#### (3) 评语知识沉淀与高频词库表 (`behavior_comment_presets`)
实现“历史常用评语自学习分析”与“AI 推荐上下文”的核心支撑。

```sql
CREATE TABLE IF NOT EXISTS behavior_comment_presets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dimension_id INTEGER NOT NULL,                -- 归属维度 ID
  type         TEXT NOT NULL DEFAULT 'praise',  -- 倾向：'praise' | 'improve'
  content      TEXT NOT NULL,                   -- 评语正文
  use_count    INTEGER NOT NULL DEFAULT 1,      -- 累计被使用次数（高频分析核心）
  source       TEXT NOT NULL DEFAULT 'system',  -- 'system'(预置) | 'history'(历史输入自动沉淀) | 'ai'(AI生成采纳)
  last_used_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (dimension_id) REFERENCES behavior_dimensions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comment_presets_dim_type ON behavior_comment_presets(dimension_id, type, use_count DESC);
```

**预置种子评语样例**：
- **作业情况 + 表扬**：“书写工整规范，解题步骤完整清晰”、“按时独立完成作业，正确率极高”
- **作业情况 + 待改进**：“作业未按时提交，需及时补交”、“错题漏题较多，未进行及时订正”
- **单元/期中期末成绩 + 表扬**：“测试成绩名列前茅，基础扎实知识掌握牢固”、“较上次有显著进步，难题突破能力提升”
- **单元/期中期末成绩 + 待改进**：“基础计算失误较多，需加强审题与验算习惯”、“重点知识点有脱节，需针对性复习补漏”
- **课堂表现 + 表扬**：“课堂听讲专注，积极举手发言发表独到见解”、“互动热烈，能主动带动小组讨论探索”
- **课堂表现 + 待改进**：“课堂听讲容易走神，需要老师多次提醒注意集中”、“自控力较弱，有做小动作或讲话现象”
- **劳动情况 + 表扬**：“主动承担卫生大扫除，擦黑板和整理卫生角非常细致”、“值日尽职尽责，主动帮助其他同学整理桌椅”
- **劳动情况 + 待改进**：“值日敷衍草率，未完成清洁任务提前离开”、“缺乏公共卫生意识，桌面及周围杂物未整理”

---

## 3. 常用评语自分析与 AI 智能推荐机制

### 3.1 闭环自学习工作流（Self-learning Loop）

```
老师在快捷卡片输入或确认评语并保存
                  │
                  ▼
   student_behavior_records 插入流水记录
                  │
                  ▼
   检查 behavior_comment_presets 是否存在 (dimension_id, type, content)
        /                                   \
   [已存在]                               [不存在]
      │                                       │
更新该条记录:                           插入新词条:
use_count = use_count + 1              source = 'history'
last_used_at = now                     use_count = 1
```

每次打开卡片时，查询 `use_count DESC` 的前 4 条记录作为「常用评语」，随着老师日常使用，界面会自动变得越来越懂老师的表达习惯。

### 3.2 AI 智能动态推荐策略

当卡片切换维度或倾向时：
1. **输入上下文**：当前学生姓名、维度（如“课堂表现”）、倾向（如“表扬”）、该维度历史高频词。
2. **轻量推理**：系统调用内置 AI 模块（或轻量 Prompt），生成 2 条富有场景感、措辞得体的短语（不超过 25 个字）。
3. **无缝呈现**：AI 推荐以紫色微光气泡呈现，点击直接填入编辑框。若老师采纳了 AI 推荐并保存，该评语沉淀为 `source = 'ai'` 并计入高频词库。

---

## 4. 前端 TypeScript 领域模型（`src/types/index.ts`）

```ts
export type BehaviorCategory = 'study' | 'behavior' | 'other';
export type BehaviorPolarity = 'praise' | 'improve'; // 表扬 👍 | 待改进 ⚠️

export interface BehaviorDimension {
  id: number;
  category: BehaviorCategory;
  code: string;
  name: string;
  icon?: string | null;
  sort_order: number;
  is_system: number;
  is_active: number;
}

export interface StudentBehaviorRecord {
  id: number;
  student_id: number;
  dimension_id: number;
  dimension_name_snap: string;
  category_snap: string;
  type: BehaviorPolarity;
  comment: string;
  recorded_date: string;
  created_at: string;
}

export interface BehaviorInput {
  student_id: number;
  dimension_id: number;
  dimension_name_snap: string;
  category_snap: string;
  type: BehaviorPolarity;
  comment: string;
  recorded_date: string;
}

export interface CommentPreset {
  id: number;
  dimension_id: number;
  type: BehaviorPolarity;
  content: string;
  use_count: number;
  source: 'system' | 'history' | 'ai';
}
```

---

## 5. 学生列表页 UI 与快捷卡片交互设计规范

### 5.1 列表页触发入口（`StudentTable.vue`）

原表格操作列：
```html
<span class="text-primary">查看</span>
```

升级为双操作单元，保持优雅紧凑：
```html
<div class="flex items-center gap-3" @click.stop>
  <button
    class="rounded-full bg-primary-soft px-3 py-1 text-fine font-medium text-primary transition-colors hover:bg-primary hover:text-white"
    @click="openQuickBehavior(row, $event)"
  >
    + 记表现
  </button>
  <span class="cursor-pointer text-weak hover:text-ink" @click="emit('open', row)">
    查看
  </span>
</div>
```
- **关键设计**：`@click.stop` 阻断事件冒泡，防止触发整行点击跳转详情页。

### 5.2 快捷卡片组件（`QuickBehaviorPopover.vue`）原型规范

卡片尺寸：固定宽度 `460px`，轻量浮层设计，带柔和投影与发丝边框。

#### 卡片布局结构

```text
┌─────────────────────────────────────────────────────────────┐
│ 为「陈嘉树」记录日常表现            [ 2026-09-05 ▼ ]  [ ✕ ] │
├─────────────────────────────────────────────────────────────┤
│ 事项维度                                                    │
│ 学习类:  [ 作业情况 ]   [ 单元/期中期末成绩 ]                │
│ 行为类:  [ 课堂表现 ●]  [ 劳动情况 ]           [ + 自定义 ]  │
│                                                             │
│ 评价倾向                                                    │
│ [ 👍 表扬 (活跃) ]              [ ⚠️ 待改进 ]                │
├─────────────────────────────────────────────────────────────┤
│ 推荐评语 (点击填入)                                          │
│ [ ✨ AI: 听讲专注，能主动就疑难点举手质询 ]                 │
│ [ ✨ AI: 积极参与课堂研讨，带动同桌思考   ]                 │
│ [ 🕒 常用: 积极举手发言 ]  [ 🕒 常用: 课堂互动表现优异 ]     │
├─────────────────────────────────────────────────────────────┤
│ 评语正文                                                    │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 课堂听讲专注，能主动就疑难点举手质询。                  │ │
│ └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│ 提示: 按 Enter 快速保存              [保存并记下一条] [ 保存 ]│
└─────────────────────────────────────────────────────────────┘
```

#### 状态与动效规范
1. **维度切换**：
   - 学习类胶囊与行为类胶囊以柔和灰底呈现，选中态背景变为 `--color-tile` (深灰黑底，白字) 或 `--color-primary` (经典蓝)，清爽干脆。
2. **倾向切换**：
   - `👍 表扬`：激活时为柔和浅绿背景 (`#e8f5e9`) + 深绿文本 (`#248a3d`)。
   - `⚠️ 待改进`：激活时为柔和浅橙红背景 (`#fff3e0` / `#fdeef0`) + 醒目警示文本 (`#d70015` / `#d97706`)。
   - 切换倾向时，下方「推荐评语」实时根据倾向刷新为正向表扬或改进提醒。
3. **气泡点击注入**：
   - 点击气泡，文本以微透明淡入方式注入多行输入框，光标自动移动至末尾，方便老师直接追加科目（如“数学课上……”）或分值。
4. **极速保存逻辑（2~3 秒闭环）**：
   - 键盘按下 `Enter`（且非 Shift+Enter 换行）或点击 `[保存]`：
     1. 校验输入内容非空；
     2. 异步入库并更新评语沉淀表；
     3. 悬浮卡片以轻微缩放淡出（150ms）；
     4. 列表顶部弹出微型轻量 Toast：“已记录 陈嘉树 课堂表现”；
     5. 整个交互在原地完成，无任何白屏、跳页或布局抖动。
5. **连贯记录（保存并记下一条）**：
   - 适合连记多项表现。点击后保存当前项，输入框清空，维度保持或切至默认，卡片不关闭，便于立即输入下一条。

---

## 6. 异常边界与健壮性保障

1. **评语为空拦截**：若老师未填入评语且未点击气泡直接提交，输入框轻微抖动并提示“请输入或选择评语”。
2. **离线与内存兜底（Web Dev & Tauri）**：
   - 遵循项目一贯约定：在 Tauri 环境走真实 SQLite 数据库持久化；
   - 在浏览器纯前端模式（`isTauri() === false`）下，在 `MemoryStore` 中维护 `behavior_dimensions`、`student_behavior_records` 与 `behavior_comment_presets` 的内存 Mock，确保脱离桌面外壳也能完整预览与单元测试。
3. **外键级联安全**：学生记录被删除时，外键触发 `ON DELETE CASCADE`，自动清除对应表现事实与关联数据，避免孤儿数据沉淀。
4. **日期越界保护**：日期选择控件默认锁定为当天，允许老师补录最近两周以内的历史表现，但禁止录入未来日期。

---

## 7. 验收标准与验证方案

1. **维度维护与扩展验证**：
   - 系统内置预置 4 项维度：学习类（作业、测验成绩）、行为类（课堂表现、劳动）；
   - 数据库元数据查询正确，未来支持无缝插入第 5、第 6 类维度。
2. **列表页快捷卡片体验验证**：
   - 点击表格每行「+ 记表现」精准弹出卡片，不触发详情页跳转；
   - 气泡点选 1 次即可填入评语；
   - 回车直接保存并关闭卡片，保存总时长控制在 2 秒内。
3. **自学习沉淀验证**：
   - 多次输入相同评语后，该评语的 `use_count` 正确累加，并提升至「常用」列表首位。
4. **工程门禁与类型检查**：
   - `npm run typecheck` 零 TypeScript 错误；
   - `npm test` 单元测试通过；
   - Rust 后端 `cargo check --manifest-path src-tauri/Cargo.toml` 编译通过。
