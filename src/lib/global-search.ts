/**
 * Ctrl+F 全局搜索的数据聚合层（纯逻辑，可测）。
 *
 * - 跨五类实体：学生 / 班级 / 考试 / 照片 / 日程备忘
 * - 纯关键词匹配（不接 Ollama 语义检索），全部复用 db.ts 现有查询；
 *   本地库数据量小，班级 / 考试 / 照片直接全量拉取后 JS 过滤，与项目现有模式一致
 * - 每组截 limitPerGroup 条，分组顺序固定：学生 → 班级 → 考试 → 照片 → 备忘
 */
import { listClasses, listExams, listPhotos, listStudents, searchCalendarEvents } from "./db";
import { CALENDAR_EVENT_META, eventQuickTitle } from "./timetable";

export type SearchEntity = "student" | "class" | "exam" | "photo" | "memo";

export interface GlobalSearchResult {
  entity: SearchEntity;
  id: string;
  /** 主文案 */
  title: string;
  /** 次文案：学号 / 日期 / 班级 /「已归档」/「已完成」等 */
  subtitle: string;
  route: { name: string; params?: Record<string, string> };
}

export interface GlobalSearchGroup {
  entity: SearchEntity;
  label: string;
  results: GlobalSearchResult[];
}

/** 分组顺序即展示顺序 */
const GROUP_META: { entity: SearchEntity; label: string }[] = [
  { entity: "student", label: "学生" },
  { entity: "class", label: "班级" },
  { entity: "exam", label: "考试" },
  { entity: "photo", label: "照片" },
  { entity: "memo", label: "日程备忘" },
];

/**
 * 关键词全局搜索：五类实体并发查询，空组直接省略。
 * keyword 为空白时返回空数组（浮层据此显示引导文案）。
 */
export async function searchGlobal(
  keyword: string,
  limitPerGroup = 8
): Promise<GlobalSearchGroup[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const limit = limitPerGroup > 0 ? Math.floor(limitPerGroup) : 8;
  const lower = kw.toLowerCase();
  const hit = (...fields: (string | null | undefined)[]) =>
    fields.some((f) => (f ?? "").toLowerCase().includes(lower));

  const [students, classes, exams, photos, memos, allStudents] = await Promise.all([
    listStudents(kw),
    listClasses(),
    listExams(),
    listPhotos(),
    searchCalendarEvents(kw, limit),
    // 照片条目要显示归属学生姓名（学生个人照片不带班级）
    listStudents(),
  ]);

  const nameById = new Map(allStudents.map((s) => [s.id, s.name]));

  const byEntity: Record<SearchEntity, GlobalSearchResult[]> = {
    student: students.map((s) => ({
      entity: "student",
      id: String(s.id),
      title: s.name,
      subtitle: [s.student_no, s.grade_class].filter(Boolean).join(" · "),
      route: { name: "student-detail", params: { id: String(s.id) } },
    })),
    class: classes
      .filter((c) => hit(c.name))
      .map((c) => ({
        entity: "class",
        id: c.name,
        title: c.name,
        subtitle: [`${c.studentCount} 名学生`, c.archived_at ? "已归档" : ""]
          .filter(Boolean)
          .join(" · "),
        route: { name: "class-detail", params: { name: c.name } },
      })),
    exam: exams
      .filter((e) => hit(e.name, e.exam_date))
      .map((e) => ({
        entity: "exam",
        id: String(e.id),
        title: e.name,
        subtitle: `${e.class_name} · ${e.exam_date}`,
        route: { name: "class-detail", params: { name: e.class_name } },
      })),
    photo: photos
      .filter((p) => hit(p.caption, p.file_name, p.grade_class))
      .map((p) => ({
        entity: "photo",
        id: String(p.id),
        title: p.caption?.trim() || p.file_name,
        subtitle:
          p.student_id === null
            ? `班级照片 · ${p.grade_class?.trim() || "未分班"}`
            : ["学生照片", nameById.get(p.student_id)].filter(Boolean).join(" · "),
        route: { name: "photos" },
      })),
    memo: memos.map((e) => ({
      entity: "memo",
      id: String(e.id),
      title: eventQuickTitle(e),
      subtitle: [
        CALENDAR_EVENT_META[e.type]?.label ?? e.type,
        e.event_date,
        e.class_name ?? "",
        e.done === 1 ? "已完成" : "",
      ]
        .filter(Boolean)
        .join(" · "),
      route: { name: "home" },
    })),
  };

  return GROUP_META.map(({ entity, label }) => ({
    entity,
    label,
    results: byEntity[entity].slice(0, limit),
  })).filter((g) => g.results.length > 0);
}