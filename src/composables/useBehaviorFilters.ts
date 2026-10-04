/**
 * 表现时间线的筛选与分组逻辑（拆分自 ClassBehaviorTimeline / StudentBehaviorTimeline）：
 * 倾向 / 维度（班级版另有表现大类）筛选 + 倾向计数 + 按日期倒序分组。
 *
 * 两个时间线的筛选语义一致，差别只在班级版多「大类」与「学生」两个维度：
 * 大类经 withCategory 打开（维度候选与倾向计数都按大类收紧），学生过滤经
 * extraFilter 注入；模板展示差异留在各自组件。
 */
import { computed, ref, watch } from "vue";
import type { BehaviorCategory, BehaviorPolarity } from "../types";

/** 两个表现时间线共用的记录字段（ClassBehaviorRecord / StudentBehaviorRecord 均满足） */
export interface BehaviorTimelineRecord {
  id: number;
  type: BehaviorPolarity;
  dimension_name_snap: string;
  recorded_date: string | null;
  created_at: string;
  /** 仅班级时间线有：表现大类 */
  category_snap?: string;
  /** 仅班级时间线有：学生 id（数字） */
  student_id?: number;
}

export interface DateGroup<R> {
  date: string;
  items: R[];
}

export interface BehaviorFilterOptions<R> {
  /** 维度候选与倾向计数是否按表现大类过滤（班级时间线 true，学生时间线无大类） */
  withCategory?: boolean;
  /** 追加的记录过滤（如班级时间线的学生下拉过滤） */
  extraFilter?: (record: R) => boolean;
}

export function useBehaviorFilters<R extends BehaviorTimelineRecord>(
  records: () => R[],
  options: BehaviorFilterOptions<R> = {}
) {
  const withCategory = options.withCategory ?? false;
  const selectedCategory = ref<"all" | BehaviorCategory>("all");
  const selectedPolarity = ref<"all" | BehaviorPolarity>("all");
  const selectedDimension = ref<string>("all");

  // 提取所有已存在的维度供下拉选择（班级版随大类收紧）
  const availableDimensions = computed(() => {
    const set = new Set<string>();
    for (const r of records()) {
      if (!withCategory || selectedCategory.value === "all" || r.category_snap === selectedCategory.value) {
        if (r.dimension_name_snap) set.add(r.dimension_name_snap);
      }
    }
    return Array.from(set);
  });

  // 维度候选变化后，已选维度可能不复存在，回落「全部」
  watch(availableDimensions, (dims) => {
    if (selectedDimension.value !== "all" && !dims.includes(selectedDimension.value)) {
      selectedDimension.value = "all";
    }
  });

  // 统计各倾向数量（班级版按大类收紧，total 为计数口径）
  const polarityCounts = computed(() => {
    let praise = 0;
    let improve = 0;
    let neutral = 0;
    let total = 0;
    for (const r of records()) {
      if (withCategory && selectedCategory.value !== "all" && r.category_snap !== selectedCategory.value) {
        continue;
      }
      total++;
      if (r.type === "praise") praise++;
      else if (r.type === "improve") improve++;
      else if (r.type === "neutral") neutral++;
    }
    return { all: total, praise, improve, neutral };
  });

  // 综合多维过滤后的列表
  const filteredRecords = computed(() => {
    return records().filter((r) => {
      if (withCategory && selectedCategory.value !== "all" && r.category_snap !== selectedCategory.value) {
        return false;
      }
      if (selectedPolarity.value !== "all" && r.type !== selectedPolarity.value) {
        return false;
      }
      if (options.extraFilter && !options.extraFilter(r)) {
        return false;
      }
      if (selectedDimension.value !== "all" && r.dimension_name_snap !== selectedDimension.value) {
        return false;
      }
      return true;
    });
  });

  // 按 recorded_date 倒序分组（组内按 id 倒序）
  const groupedRecords = computed<DateGroup<R>[]>(() => {
    const map = new Map<string, R[]>();
    for (const r of filteredRecords.value) {
      const date = r.recorded_date || r.created_at.slice(0, 10);
      const list = map.get(date) ?? [];
      list.push(r);
      map.set(date, list);
    }
    return Array.from(map.entries())
      .sort(([dateA], [dateB]) => (dateA < dateB ? 1 : -1))
      .map(([date, items]) => ({
        date,
        items: items.sort((a, b) => b.id - a.id),
      }));
  });

  return {
    selectedCategory,
    selectedPolarity,
    selectedDimension,
    availableDimensions,
    polarityCounts,
    filteredRecords,
    groupedRecords,
  };
}
