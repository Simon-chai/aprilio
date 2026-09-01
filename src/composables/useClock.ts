import { computed, onMounted, onUnmounted, ref } from "vue";

const pad = (n: number) => String(n).padStart(2, "0");
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * 分钟级实时时钟。
 * 只在下一分钟边界刷新，避免首页时间在分钟内频繁触发渲染。
 */
export function useClock() {
  const now = ref(new Date());
  let timer = 0;

  const schedule = () => {
    const delay = 60_000 - (Date.now() % 60_000) + 8;
    timer = window.setTimeout(() => {
      now.value = new Date();
      schedule();
    }, delay);
  };

  onMounted(() => {
    now.value = new Date();
    schedule();
  });

  onUnmounted(() => window.clearTimeout(timer));

  const hhmm = computed(() => `${pad(now.value.getHours())}:${pad(now.value.getMinutes())}`);

  const dateText = computed(() => {
    const d = now.value;
    return `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
  });

  const yearText = computed(() => String(now.value.getFullYear()));

  const greeting = computed(() => {
    const h = now.value.getHours();
    if (h < 5) return "夜深了";
    if (h < 11) return "早上好";
    if (h < 14) return "中午好";
    if (h < 18) return "下午好";
    return "晚上好";
  });

  return { now, hhmm, dateText, yearText, greeting };
}
