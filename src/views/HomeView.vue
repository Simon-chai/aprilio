<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import FeatureIcon from "../components/FeatureIcon.vue";
import HomeChatBox from "../components/HomeChatBox.vue";
import { useClock } from "../composables/useClock";
import { usePagedScroll } from "../composables/usePagedScroll";
import { getStats, listStudents } from "../lib/db";
import { avatarSrc, ensureProfile, heroSrc, profile } from "../lib/profile";
import type { Stats } from "../types";

const PAGES = 2;

const viewport = ref<HTMLElement | null>(null);
const { index, heroProgress, goTo, next } = usePagedScroll(PAGES, viewport);
const { hhmm, dateText, yearText, greeting } = useClock();

const stats = ref<Stats>({ students: 0, photos: 0, month_new: 0 });
const classCount = ref(0);
const heroReady = ref(false);
const reducedMotion = ref(false);
let motionQuery: MediaQueryList | null = null;

const updateReducedMotion = () => {
  reducedMotion.value = motionQuery?.matches === true;
};

onMounted(() => {
  if (typeof window === "undefined" || !window.matchMedia) return;
  motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  updateReducedMotion();
  motionQuery.addEventListener("change", updateReducedMotion);
});

onBeforeUnmount(() => {
  motionQuery?.removeEventListener("change", updateReducedMotion);
  motionQuery = null;
});

// 换图后重新淡入，避免硬切
watch(heroSrc, () => {
  heroReady.value = false;
});

onMounted(async () => {
  await ensureProfile();
  try {
    const [rows, s] = await Promise.all([listStudents(), getStats()]);
    stats.value = s;
    classCount.value = new Set(rows.map((r) => r.grade_class).filter(Boolean)).size;
  } catch {
    /* 浏览器演示或数据库为空时保持 0，界面仍可用 */
  }
});

const features = computed(() => [
  {
    to: "/classes",
    icon: "classes" as const,
    title: "班级管理",
    desc: `${classCount.value} 个班级 · ${stats.value.students} 名学生`,
  },
  {
    to: "/students",
    icon: "students" as const,
    title: "学生档案",
    desc: `${stats.value.students} 名学生 · 本月新增 ${stats.value.month_new}`,
  },
  {
    to: "/photos",
    icon: "photos" as const,
    title: "图片记录",
    desc: `${stats.value.photos} 张照片 · 全部留在本机`,
  },
  {
    to: "/settings",
    icon: "settings" as const,
    title: "数据与设置",
    desc: "本地 SQLite · 不联网",
  },
]);

/** 首屏文字随滚动上浮淡出，大图同向下沉，做出纵深 */
const heroTextStyle = computed(() => {
  if (reducedMotion.value) return {};
  const p = heroProgress.value;
  return {
    transform: `translate3d(0, ${-p * 72}px, 0)`,
    opacity: String(Math.max(0, 1 - p * 1.5)),
  };
});

const heroImageStyle = computed(() => {
  if (reducedMotion.value) return {};
  const h = viewport.value?.clientHeight ?? 0;
  return { transform: `translate3d(0, ${heroProgress.value * 0.3 * h}px, 0)` };
});

/** 向下箭头只在第 1 屏可见、可点 */
const cueStyle = computed(() => {
  const p = heroProgress.value;
  if (reducedMotion.value) {
    return {
      opacity: String(p > 0.02 ? 0 : 1),
      transform: "translate3d(-50%, 0px, 0)",
      pointerEvents: (p > 0.02 ? "none" : "auto") as "none" | "auto",
    };
  }
  return {
    opacity: String(Math.max(0, 1 - p * 3)),
    transform: `translate3d(-50%, ${p * 24}px, 0)`,
    pointerEvents: (p > 0.02 ? "none" : "auto") as "none" | "auto",
  };
});

/** 页码指示器要跟着底色反转：第 1 屏深色底用白，第 2 屏浅色底用墨 */
const dotClass = (i: number) => {
  const onDark = index.value === 0;
  if (index.value === i) return `h-6 w-2 ${onDark ? "bg-white" : "bg-ink"}`;
  return `h-2 w-2 ${onDark ? "bg-white/35 hover:bg-white/60" : "bg-faint hover:bg-weak"}`;
};
</script>

