/**
 * Agent 评测黄金测试集 (Golden Eval Dataset)
 * 覆盖：页面跳转、数据查询、文档检索、安全确认门拦截、边界兜底等典型场景。
 */
import type { EvalCase } from "./types";

export const EVAL_DATASET: EvalCase[] = [
  // ==================== 1. 页面跳转 (Navigation) ====================
  {
    id: "nav-students",
    description: "跳转至学生档案/学生列表",
    category: "navigation",
    input: "帮我打开学生列表",
    expected: {
      tool: "navigate",
      args: { target: "students" },
    },
  },
  {
    id: "nav-home",
    description: "回到应用首页",
    category: "navigation",
    input: "回到首页看看",
    expected: {
      tool: "navigate",
      args: { target: "home" },
    },
  },
  {
    id: "nav-classes",
    description: "跳转至班级管理",
    category: "navigation",
    input: "跳转到班级管理",
    expected: {
      tool: "navigate",
      args: { target: "classes" },
    },
  },
  {
    id: "nav-settings",
    description: "跳转至数据与设置",
    category: "navigation",
    input: "打开数据与设置",
    expected: {
      tool: "navigate",
      args: { target: "settings" },
    },
  },
  {
    id: "nav-photos",
    description: "跳转至照片墙",
    category: "navigation",
    input: "看看照片墙",
    expected: {
      tool: "navigate",
      args: { target: "photos" },
    },
  },
  {
    id: "nav-profile",
    description: "跳转至教师个人资料",
    category: "navigation",
    input: "切换到教师个人资料",
    expected: {
      tool: "navigate",
      args: { target: "profile" },
    },
  },
  {
    id: "nav-design",
    description: "跳转至设计系统规范",
    category: "navigation",
    input: "打开设计系统",
    expected: {
      tool: "navigate",
      args: { target: "design" },
    },
  },

  // ==================== 2. 数据查询 (Data Query) ====================
  {
    id: "query-stats-count",
    description: "统计查询：学生人数",
    category: "data_query",
    input: "现在有多少个学生？",
    expected: {
      tool: "query_data",
      args: { entity: "stats" },
    },
  },
  {
    id: "query-stats-total",
    description: "统计查询：在读总数统计",
    category: "data_query",
    input: "统计一下学生总数和分布",
    expected: {
      tool: "query_data",
      args: { entity: "stats" },
    },
  },
  {
    id: "query-photos",
    description: "查询全部照片记录",
    category: "data_query",
    input: "查看全部照片",
    expected: {
      tool: "query_data",
      args: { entity: "photos" },
    },
  },
  {
    id: "query-student-name",
    description: "按姓名模糊查询具体学生",
    category: "data_query",
    input: "查一下林知远的资料",
    expected: {
      tool: "query_data",
      args: { entity: "students", keyword: "林知远" },
    },
  },
  {
    id: "query-student-quoted",
    description: "按引号精准提取学生姓名查询",
    category: "data_query",
    input: "找找学生“李雷”的信息",
    expected: {
      tool: "query_data",
      args: { entity: "students", keyword: "李雷" },
    },
  },
  {
    id: "query-student-list",
    description: "通用查询学生档案列表（泛词不提取为空名）",
    category: "data_query",
    input: "查询在读学生档案",
    expected: {
      tool: "query_data",
      args: { entity: "students" },
    },
  },

  // ==================== 3. 文档检索 (Docs Search) ====================
  {
    id: "docs-logging",
    description: "检索日志存储位置与规范",
    category: "docs_search",
    input: "日志文件在哪里，怎么排查",
    expected: {
      tool: "find_docs",
      args: (args) => typeof args.keywords === "string" && args.keywords.includes("日志"),
    },
  },
  {
    id: "docs-config",
    description: "检索模型与系统配置说明",
    category: "docs_search",
    input: "怎么配置 AI 模型的 API Key？",
    expected: {
      tool: "find_docs",
      args: (args) => typeof args.keywords === "string" && args.keywords.includes("配置"),
    },
  },
  {
    id: "docs-help",
    description: "检索系统帮助与使用指南",
    category: "docs_search",
    input: "系统的使用指南和说明文档",
    expected: {
      tool: "find_docs",
      args: (args) =>
        typeof args.keywords === "string" &&
        (args.keywords.includes("指南") || args.keywords.includes("说明") || args.keywords.includes("文档")),
    },
  },

  // ==================== 4. 操作拦截确认门 (Confirm Gate) ====================
  {
    id: "gate-clear-data-unconfirmed",
    description: "写操作未确认：应命中清空数据动作，并被安全确认门拦截",
    category: "confirm_gate",
    input: "清空全部数据",
    expected: {
      tool: "ui_action",
      args: { page: "settings", action: "clear-all-data" },
      shouldGate: true,
    },
  },
  {
    id: "gate-clear-data-confirmed",
    description: "写操作已确认：显式确认后携带 confirm:true，确认门放行",
    category: "confirm_gate",
    input: "确认清空全部数据",
    expected: {
      tool: "ui_action",
      args: { page: "settings", action: "clear-all-data", confirm: true },
      shouldGate: false,
    },
  },
  {
    id: "gate-create-student-action",
    description: "只读/安全操作：新建学生对话框动作无需阻断",
    category: "confirm_gate",
    input: "新建学生",
    expected: {
      tool: "ui_action",
      args: { page: "students", action: "create-student" },
      shouldGate: false,
    },
  },
  {
    id: "gate-import-roster-action",
    description: "安全操作：导入花名册打开对话框（对话框内完成导入，无需阻断）",
    category: "confirm_gate",
    input: "帮我导入学生花名册",
    expected: {
      tool: "ui_action",
      args: { page: "students", action: "import-roster" },
      shouldGate: false,
    },
  },

  // ==================== 5. 兜底与边界 (Fallback) ====================
  {
    id: "fallback-weather",
    description: "超出范围问答（天气）：不触发幻觉工具，返回演示态提示",
    category: "fallback",
    input: "今天天气怎么样？",
    expected: {
      tool: null,
      contentContains: ["演示态"],
    },
  },
  {
    id: "fallback-poem",
    description: "超出范围创作（写诗）：不触发幻觉工具，返回演示态提示",
    category: "fallback",
    input: "写一首春天的七言绝句",
    expected: {
      tool: null,
      contentContains: ["演示态"],
    },
  },
];
