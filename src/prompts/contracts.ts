/**
 * 提示词 ↔ 程序 的契约常量（**叶子模块：不 import 任何东西**）。
 *
 * 为什么单独放这里：提示词模块要拿到「字数上限」「输出结构」这些常量，
 * 而常量原本定义在 lib/comment-ai.ts 等业务文件里；业务文件又要在运行期
 * 调 resolvePrompt 读提示词 —— 两边互相 import 会形成循环：prompts/registry 的
 * import.meta.glob(eager) 会在业务模块尚未初始化时就把各 *.prompt.ts 拉起来，
 * 读到处于 TDZ 的 const 直接报 "Cannot access before initialization"。
 *
 * 因此把被双方共享的常量下沉到这个不依赖任何模块的叶子文件：
 * 业务侧 `export { X } from "../prompts/contracts"` 保持原有公开 API 不变，
 * 提示词侧从这里取值 —— 单一事实源，且重复值不可能与解析逻辑脱节。
 */

/* ---------------- 输出长度上限（与解析函数的截断长度同源） ---------------- */

/** 学期评语正文最大字数（parseTermComment 截断用） */
export const TERM_COMMENT_MAX_LEN = 200;

/** 家校沟通总结正文最大字数（parseParentSummary 截断用；与学期评语同上限，便于一键应用回学期评语不截断） */
export const PARENT_SUMMARY_MAX_LEN = 200;

/** 推荐评语单条最大字数（parseAiComments 截断用） */
export const AI_COMMENT_MAX_LEN = 25;

/** 备忘快速浏览标题最大字数（parseMemoTitle 截断用） */
export const MEMO_TITLE_MAX_LEN = 12;

/* ---------------- JSON 输出结构（与各解析函数一一对应） ---------------- */

/** 成绩单结构识别的输出结构：aiDetectScoreSheet 按此解析 */
export const SCORE_SHEET_OUTPUT_SCHEMA =
  '{"name_column": 列号(从1起), "subjects": [{"column": 列号, "name": "科目名"}], ' +
  '"exam_name": "考试名或null", "exam_date": "YYYY-MM-DD或null", "confidence": 0到1的小数, ' +
  '"reason": "不超过20字的理由"}';

/** 花名册姓名列识别的输出结构：aiDetectNameColumn 按此解析 */
export const ROSTER_NAME_COLUMN_OUTPUT_SCHEMA =
  '{"column": 列号(从1开始的数字), "confidence": 0到1的小数, "reason": "不超过20字的理由"}';

/** 花名册班级推断的输出结构：aiInferClassName 按此解析 */
export const ROSTER_CLASS_NAME_OUTPUT_SCHEMA =
  '{"class_name": "班级名或null", "confidence": 0到1的小数, "reason": "不超过20字的理由"}';
