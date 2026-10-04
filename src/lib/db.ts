/**
 * 数据层门面（原巨型 db.ts 按业务域拆分后的统一出口）。
 *
 * - 各域实现见 src/lib/db/：core（连接/建表/事务原语）、memory-store（内存兜底）、
 *   shared（域间小工具）与 13 个业务域文件（students / recycle / photos / classes /
 *   term-comments / homework / eval-reports / profile / behavior / exams / timetable /
 *   calendar / lessons）
 * - 这里用显式清单转发公共 API：既有引用点（views / components / agent / lib）
 *   的 `from "./db"` / `from "../lib/db"` 一行都不用改
 * - isTauri 的实现在 lib/env.ts，这里保留同名导出兼容旧引用点
 * - db/ 内部的 getDb / executeBatch / mem / memory-store 等不在此暴露
 *
 * 约定：多表写一律走 core 的 executeBatch（单次 execute 内联事务，
 * 见 docs/DATA_LAYER.md），新增业务域放 db/<域>.ts 并在下方登记转发。
 */
export { isTauri } from "./env";
export { recycleRemainingDays } from "./db/shared";
export { migrateLegacyCalendarMemos } from "./db/core";

/* 学生 */
export {
  listStudents,
  getStudent,
  createStudent,
  updateStudent,
  deleteStudent,
} from "./db/students";

/* 回收站 */
export {
  listRecycleItems,
  restoreRecycleItem,
  purgeRecycleItem,
  clearRecycleBin,
  purgeExpiredRecycleItems,
} from "./db/recycle";

/* 学生照片 */
export { listPhotos, addPhoto, deletePhoto } from "./db/photos";

/* 班级 */
export {
  listClasses,
  createClass,
  getClassMeta,
  archiveClass,
  restoreClass,
  renameClass,
  deleteClass,
  batchUpdateStudentClass,
  getClassSummary,
  listPhotosByClass,
  addClassPhoto,
  getStats,
} from "./db/classes";

/* 学期评语 */
export {
  listTermComments,
  getTermComment,
  upsertTermComment,
  deleteTermComment,
} from "./db/term-comments";

/* 作业台账 */
export {
  addHomeworkRecord,
  listHomeworkRecords,
  updateHomeworkRecord,
  deleteHomeworkRecord,
  type HomeworkQuery,
} from "./db/homework";

/* 评价报告存档 */
export { createEvalReport, listEvalReports, deleteEvalReport } from "./db/eval-reports";

/* 个人资料 */
export { getProfile, saveProfile, clearAll } from "./db/profile";

/* 日常表现 */
export {
  listBehaviorDimensions,
  createBehaviorDimension,
  addBehaviorRecord,
  deleteBehaviorRecord,
  updateBehaviorRecord,
  listCommentPresets,
  listBehaviorRecords,
  listBehaviorRecordsByClass,
} from "./db/behavior";

/* 考试与成绩 */
export {
  createExam,
  findExam,
  findOrCreateExam,
  listExamsByClass,
  getExam,
  updateExam,
  deleteExam,
  upsertExamScore,
  deleteExamScore,
  getExamScores,
  listStudentExamScores,
  getClassScoreOverview,
  getClassScoreTrend,
  listExams,
  listExamScores,
  getStudentScoreReport,
  type ExamScoreFilter,
} from "./db/exams";

/* 课程表与调课例外 */
export {
  getTimetableWithSlots,
  findOrCreateTimetable,
  saveTimetableSlot,
  saveTimetablePeriods,
  saveTimetableMySubjects,
  listTimetableSlotsWithClass,
  listTimetablePeriodsByClass,
  clearTimetableSlots,
  listTimetableSubjects,
  saveTimetableException,
  clearTimetableException,
  listTimetableExceptionsInRange,
  listTimetableExceptionsWithClass,
} from "./db/timetable";

/* 统一日程事件 */
export {
  addCalendarEvent,
  listClassEventsInRange,
  listTeacherEventsInRange,
  searchCalendarEvents,
  setCalendarEventDone,
  deleteCalendarEvent,
  setCalendarEventTitle,
} from "./db/calendar";

/* 课堂模式 */
export {
  openLessonSession,
  endLessonSession,
  getLessonSession,
  findLiveLessonSession,
  listLiveLessonSessions,
  listLessonSessions,
  appendLessonEvent,
  revokeLessonEvent,
  listLessonEvents,
  lastPickedAtByStudent,
  listSeating,
  upsertSeating,
  removeSeatingStudent,
  clearSeating,
  listClassroomActivitySets,
  saveClassroomActivitySet,
  parseJsonObject,
  type OpenLessonSessionInput,
  type LessonSessionFilter,
  type UpsertSeatingInput,
  type SaveActivitySetInput,
} from "./db/lessons";
