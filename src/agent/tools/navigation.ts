/**
 * 工具：navigate —— 页面跳转（声明式注册，default export 即被容器装载）。
 *
 * NAV_TARGETS 是「应用界面注册表」：Agent 可达页面的唯一清单。
 * 页面级条目（无 resolve）直接 push；实体级条目（带 resolve）先把口语化标识
 * 查库校验并解析成路由参数再跳转——「打开三年二班的详情」即直达详情页，
 * 不再要求用户手点卡片。以后新增页面/实体页面，在这里登记一行即可被 Agent 感知。
 */
import { getStudent, listClasses } from "../../lib/db";
import type { ClassSummary } from "../../types";
import { defineAgentTool } from "../define";
import type { ToolDefinition } from "../types";

/** 实体条目解析结果：路由参数 + 展示用页面标题 */
export interface NavResolution {
  params: Record<string, string>;
  label: string;
}

export interface NavTarget {
  key: string;
  routeName: string;
  label: string;
  description: string;
  /**
   * 实体页面的参数解析：把 Agent 传来的口语化标识查库校验后转成路由参数。
   * 校验失败直接抛 Error，由 execute 收敛为失败的 ToolResult 回喂模型。
   */
  resolve?: (args: Record<string, unknown>) => Promise<NavResolution>;
  /** 实体条目的入参声明（合并进 navigate 工具参数 Schema） */
  paramProperties?: ToolDefinition["parameters"]["properties"];
}

/** 中文数字 → 阿拉伯数字（班级名口语归一用） */
const CN_DIGITS: Record<string, string> = {
  零: "0",
  一: "1",
  二: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  七: "7",
  八: "8",
  九: "9",
  十: "10",
};

/**
 * 班级名归一：「三年级二班」「三年2班」「3 年 2 班」都落成 3年2班，
 * 宽容口语里「级」的省略与中文/阿拉伯数字混用。
 */
export function normalizeClassName(raw: string): string {
  let out = "";
  for (const ch of raw.replace(/\s+/g, "")) out += CN_DIGITS[ch] ?? ch;
  return out.replace(/年级/g, "年").replace(/级/g, "");
}

export interface ClassNameHit {
  name: string;
  archived: boolean;
}

/**
 * 班级名 → 班级：精确匹配 → 归一匹配 → 包含匹配，逐级放宽；
 * 每级都优先在用班（归档班可能与在用班同名）。多个候选拋错列出来让模型反问用户，
 * 零候选拋错提示确认名称。
 */
export async function resolveClassName(input: string): Promise<ClassNameHit> {
  const classes = await listClasses();
  const wanted = normalizeClassName(input);
  const preferInUse = (hits: ClassSummary[]) => {
    const inUse = hits.filter((c) => !c.archived_at);
    return inUse.length ? inUse : hits;
  };
  const stages: ClassSummary[][] = [
    classes.filter((c) => c.name === input),
    classes.filter((c) => normalizeClassName(c.name) === wanted),
    classes.filter((c) => {
      const n = normalizeClassName(c.name);
      return n !== wanted && (n.includes(wanted) || wanted.includes(n));
    }),
  ];
  for (const hits of stages) {
    if (!hits.length) continue;
    const candidates = preferInUse(hits);
    if (candidates.length === 1) {
      return { name: candidates[0].name, archived: Boolean(candidates[0].archived_at) };
    }
    throw new Error(`「${input}」匹配到多个班级：${candidates.map((c) => c.name).join("、")}，请说明是哪一个。`);
  }
  throw new Error(`找不到班级「${input}」，可先到班级管理页确认名称（或先导入花名册建档）。`);
}

/** Agent 可跳转的页面注册表（实体条目带 resolve，需要对应入参） */
export const NAV_TARGETS: NavTarget[] = [
  { key: "home", routeName: "home", label: "首页", description: "教师个性展示与应用入口" },
  { key: "classes", routeName: "classes", label: "班级管理", description: "按班级浏览与组织学生：学生列表、搜索、新增与花名册导入" },
  { key: "photos", routeName: "photos", label: "照片墙", description: "全部照片记录" },
  { key: "timetable", routeName: "timetable", label: "我的课表", description: "按科目聚合的个人任课课表（不绑教师名）" },
  { key: "recycle-bin", routeName: "recycle-bin", label: "回收站", description: "已删除数据的暂存区，保留 7 天可恢复" },
  { key: "profile", routeName: "profile", label: "个人资料", description: "教师姓名、格言、头像与大图" },
  { key: "settings", routeName: "settings", label: "数据与设置", description: "AI 模型配置与数据管理" },
  {
    key: "class-detail",
    routeName: "class-detail",
    label: "班级详情",
    description: "某个班级的详情页：学生名单、照片、日常表现与考试成绩；跳转需提供 class_name（班级名）",
    paramProperties: {
      class_name: {
        type: "string",
        description: "班级名，如「三年级二班」（口语「三年二班」也可识别），仅 target=class-detail 时必填",
      },
    },
    async resolve(args) {
      const className = String(args.class_name ?? "").trim();
      if (!className) {
        throw new Error("缺少 class_name（班级名），无法打开班级详情。");
      }
      const hit = await resolveClassName(className);
      return { params: { name: hit.name }, label: `班级详情 · ${hit.name}` };
    },
  },
  {
    key: "student-detail",
    routeName: "student-detail",
    label: "学生详情",
    description: "某个学生的档案详情页：基本信息、日常表现与成绩；跳转需提供 student_id",
    paramProperties: {
      student_id: { type: "number", description: "学生 ID，仅 target=student-detail 时必填" },
    },
    async resolve(args) {
      const id = Number(args.student_id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("缺少有效的 student_id，无法打开学生详情。");
      }
      const student = await getStudent(id);
      if (!student) {
        throw new Error(`找不到 ID 为 ${id} 的学生。`);
      }
      return { params: { id: String(id) }, label: `学生档案 · ${student.name}` };
    },
  },
];

/** navigate 工具参数：枚举取自注册表，实体条目的入参合并进 properties */
const NAV_PARAMETERS: ToolDefinition["parameters"] = (() => {
  const properties: ToolDefinition["parameters"]["properties"] = {
    target: {
      type: "string",
      enum: NAV_TARGETS.map((t) => t.key),
      description: "要打开的页面",
    },
  };
  for (const t of NAV_TARGETS) {
    if (t.paramProperties) Object.assign(properties, t.paramProperties);
  }
  return { type: "object", properties, required: ["target"] };
})();

export default defineAgentTool({
  name: "navigate",
  label: "界面跳转",
  description:
    "打开或切换应用内的某个页面。target 从枚举中选择；打开班级详情（class-detail）提供 class_name，" +
    "打开学生详情（student-detail）提供 student_id，都会先查库校验再跳转。",
  parameters: NAV_PARAMETERS,
  async execute(args, ctx) {
    const target = String(args.target ?? "").trim();
    const nav = NAV_TARGETS.find((t) => t.key === target);
    if (!nav) {
      const keys = NAV_TARGETS.map((t) => t.key).join("、");
      return { ok: false, summary: "", error: `未知页面 "${target}"，可选：${keys}。` };
    }

    let params: Record<string, string> = {};
    let label = nav.label;
    if (nav.resolve) {
      try {
        const resolved = await nav.resolve(args);
        params = resolved.params;
        label = resolved.label;
      } catch (e) {
        return { ok: false, summary: "", error: e instanceof Error ? e.message : String(e) };
      }
    }

    await ctx.router.push({ name: nav.routeName, params });
    return { ok: true, summary: `已打开「${label}」页面。`, data: { target: nav.key, params } };
  },
});
