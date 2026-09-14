import { beforeEach, describe, expect, it } from "vitest";
import { inferExamType } from "../src/lib/score-analysis";
import {
  levelNameOfScore,
  levelOf,
  levelRankOf,
  levelStepText,
  levelValueOf,
  normalizeScoreLevelConfig,
  representativeScoreOf,
  resetScoreLevelConfig,
  saveScoreLevelConfig,
  scoreLines,
  showLevelOnly,
} from "../src/lib/score-config";

const DEFAULT_BANDS = [
  { key: "excellent" as const, label: "优秀", min: 90 },
  { key: "good" as const, label: "良好", min: 80 },
  { key: "pass" as const, label: "及格", min: 60 },
  { key: "fail" as const, label: "待提高", min: 0 },
];

describe("等级映射配置（score-config）", () => {
  beforeEach(() => resetScoreLevelConfig());

  it("默认映射：分数 → 等级与展示名", () => {
    expect(levelOf(95)).toBe("excellent");
    expect(levelOf(85)).toBe("good");
    expect(levelOf(60)).toBe("pass");
    expect(levelOf(59)).toBe("fail");
    expect(levelOf(null)).toBeNull();
    expect(levelNameOfScore(92)).toBe("优秀");
    expect(levelNameOfScore(75)).toBe("及格");
  });

  it("改阈值后等级名与统计线同步生效", () => {
    saveScoreLevelConfig({
      bands: [
        { key: "excellent", label: "A", min: 85 },
        { key: "good", label: "B", min: 75 },
        { key: "pass", label: "C", min: 65 },
        { key: "fail", label: "D", min: 0 },
      ],
    });
    expect(levelNameOfScore(80)).toBe("B");
    expect(levelNameOfScore(64)).toBe("D");
    expect(scoreLines()).toEqual({ pass: 65, excellent: 85 });
  });

  it("规范化：补齐四档、按 min 降序、阈值夹在 0~100", () => {
    const cfg = normalizeScoreLevelConfig({
      bands: [{ key: "pass", label: "及格", min: 200 }],
    });
    expect(cfg.bands).toHaveLength(4);
    expect(new Set(cfg.bands.map((b) => b.key))).toEqual(
      new Set(["excellent", "good", "pass", "fail"])
    );
    // 按 min 降序
    expect(cfg.bands.map((b) => b.min)).toEqual([...cfg.bands.map((b) => b.min)].sort((a, b) => b - a));
    // 阈值夹在 0~100
    expect(cfg.bands.find((b) => b.key === "pass")?.min).toBe(100);
  });

  it("等级文字折算代表分；非等级文字返回 null", () => {
    expect(representativeScoreOf("优")).toBe(90);
    expect(representativeScoreOf("良好")).toBe(80);
    expect(representativeScoreOf("合格")).toBe(60);
    expect(representativeScoreOf("待提高")).toBe(50);
    expect(representativeScoreOf("A")).toBe(90);
    expect(representativeScoreOf("缺考")).toBeNull();
  });

  it("按考试名判定大考 / 小考", () => {
    expect(inferExamType("期中考试")).toBe("major");
    expect(inferExamType("期末考试")).toBe("major");
    expect(inferExamType("第一单元测验")).toBe("minor");
    expect(inferExamType("第一次月考")).toBe("minor");
  });

  it("等级模式：开关随配置持久化，档位代表值与档位序正确", () => {
    // 规范化：未传视为关闭，传 true 保留
    expect(normalizeScoreLevelConfig({ bands: [] }).showLevelOnly).toBe(false);
    expect(normalizeScoreLevelConfig({ bands: [], showLevelOnly: true }).showLevelOnly).toBe(true);

    saveScoreLevelConfig({ bands: [...DEFAULT_BANDS], showLevelOnly: true });
    expect(showLevelOnly.value).toBe(true);
    // 只保存分数线的调用视为关闭（开关与档位编辑同走一条保存通道）
    saveScoreLevelConfig({ bands: [...DEFAULT_BANDS] });
    expect(showLevelOnly.value).toBe(false);

    saveScoreLevelConfig({ bands: [...DEFAULT_BANDS], showLevelOnly: true });
    // 档位代表值：同等级取同一数值（该档最低分），等级模式的柱高 / 折线纵坐标都用它
    expect(levelValueOf(95)).toBe(90);
    expect(levelValueOf(92)).toBe(90);
    expect(levelValueOf(85)).toBe(80);
    expect(levelValueOf(59)).toBe(0);
    expect(levelValueOf(null)).toBeNull();

    // 档位序：0 = 最低档，档位间进退比较用
    expect(levelRankOf(95)).toBe(3);
    expect(levelRankOf(85)).toBe(2);
    expect(levelRankOf(59)).toBe(0);
    expect(levelRankOf(null)).toBeNull();
    expect(levelStepText(2)).toBe("↑ 2 档");
    expect(levelStepText(-1)).toBe("↓ 1 档");
    expect(levelStepText(0)).toBe("持平");
  });
});
