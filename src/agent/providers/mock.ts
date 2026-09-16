/**
 * 规则 Mock Provider —— 无 LLM 时的兜底执行体。
 *
 * 用途：
 * 1. 浏览器演示态（非 Tauri）不联网也能走通「理解指令 → 调工具 → 回喂 → 总结」全链路
 * 2. vitest 中作为可预测的 LLM 替身
 *
 * 规则只覆盖常见中文指令形态，命中不了就走能力介绍兜底。
 */
import type { AgentLlm, AgentMessage, LlmResponse, ToolCallPayload } from "../types";
import { NAV_TARGETS } from "../tools/navigation";
import { localDateStr } from "../../lib/format";

let seq = 0;
const nextCallId = () => `mock-call-${++seq}`;

/** 从消息尾部判断本轮是否已经回喂过工具结果 */
function lastMessage(messages: AgentMessage[]): AgentMessage | undefined {
  return messages[messages.length - 1];
}

const NAV_WORDS = ["打开", "跳转", "跳到", "切换", "回到", "去", "看看", "进入", "显示"];
const STATS_WORDS = ["几个", "多少", "统计", "一共", "总数", "数量"];
const STUDENT_WORDS = ["学生", "名单", "花名册", "档案", "资料"];
const PHOTO_WORDS = ["照片", "相册", "图片"];
const DOC_WORDS = ["文档", "帮助", "指南", "怎么用", "如何", "哪里", "说明", "手册", "配置", "排查"];

/** 用户口语 → 界面注册表 key 的别名（学生列表并入班级管理页） */
const NAV_ALIASES: [string, string][] = [
  ["学生列表", "classes"],
  ["学生名单", "classes"],
  ["学生档案", "classes"],
  ["首页", "home"],
  ["主页", "home"],
  ["设置", "settings"],
  ["系统设置", "settings"],
  ["班级管理", "classes"],
  ["班级列表", "classes"],
  ["班级", "classes"],
  ["照片墙", "photos"],
  ["照片列表", "photos"],
  ["相册", "photos"],
  ["个人资料", "profile"],
  ["教师资料", "profile"],
];

/** 「打开学生列表」→ 命中的导航目标 key */
function matchNavTarget(text: string): string | undefined {
  if (!NAV_WORDS.some((w) => text.includes(w))) return undefined;
  // 先匹配注册表 label / key，再回落到口语别名
  const byRegistry = NAV_TARGETS.find((t) => text.includes(t.label) || text.includes(t.key));
  if (byRegistry) return byRegistry.key;
  return NAV_ALIASES.find(([alias]) => text.includes(alias))?.[1];
}

/** 从「归档三年级二班」「打开三年二班详情」这类指令里提取班级名（「级」可省略） */
function extractClassName(text: string): string {
  const m = text.match(/([一二三四五六1-6]\s*年(?:级)?\s*[一二三四五六七八九十0-9]+?\s*班)/);
  return m ? m[1].replace(/\s+/g, "") : "";
}

/** 课堂查询触发词：点名/课堂类口语（不含裸「课」，避免误吃「课表」） */
const LESSON_WORDS = ["点了谁", "点了哪些", "点名", "课堂", "这节课", "这堂课", "课上", "上课", "提问"];
/** 开课/下课是页面动作（ui_action 域），不进课堂查询 */
const LESSON_ACTION_RE = /开始上课|开课|下课|进入课堂|结束课堂/;

/** 「今天/昨天」与显式日期 → YYYY-MM-DD（无日期线索返回空串） */
function extractLessonDate(text: string): string {
  if (/今天|今日|本次|这节|这一节/.test(text)) return localDateStr();
  if (text.includes("昨天")) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return localDateStr(d);
  }
  const iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return localDateStr(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  return "";
}

/** 课堂班级名：常规班级名优先，再兜「三(2)班」括号写法（query_data lessons 宽容匹配） */
function extractLessonClassName(text: string): string {
  const normal = extractClassName(text);
  if (normal) return normal;
  const paren = text.match(/([一二三四五六1-6]\s*[（(]\s*\d{1,2}\s*[)）]\s*班)/);
  return paren ? paren[1].replace(/\s+/g, "") : "";
}

function extractKeyword(text: string): string {
  const quoted = text.match(/[“”"'《》【】]([^“”"'《》【】]{1,12})[“”"'《》【】]/);
  if (quoted) return quoted[1];
  // 无引号：「查一下林知远的资料」→ 提取动词后的 2~4 字片段
  const bare = text.match(
    /(?:查一下|查查|查|找一下|找找|找|搜索|看看)\s*([一-龥]{2,4}?)(?:的|资料|名字|信息|情况|是谁|在吗|，|。|？|!|！|$)/,
  );
  if (bare) {
    const word = bare[1];
    // 命中泛词（学生/照片/统计类）说明不是具体名字，退化为查全部
    const generic = [...STUDENT_WORDS, ...PHOTO_WORDS, ...STATS_WORDS].some((w) => word.includes(w));
    return generic ? "" : word;
  }
  return "";
}

