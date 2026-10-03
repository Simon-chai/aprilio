/**
 * 监护人标签情感倾向（src/lib/guardian-tags.ts → ensureGuardianTagPolarities）。
 *
 * 输出被 parseTagPolarities 解析：优先 JSON 对象，失败退回「标签：倾向」行式。
 * 倾向取值只有 positive / neutral / negative 三种（见 types 的 GUARDIAN_TAG_POLARITIES）。
 */
import { definePromptModule } from "../define";

export default definePromptModule({
  id: "recognize.guardian-tag",
  group: "recognize",
  label: "监护人标签倾向",
  description: "学生档案里为监护人风格标签判定情感倾向，决定标签胶囊的配色。",
  note:
    "倾向取值必须是 positive / neutral / negative 三者之一（程序只认这三个值）。" +
    "结果按标签缓存，一次判定永久复用——改提示词后已缓存的标签不会重新判定。",
  defaultText:
    "你是小学班主任助手。为每个「监护人风格标签」判定教师与该监护人相处沟通时的情感倾向，三选一：" +
    "positive（正面：温和、配合、沟通良好）、negative（负面：配合度低、难沟通、较少参与）、" +
    "neutral（中性：客观描述无明显褒贬）。" +
    "只输出 JSON 对象，键为标签原文、值为 positive/neutral/negative，不要任何解释。",
});