<template>
  <div class="relative h-full overflow-hidden">
    <!-- 翻页层与悬浮层分开：聊天区里的滚轮/按键不会触发翻页，悬浮层也不随内容滚动 -->
    <div
      ref="viewport"
      class="relative h-full snap-y snap-mandatory overflow-y-auto scrollbar-none"
    >
    <!-- ══════════════ 第 1 屏：全屏大图 + 实时时间 ══════════════ -->
    <section
      data-page="0"
      class="relative h-full w-full shrink-0 snap-start overflow-hidden bg-tile"
    >
      <!-- 用户设置的大图：缓慢 Ken Burns + 滚动视差 -->
      <div class="absolute inset-0 will-change-transform" :style="heroImageStyle">
        <img
          :key="heroSrc"
          :src="heroSrc"
          alt=""
          class="hero-ken h-full w-full object-cover transition-opacity duration-700"
          :class="heroReady ? 'opacity-100' : 'opacity-0'"
          draggable="false"
          @load="heroReady = true"
        />
      </div>

      <!-- 上下双向压暗，只为保证白字可读 -->
      <div class="absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-black/75" />

      <!-- 顶栏浮在大图上 -->
      <header
        class="absolute inset-x-0 top-0 flex h-[76px] items-center justify-between px-12"
        :style="heroTextStyle"
      >
        <span class="text-tagline font-semibold -tracking-[0.3px] text-white">aprilio</span>

        <div class="flex items-center gap-3">
          <RouterLink
            to="/settings"
            class="flex h-9 w-9 items-center justify-center rounded-pill bg-white/15 text-white backdrop-blur transition-[transform,background-color] hover:bg-white/25 active:scale-[0.95]"
            title="数据与设置"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
              <circle cx="9" cy="7" r="2.3" fill="none" stroke="currentColor" stroke-width="1.8" />
              <circle cx="15" cy="12" r="2.3" fill="none" stroke="currentColor" stroke-width="1.8" />
              <circle cx="8" cy="17" r="2.3" fill="none" stroke="currentColor" stroke-width="1.8" />
            </svg>
          </RouterLink>

          <!-- 点头像进资料编辑 -->
          <RouterLink
            to="/profile"
            class="group relative block h-11 w-11 shrink-0 rounded-pill ring-1 ring-white/40 transition-transform duration-200 hover:scale-[1.06] active:scale-[0.95]"
            title="编辑个人资料"
          >
            <img
              :src="avatarSrc"
              :alt="profile.name"
              class="h-full w-full rounded-pill object-cover"
              draggable="false"
            />
            <span
              class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-pill bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 20h4l10-10a2.4 2.4 0 0 0-3.4-3.4L4.6 16.6 4 20Z"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </RouterLink>
        </div>
      </header>

      <!-- 主信息区 -->
      <div class="absolute bottom-[92px] left-12 max-w-[760px]" :style="heroTextStyle">
        <p class="text-caption tracking-[0.6px] text-white/55">{{ yearText }} · 秋季学期</p>

        <!-- 实时时钟：分钟更新，避免频繁变化造成视觉抖动 -->
        <time
          class="mt-3 block tnum text-[72px] font-semibold leading-none -tracking-[2px] text-white"
          aria-live="polite"
        >
          {{ hhmm }}
        </time>

        <p class="mt-3 text-body text-white/70">{{ dateText }}</p>

        <h1 class="mt-7 text-display font-semibold -tracking-[0.37px] text-white">
          {{ greeting }}，{{ profile.name }}
        </h1>
        <p v-if="profile.motto" class="mt-1.5 text-airy font-light text-white/65">
          {{ profile.motto }}
        </p>
        <p v-if="profile.title" class="mt-4 text-caption text-white/45">{{ profile.title }}</p>
      </div>

      <!-- 向下提示：会弹动，点了就翻页 -->
      <button
        type="button"
        class="absolute bottom-9 left-1/2 flex flex-col items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-4"
        :style="cueStyle"
        aria-label="向下滚动到功能页"
        @click="next()"
      >
        <span class="text-fine tracking-[1.4px] text-white/55">向下</span>
        <span
          class="flex h-11 w-11 items-center justify-center rounded-pill border border-white/30 bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20 active:scale-[0.95]"
        >
          <svg
            class="arrow-bounce"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M6 9.5l6 6 6-6"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      </button>
    </section>

    <!-- ══════════════ 第 2 屏：功能入口 ══════════════ -->
    <section
      data-page="1"
      class="relative flex h-full w-full shrink-0 snap-start flex-col bg-canvas px-12 pb-9 pt-14"
    >
      <div class="flex w-full flex-1 items-center justify-center">
        <div class="w-full max-w-[1000px]" data-page-scroll>
        <div class="flex items-baseline justify-between">
          <h2 class="text-display font-semibold -tracking-[0.37px] text-ink">从哪里开始</h2>
          <RouterLink to="/profile" class="text-caption text-primary hover:underline">
            编辑个人资料 →
          </RouterLink>
        </div>
        <p class="mt-2 text-body text-weak">所有数据都留在这台电脑上，不联网、不上传。</p>

        <div class="mt-9 grid grid-cols-2 gap-4">
          <RouterLink
            v-for="f in features"
            :key="f.to"
            :to="f.to"
            class="group flex items-center gap-5 rounded-lg border border-hairline bg-canvas p-6 transition-[background-color,border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-faint hover:bg-pearl active:scale-[0.99]"
          >
            <div
              class="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-parchment text-primary transition-colors group-hover:bg-primary-soft"
            >
              <FeatureIcon :name="f.icon" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-tagline font-semibold -tracking-[0.3px] text-ink">{{ f.title }}</p>
              <p class="mt-1 truncate text-caption text-weak">{{ f.desc }}</p>
            </div>
            <svg
              class="shrink-0 text-faint transition-[transform,color] duration-150 group-hover:translate-x-0.5 group-hover:text-weak"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M9 5l7 7-7 7"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </RouterLink>
        </div>

        <div class="mt-7 flex items-center justify-between">
          <p class="text-fine text-faint">滚轮、↓ 键、空格都能翻页 · 点头像可编辑资料和首页大图</p>
          <RouterLink to="/design" class="text-fine text-faint hover:text-weak">设计系统</RouterLink>
        </div>
        </div>
      </div>
    </section>

    <!-- 页码指示器 -->
    <nav
      class="fixed right-7 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-2.5"
      aria-label="页面导航"
    >
      <button
        v-for="i in PAGES"
        :key="i"
        type="button"
        class="rounded-pill transition-all duration-300"
        :class="dotClass(i - 1)"
        :aria-label="`第 ${i} 页`"
        :aria-current="index === i - 1 ? 'page' : undefined"
        @click="goTo(i - 1)"
      />
    </nav>
    </div>

    <!-- AI 助手悬浮窗：右下角的深色玻璃层，悬浮在翻页内容之上。
         暂定只挂在首页；后续要让 AI 在应用内跳转时，把它提升到 App.vue 作全局浮层即可 -->
    <HomeChatBox />
  </div>
</template>