export function mockLlm(): AgentLlm {
  return {
    async chat({ messages, onDelta }): Promise<LlmResponse> {
      // 第二轮：尾部是工具结果 → 生成总结
      const last = lastMessage(messages);
      if (last?.role === "tool") {
        const text = `已完成，结果如下：\n${last.content.slice(0, 500)}`;
        onDelta?.(text); // mock 无真实增量，整段模拟一次推送，保持与真实 provider 相同的事件路径
        return { content: text, toolCalls: [] };
      }

      const userText = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

      // 课堂查询：「今天三(2)班数学课点了谁」「这节课点了哪些人」→ query_data{entity:'lessons'}
      // 显式导航（「打开课堂模式」）让位给 navigate，开课/下课让位给 ui_action（并行交付）
      if (
        LESSON_WORDS.some((w) => userText.includes(w)) &&
        !LESSON_ACTION_RE.test(userText) &&
        !matchNavTarget(userText)
      ) {
        const args: Record<string, unknown> = { entity: "lessons" };
        const className = extractLessonClassName(userText);
        if (className) args.class_name = className;
        const date = extractLessonDate(userText);
        if (date) args.date = date;
        const call: ToolCallPayload = { id: nextCallId(), name: "query_data", arguments: args };
        return { content: "", toolCalls: [call] };
      }

      // 班级查询优先于归档/导航：「看看我归档过哪些班级」是查询，不是归档动作；
      // 显式导航短语（班级管理 / 班级列表）仍走导航。
      const explicitClassNav = /班级管理|班级列表|进入班级/.test(userText);
      if (
        userText.includes("班级") &&
        !explicitClassNav &&
        ["哪些", "多少", "几个", "列表", "有哪些", "查", "看看", "在用", "历史"].some((w) =>
          userText.includes(w)
        )
      ) {
        const call: ToolCallPayload = { id: nextCallId(), name: "query_data", arguments: { entity: "classes" } };
        return { content: "", toolCalls: [call] };
      }

      // 归档 / 恢复班级：写操作，优先于导航；显式「确认」后带 confirm:true
      if (userText.includes("归档") && userText.includes("班")) {
        const isConfirmed = userText.includes("确认") || userText.includes("确定");
        const className = extractClassName(userText);
        const args: Record<string, unknown> = { page: "classes", action: "archive-class" };
        if (className) args.args = { class_name: className };
        if (isConfirmed) args.confirm = true;
        const call: ToolCallPayload = { id: nextCallId(), name: "ui_action", arguments: args };
        return { content: "", toolCalls: [call] };
      }

      if (userText.includes("恢复") && userText.includes("班")) {
        const isConfirmed = userText.includes("确认") || userText.includes("确定");
        const className = extractClassName(userText);
        const args: Record<string, unknown> = { page: "classes", action: "restore-class" };
        if (className) args.args = { class_name: className };
        if (isConfirmed) args.confirm = true;
        const call: ToolCallPayload = { id: nextCallId(), name: "ui_action", arguments: args };
        return { content: "", toolCalls: [call] };
      }

      // 开课 / 下课：课堂页面动作（写操作；显式「确认」后带 confirm:true）。
      // 「打开课堂模式」含「开课」二字，显式导航短语让位给 navigate（与课堂查询分支同口径）
      if (/开始上课|开课|下课|结束课堂/.test(userText) && !matchNavTarget(userText)) {
        const isEnd = /下课|结束课堂/.test(userText);
        const isConfirmed = userText.includes("确认") || userText.includes("确定");
        const args: Record<string, unknown> = { page: "classroom", action: isEnd ? "end-lesson" : "start" };
        if (isConfirmed) args.confirm = true;
        const call: ToolCallPayload = { id: nextCallId(), name: "ui_action", arguments: args };
        return { content: "", toolCalls: [call] };
      }

      // 打开班级详情：带具体班级名的直达导航（「打开三年二班的详情页」），
      // class_name 交给 navigate 的实体解析器查库校验；问成绩/统计等数据仍走查询与分析
      if (NAV_WORDS.some((w) => userText.includes(w))) {
        const className = extractClassName(userText);
        if (className && !/成绩|统计|排名|分析|多少|几个/.test(userText)) {
          const call: ToolCallPayload = {
            id: nextCallId(),
            name: "navigate",
            arguments: { target: "class-detail", class_name: className },
          };
          return { content: "", toolCalls: [call] };
        }
      }

      const navTarget = matchNavTarget(userText);
      if (navTarget) {
        const call: ToolCallPayload = { id: nextCallId(), name: "navigate", arguments: { target: navTarget } };
        return { content: "", toolCalls: [call] };
      }

      if (userText.includes("清空全部数据") || userText.includes("清空数据")) {
        const isConfirmed = userText.includes("确认") || userText.includes("确定");
        const args: Record<string, unknown> = { page: "settings", action: "clear-all-data" };
        if (isConfirmed) args.confirm = true;
        const call: ToolCallPayload = { id: nextCallId(), name: "ui_action", arguments: args };
        return { content: "", toolCalls: [call] };
      }

      if (userText.includes("新建学生") || userText.includes("添加学生") || userText.includes("创建学生")) {
        const call: ToolCallPayload = { id: nextCallId(), name: "ui_action", arguments: { page: "classes", action: "create-student" } };
        return { content: "", toolCalls: [call] };
      }

      // 导入花名册 → 打开导入对话框（须在学生查询规则之前，避免被「学生/花名册」关键词劫持）
      if (/导入/.test(userText) && /花名册|学生|名单/.test(userText)) {
        const mode = userText.includes("指定格式") || userText.includes("模板") ? "template" : "smart";
        const call: ToolCallPayload = {
          id: nextCallId(),
          name: "ui_action",
          arguments: { page: "classes", action: "import-roster", args: { mode } },
        };
        return { content: "", toolCalls: [call] };
      }

      if (STATS_WORDS.some((w) => userText.includes(w))) {
        const call: ToolCallPayload = { id: nextCallId(), name: "query_data", arguments: { entity: "stats" } };
        return { content: "", toolCalls: [call] };
      }

      // 学期汇总：命中「学期 + 汇总/报告」时走 analyze（有学生姓名 → 个人，否则班级）
      if (userText.includes("学期") && /汇总|报告|总结|表现/.test(userText)) {
        const keyword = extractKeyword(userText);
        const payload: Record<string, unknown> = {};
        if (keyword) {
          payload.name = keyword;
          const call: ToolCallPayload = {
            id: nextCallId(),
            name: "analyze",
            arguments: { kind: "student_term_report", payload },
          };
          return { content: "", toolCalls: [call] };
        }
        const call: ToolCallPayload = {
          id: nextCallId(),
          name: "analyze",
          arguments: { kind: "semester_overview", payload },
        };
        return { content: "", toolCalls: [call] };
      }

      // 评价报告：命中「评价报告」时走 analyze（有学生姓名 → 个人汇总）
      if (userText.includes("评价报告")) {
        const keyword = extractKeyword(userText);
        const payload: Record<string, unknown> = {};
        if (keyword) payload.name = keyword;
        const call: ToolCallPayload = {
          id: nextCallId(),
          name: "analyze",
          arguments: { kind: "student_eval_report", payload },
        };
        return { content: "", toolCalls: [call] };
      }

      // 作业台账：命中「作业」时走 query_data（按评语/科目关键词查，需带 student_id 时由下一轮补齐）
      if (userText.includes("作业")) {
        const keyword = extractKeyword(userText);
        const args: Record<string, unknown> = { entity: "homeworks" };
        if (keyword) args.keyword = keyword;
        const call: ToolCallPayload = { id: nextCallId(), name: "query_data", arguments: args };
        return { content: "", toolCalls: [call] };
      }

      if (PHOTO_WORDS.some((w) => userText.includes(w))) {
        const call: ToolCallPayload = { id: nextCallId(), name: "query_data", arguments: { entity: "photos" } };
        return { content: "", toolCalls: [call] };
      }

      if (STUDENT_WORDS.some((w) => userText.includes(w))) {
        const keyword = extractKeyword(userText);
        const args: Record<string, unknown> = { entity: "students" };
        if (keyword) args.keyword = keyword;
        const call: ToolCallPayload = { id: nextCallId(), name: "query_data", arguments: args };
        return { content: "", toolCalls: [call] };
      }

      if (DOC_WORDS.some((w) => userText.includes(w))) {
        const call: ToolCallPayload = { id: nextCallId(), name: "find_docs", arguments: { keywords: userText.slice(0, 20) } };
        return { content: "", toolCalls: [call] };
      }

      const fallbackText =
        "当前是浏览器演示态（规则模式），可以试试：「打开学生列表」「现在有多少学生」「查一下林知远」。桌面端在「数据与设置」配好模型后可使用完整 AI 能力。";
      onDelta?.(fallbackText);
      return { content: fallbackText, toolCalls: [] };
    },
  };
}
