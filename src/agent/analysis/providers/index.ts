/**
 * 内置分析器统一出口。新增分析器 = 在此追加一个 export，
 * 并在 analyze 工具装配处调用对应的 registerXxx（保持显式、可测试）。
 */
export {
  SCORE_ANALYSIS_KINDS,
  createScoreAnalysisProvider,
  registerScoreAnalysisProvider,
} from "./score-analysis";
export {
  SEMESTER_ANALYSIS_KINDS,
  createSemesterAnalysisProvider,
  registerSemesterAnalysisProvider,
} from "./semester-analysis";
