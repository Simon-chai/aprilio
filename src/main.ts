import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { initAgentMemory } from "./agent/memory";
import { initLogging } from "./lib/logger";
import "./style.css";

const app = createApp(App);

// Vue 组件内的异常：照常打印（经 logger 桥接落盘）
app.config.errorHandler = (err, _instance, info) => {
  console.error(`[vue:${info}]`, err);
};

app.use(router).mount("#app");
initLogging();
// 助手记忆：播种模板 + 积压的对话片段安排一次后台补整理
initAgentMemory();
