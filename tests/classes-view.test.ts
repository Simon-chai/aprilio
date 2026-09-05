import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import ClassesView from "../src/views/ClassesView.vue";
import AppButton from "../src/components/ui/AppButton.vue";

describe("ClassesView.vue", () => {
  function createTestRouter() {
    return createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/home", name: "home", component: { template: "<div>Home</div>" } },
        { path: "/classes", name: "classes", component: ClassesView },
        {
          path: "/classes/:name",
          name: "class-detail",
          component: { template: "<div>ClassDetail</div>" },
          props: true,
        },
        { path: "/students", name: "students", component: { template: "<div>Students</div>" } },
        { path: "/photos", name: "photos", component: { template: "<div>Photos</div>" } },
      ],
    });
  }

  it("header action buttons all use AppButton and no raw unstyled button exists in header", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    const header = wrapper.get("header");
    const appButtons = header.findAllComponents(AppButton);
    const rawButtons = header.findAll("button");

    // Every button in the header must be managed by AppButton
    expect(appButtons.length).toBeGreaterThanOrEqual(2);
    expect(appButtons.length).toBe(rawButtons.length);

    // Specifically check import roster button and new class button
    const secondaryBtn = appButtons.find((btn) => btn.props("variant") === "secondary");
    const primaryBtn = appButtons.find((btn) => btn.props("variant") === "primary");
    expect(secondaryBtn).toBeDefined();
    expect(secondaryBtn?.text()).toContain("导入花名册");
    expect(primaryBtn).toBeDefined();
    expect(primaryBtn?.text()).toContain("新建班级");

    // Verify there are no raw unstyled buttons anywhere on the page
    const unstyledButtons = wrapper.findAll("button:not(.inline-flex)");
    expect(unstyledButtons.length).toBe(0);
  });

  it("renders class cards with RouterLink pointing to class-detail route and displays correct summary stats", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    // Find cards by looking for class card links
    const classLinks = wrapper.findAllComponents({ name: "RouterLink" }).filter((link) => {
      const to = link.props("to");
      if (typeof to === "string") {
        return to.startsWith("/classes/");
      }
      return typeof to === "object" && to !== null && (to.name === "class-detail" || to.path?.startsWith("/classes/"));
    });

    expect(classLinks.length).toBeGreaterThan(0);

    // Check link target for first card
    const firstLink = classLinks[0];
    const toProp = firstLink.props("to");
    if (typeof toProp === "object") {
      expect(toProp.name).toBe("class-detail");
      expect(toProp.params).toBeDefined();
      expect(toProp.params.name).toBeTruthy();
    } else {
      expect(toProp).toMatch(/^\/classes\/.+/);
    }

    // Check card details
    const text = wrapper.text();
    expect(text).toContain("男");
    expect(text).toContain("女");
    expect(text).toMatch(/照片 \d+ 张 \(公共 \d+ · 个人 \d+\)/);
    expect(text).toContain("进入班级 →");
  });
});
