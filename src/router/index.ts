import { createRouter, createWebHashHistory } from "vue-router";
import HomeView from "../views/HomeView.vue";
import ClassesView from "../views/ClassesView.vue";
import ClassDetailView from "../views/ClassDetailView.vue";
import PhotosView from "../views/PhotosView.vue";
import RecycleBinView from "../views/RecycleBinView.vue";
import MyTimetableView from "../views/MyTimetableView.vue";
import ClassroomView from "../views/ClassroomView.vue";
import SettingsView from "../views/SettingsView.vue";
import StudentDetailView from "../views/StudentDetailView.vue";
import ProfileView from "../views/ProfileView.vue";

// 桌面端用 hash 模式，避免打包后刷新路由 404
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    // 首页 = 教师个性展示 + 唯一业务入口，全宽无侧边栏
    { path: "/", redirect: "/home" },
    { path: "/home", name: "home", component: HomeView },
    { path: "/classes", name: "classes", component: ClassesView },
    {
      path: "/classes/:name",
      name: "class-detail",
      component: ClassDetailView,
      props: true,
    },
    {
      path: "/students/:id",
      name: "student-detail",
      component: StudentDetailView,
      // 组件内用 useRoute() 取 id，且为多根节点，props: true 会产生透传告警
    },
    { path: "/photos", name: "photos", component: PhotosView },
    { path: "/timetable", name: "timetable", component: MyTimetableView },
    // 课堂模式：全屏沉浸（无侧边栏，同首页口径）；query.session 可直达指定会话
    { path: "/classroom", name: "classroom", component: ClassroomView },
    { path: "/recycle-bin", name: "recycle-bin", component: RecycleBinView },
    { path: "/profile", name: "profile", component: ProfileView },
    { path: "/settings", name: "settings", component: SettingsView },
  ],
});
