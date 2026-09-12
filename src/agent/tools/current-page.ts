/**
 * 工具：current_page —— 查看当前页面的渲染上下文（声明式注册，default export 即被容器装载）。
 *
 * 页面渲染的事实（标题、路由参数、页签、加载完成的真实数据）只有视图知道，
 * 由视图经 page-context-bus 上报快照；本工具读取最新快照回喂模型，
 * 作为 system prompt 注入之外的主动查看通道。视图未上报时如实说明并指引改用其他工具。
 */
import { defineAgentTool } from "../define";
import { getPageContext } from "../page-context-bus";

export default defineAgentTool({
  name: "current_page",
  label: "当前页面",
  description:
    "查看当前页面的渲染上下文：页面标题、路由参数与页面上的关键数据/状态摘要（如正在看哪个班的详情、当前在哪个页签）。" +
    "用户以「这个班」「当前页面」等指代提问、或需要确认页面实际渲染内容时使用；" +
    "最新快照会随 system prompt 注入，通常无需主动调用。",
  tags: ["readonly"],
  parameters: {
    type: "object",
    properties: {
      page: {
        type: "string",
        description: "页面路由名（可选）；缺省读当前路由的快照",
      },
    },
  },
  async execute(args, ctx) {
    const requested = String(args.page ?? "").trim();
    const liveRoute = ctx.router?.currentRoute?.value?.name;
    const routeName =
      requested || (typeof liveRoute === "string" ? liveRoute : "");
    if (!routeName) {
      return { ok: false, summary: "", error: "无法确定当前页面（路由信息缺失）。" };
    }
    const snapshot = getPageContext(routeName);
    if (!snapshot) {
      return {
        ok: true,
        summary: `当前路由：${routeName}。该页面没有上报渲染上下文，可改用 query_data 查数据、find_docs 查文档。`,
        data: { page: routeName },
      };
    }
    return {
      ok: true,
      summary: `当前页面：${snapshot.title}（${snapshot.page}）\n渲染概况：${snapshot.summary}`,
      data: snapshot,
    };
  },
});
