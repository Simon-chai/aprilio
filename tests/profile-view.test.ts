import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileMocks = vi.hoisted(() => {
  const initialProfile = {
    name: "Initial Name",
    title: "Initial Title",
    motto: "Initial motto",
    avatar: "",
    hero: "",
  };

  return {
    profile: { value: { ...initialProfile } },
    ensureProfile: vi.fn(),
    profileImageSrc: vi.fn((value: string, kind: "avatar" | "hero") =>
      value || `${kind}-fallback`,
    ),
    selectProfileImage: vi.fn(),
    discardSelectedProfileImage: vi.fn(),
    saveProfileChanges: vi.fn(),
  };
});

vi.mock("../src/lib/profile", () => profileMocks);

import ProfileView from "../src/views/ProfileView.vue";
import { DEFAULT_PROFILE, PROFILE_TITLES, type Profile } from "../src/types";

const mountedHosts: VueWrapper[] = [];

function saveButtonOf(wrapper: VueWrapper) {
  return wrapper.find("header").findAll("button")[1];
}

function changeButtonOf(wrapper: VueWrapper, index = 0) {
  return wrapper
    .findAll("button")
    .filter((button) => button.classes().includes("bg-pearl"))[index];
}

function restoreButtonOf(wrapper: VueWrapper, index = 0) {
  return wrapper
    .findAll("button")
    .filter((button) => button.classes().includes("text-primary"))[index];
}

function draftOf(wrapper: VueWrapper): Profile {
  return (wrapper.vm as unknown as { draft: Profile }).draft;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function mountEditor() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: { template: "<div>home</div>" } },
      { path: "/profile", component: ProfileView },
      { path: "/other", component: { template: "<div>other</div>" } },
      {
        path: "/blocked",
        component: { template: "<div>blocked</div>" },
        beforeEnter: () => false,
      },
    ],
  });
  await router.push("/profile");
  await router.isReady();

  const host = mount({ template: "<RouterView />" }, {
    attachTo: document.body,
    global: { plugins: [router] },
  });
  mountedHosts.push(host);
  await flushPromises();

  return { host, router, wrapper: host.findComponent(ProfileView) };
}

beforeEach(() => {
  profileMocks.profile.value = { ...DEFAULT_PROFILE };
  profileMocks.ensureProfile.mockReset().mockResolvedValue(undefined);
  profileMocks.profileImageSrc.mockClear();
  profileMocks.selectProfileImage.mockReset().mockResolvedValue(null);
  profileMocks.discardSelectedProfileImage.mockReset().mockResolvedValue(undefined);
  profileMocks.saveProfileChanges
    .mockReset()
    .mockImplementation(async (next: Profile) => {
      profileMocks.profile.value = { ...next };
    });
});

afterEach(() => {
  for (const host of mountedHosts.splice(0)) {
    const element = host.element;
    host.unmount();
    element?.remove();
  }
  vi.restoreAllMocks();
});

describe("profile editor", () => {
  it("registers the profile route", async () => {
    const { router } = await import("../src/router");

    expect(router.resolve("/profile").name).toBe("profile");
  });

  it("shows a validation alert and focuses the name when it is blank", async () => {
    const { wrapper } = await mountEditor();
    const nameInput = wrapper.get("#profile-name");
    await nameInput.setValue("   ");

    await saveButtonOf(wrapper).trigger("click");

    expect(wrapper.get('[role="alert"]').text()).toContain("\u8BF7\u8F93\u5165\u59D3\u540D");
    expect(document.activeElement).toBe(nameInput.element);
    expect(profileMocks.saveProfileChanges).not.toHaveBeenCalled();
  });

  it("previews draft text immediately without changing the shared profile", async () => {
    const { wrapper } = await mountEditor();

    await wrapper.get("#profile-name").setValue("Draft Name");
    await wrapper.get("#profile-title").setValue("家长");
    await wrapper.get("#profile-motto").setValue("Draft motto");
    await flushPromises();

    expect(wrapper.text()).toContain("Draft Name");
    expect(wrapper.find('[data-test="preview-title"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("Draft motto");
    expect(profileMocks.profile.value).toEqual(DEFAULT_PROFILE);
    expect(profileMocks.saveProfileChanges).not.toHaveBeenCalled();
  });

  it("navigates to home after a successful save", async () => {
    const { router, wrapper } = await mountEditor();
    await wrapper.get("#profile-name").setValue("Saved Name");

    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(profileMocks.saveProfileChanges).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.name).toBe("home");
    expect(router.currentRoute.value.path).toBe("/");
  });

  it("stays on the profile page when the save fails", async () => {
    const { router, wrapper } = await mountEditor();
    profileMocks.saveProfileChanges.mockRejectedValueOnce(new Error("database unavailable"));
    await wrapper.get("#profile-name").setValue("Unsaved Name");

    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/profile");
    expect(wrapper.get('[role="alert"]').text()).toBe(
      "保存失败：本地资料暂时无法保存，请重试。",
    );
  });

  it("saves trimmed fields and publishes the saved profile to the shared source", async () => {
    const { wrapper } = await mountEditor();

    await wrapper.get("#profile-name").setValue("  Teacher  ");
    await wrapper.get("#profile-title").setValue("学校管理");
    await wrapper.get("#profile-motto").setValue("  Stay curious  ");

    expect(wrapper.findAll("header button")).toHaveLength(2);
    expect(saveButtonOf(wrapper).text()).toBe("\u4FDD\u5B58\u66F4\u6539");
    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();

    const expected: Profile = {
      name: "Teacher",
      title: "学校管理",
      motto: "Stay curious",
      avatar: "",
      hero: "",
      timetable_bg: "",
      my_subjects: [],
    };
    expect(profileMocks.saveProfileChanges).toHaveBeenCalledWith(expected);
    expect(profileMocks.profile.value).toEqual(expected);
    expect(saveButtonOf(wrapper).attributes("disabled")).toBeDefined();
  });

  it("offers the identity enum in a dropdown and keeps legacy values selectable", async () => {
    profileMocks.profile.value = { ...DEFAULT_PROFILE, title: "班主任" };
    const { wrapper } = await mountEditor();

    const select = wrapper.get("#profile-title");
    const values = select.findAll("option").map((option) => option.element.value);

    expect(values).toContain("");
    for (const title of PROFILE_TITLES) expect(values).toContain(title);
    expect(values).toContain("班主任");
    expect((select.element as HTMLSelectElement).value).toBe("班主任");
  });

  it("disables every editor control while a save is pending", async () => {
    profileMocks.profile.value = {
      ...DEFAULT_PROFILE,
      avatar: "current-avatar.png",
      hero: "current-hero.png",
    };
    const saving = deferred<void>();
    profileMocks.saveProfileChanges.mockReturnValueOnce(saving.promise);
    const { wrapper } = await mountEditor();

    await wrapper.get("#profile-name").setValue("Pending Name");
    await saveButtonOf(wrapper).trigger("click");

    expect(wrapper.get("#profile-name").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#profile-title").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#profile-motto").attributes("disabled")).toBeDefined();
    expect(changeButtonOf(wrapper, 0).attributes("disabled")).toBeDefined();
    expect(changeButtonOf(wrapper, 1).attributes("disabled")).toBeDefined();
    expect(restoreButtonOf(wrapper, 0).attributes("disabled")).toBeDefined();
    expect(restoreButtonOf(wrapper, 1).attributes("disabled")).toBeDefined();

    saving.resolve();
    await flushPromises();

    expect(wrapper.get("#profile-name").attributes("disabled")).toBeUndefined();
    expect(changeButtonOf(wrapper, 0).attributes("disabled")).toBeUndefined();
    expect(restoreButtonOf(wrapper, 0).attributes("disabled")).toBeUndefined();
  });

  it("keeps all editor controls disabled until profile initialization completes", async () => {
    profileMocks.profile.value = {
      ...DEFAULT_PROFILE,
      avatar: "initial-avatar.png",
      hero: "initial-hero.png",
    };
    const initialization = deferred<void>();
    profileMocks.ensureProfile.mockReturnValueOnce(initialization.promise);
    const { wrapper } = await mountEditor();

    expect(wrapper.get("#profile-name").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#profile-title").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#profile-motto").attributes("disabled")).toBeDefined();
    expect(changeButtonOf(wrapper, 0).attributes("disabled")).toBeDefined();
    expect(changeButtonOf(wrapper, 1).attributes("disabled")).toBeDefined();
    expect(restoreButtonOf(wrapper, 0).attributes("disabled")).toBeDefined();
    expect(restoreButtonOf(wrapper, 1).attributes("disabled")).toBeDefined();

    profileMocks.profile.value = {
      ...DEFAULT_PROFILE,
      name: "Loaded Name",
      avatar: "loaded-avatar.png",
      hero: "loaded-hero.png",
    };
    initialization.resolve();
    await flushPromises();

    expect((wrapper.get("#profile-name").element as HTMLInputElement).value).toBe("Loaded Name");
    expect(wrapper.get("#profile-name").attributes("disabled")).toBeUndefined();
    expect(changeButtonOf(wrapper, 0).attributes("disabled")).toBeUndefined();
  });

  it("leaves the draft unchanged when image selection is cancelled", async () => {
    const { wrapper } = await mountEditor();
    await wrapper.get("#profile-name").setValue("Keep this name");
    profileMocks.selectProfileImage.mockResolvedValueOnce(null);

    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect((wrapper.get("#profile-name").element as HTMLInputElement).value).toBe("Keep this name");
    expect(profileMocks.profile.value.avatar).toBe("");
    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalled();
  });

  it("shows image selection errors without contaminating the draft", async () => {
    const { wrapper } = await mountEditor();
    await wrapper.get("#profile-name").setValue("Safe name");
    profileMocks.selectProfileImage.mockRejectedValueOnce(new Error("image read failed"));

    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain("image read failed");
    expect((wrapper.get("#profile-name").element as HTMLInputElement).value).toBe("Safe name");
    expect(profileMocks.profile.value).toEqual(DEFAULT_PROFILE);
  });

  it("uses a readable fallback for a non-Error image selection rejection", async () => {
    const { wrapper } = await mountEditor();
    profileMocks.selectProfileImage.mockRejectedValueOnce(null);

    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    const alert = wrapper.get('[role="alert"]').text();
    expect(alert).not.toMatch(/null|undefined/);
    expect(alert).not.toBe("");
  });

  it("discards the previous pending Tauri file when replacing an image", async () => {
    const { wrapper } = await mountEditor();
    profileMocks.selectProfileImage
      .mockResolvedValueOnce({ value: "first-avatar.png", fileName: "first-avatar.png" })
      .mockResolvedValueOnce({ value: "second-avatar.png", fileName: "second-avatar.png" });

    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();
    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledOnce();
    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledWith("first-avatar.png");
    expect(wrapper.findAll("img")[2].attributes("src")).toBe("second-avatar.png");
    expect(profileMocks.profile.value.avatar).toBe("");
  });

  it("discards a pending Tauri file when restoring the default image", async () => {
    const { wrapper } = await mountEditor();
    profileMocks.selectProfileImage.mockResolvedValueOnce({
      value: "hero-draft.jpg",
      fileName: "hero-draft.jpg",
    });

    await changeButtonOf(wrapper, 1).trigger("click");
    await flushPromises();
    await restoreButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledWith("hero-draft.jpg");
    expect(wrapper.findAll("img")[3].attributes("src")).toBe("hero-fallback");
    expect(profileMocks.profile.value.hero).toBe("");
  });

  it("keeps a failed save unsaved and leaves the shared profile unchanged", async () => {
    const { wrapper } = await mountEditor();
    profileMocks.saveProfileChanges.mockRejectedValueOnce(new Error("database unavailable"));
    await wrapper.get("#profile-name").setValue("Unsaved Name");

    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe(
      "保存失败：本地资料暂时无法保存，请重试。",
    );
    expect((wrapper.get("#profile-name").element as HTMLInputElement).value).toBe("Unsaved Name");
    expect(profileMocks.profile.value).toEqual(DEFAULT_PROFILE);
    expect(saveButtonOf(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("shows an actionable database permission error beside the save action", async () => {
    const { wrapper } = await mountEditor();
    profileMocks.saveProfileChanges.mockRejectedValueOnce(
      new Error("command execute not allowed"),
    );
    await wrapper.get("#profile-name").setValue("Unsaved Name");

    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();

    const headerAlert = wrapper.find('header [role="alert"]');
    expect(headerAlert.exists()).toBe(true);
    expect(headerAlert.attributes("aria-live")).toBe("assertive");
    expect(headerAlert.text()).toContain("本地数据库写入权限");
    expect((wrapper.get("#profile-name").element as HTMLInputElement).value).toBe(
      "Unsaved Name",
    );
    expect(saveButtonOf(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("uses a readable fallback for a non-Error save rejection", async () => {
    const { wrapper } = await mountEditor();
    profileMocks.saveProfileChanges.mockRejectedValueOnce(undefined);
    await wrapper.get("#profile-name").setValue("Failed Name");

    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();

    const alert = wrapper.get('[role="alert"]').text();
    expect(alert).not.toMatch(/null|undefined/);
    expect(alert).not.toBe("");
  });

  it("blocks navigation while image selection is pending", async () => {
    const selection = deferred<null>();
    profileMocks.selectProfileImage.mockReturnValueOnce(selection.promise);
    const { router, wrapper } = await mountEditor();

    await changeButtonOf(wrapper).trigger("click");
    await router.push("/other");

    expect(router.currentRoute.value.path).toBe("/profile");

    selection.resolve(null);
    await flushPromises();
    await router.push("/other");
    expect(router.currentRoute.value.path).toBe("/other");
  });

  it("discards a selected file returned after the editor is unmounted", async () => {
    const selection = deferred<{ value: string; fileName: string }>();
    profileMocks.selectProfileImage.mockReturnValueOnce(selection.promise);
    const { host, wrapper } = await mountEditor();

    await changeButtonOf(wrapper).trigger("click");
    host.unmount();

    selection.resolve({ value: "late-avatar.png", fileName: "late-avatar.png" });
    await flushPromises();

    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledWith("late-avatar.png");
    expect(profileMocks.profile.value).toEqual(DEFAULT_PROFILE);
  });

  it("finishes the selection lifecycle after cancellation", async () => {
    const selection = deferred<null>();
    profileMocks.selectProfileImage.mockReturnValueOnce(selection.promise);
    const { router, wrapper } = await mountEditor();

    await changeButtonOf(wrapper).trigger("click");
    selection.resolve(null);
    await flushPromises();
    await router.push("/other");

    expect(router.currentRoute.value.path).toBe("/other");
    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalled();
  });

  it("finishes the selection lifecycle after an error", async () => {
    const selection = deferred<never>();
    profileMocks.selectProfileImage.mockReturnValueOnce(selection.promise);
    const { router, wrapper } = await mountEditor();

    await changeButtonOf(wrapper).trigger("click");
    selection.reject(new Error("picker failed"));
    await flushPromises();
    await router.push("/other");

    expect(router.currentRoute.value.path).toBe("/other");
    expect(wrapper.get('[role="alert"]').text()).toContain("picker failed");
  });

  it("keeps pending files after cancel and cleans them after confirmed navigation", async () => {
    const { router, wrapper } = await mountEditor();
    profileMocks.selectProfileImage.mockResolvedValueOnce({
      value: "temporary-avatar.png",
      fileName: "temporary-avatar.png",
    });
    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await router.push("/other");
    expect(router.currentRoute.value.path).toBe("/profile");
    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalled();
    expect(wrapper.get("#profile-name").attributes("disabled")).toBeUndefined();
    expect(changeButtonOf(wrapper).attributes("disabled")).toBeUndefined();

    confirm.mockReturnValue(true);
    await router.push("/other");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/other");
    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledWith("temporary-avatar.png");
  });

  it("clears pending file tracking after a successful save without deleting the saved image", async () => {
    const { router, wrapper } = await mountEditor();
    profileMocks.selectProfileImage.mockResolvedValueOnce({
      value: "saved-avatar.png",
      fileName: "saved-avatar.png",
    });
    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();
    await router.push("/other");
    await flushPromises();

    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalled();
    expect(profileMocks.profile.value.avatar).toBe("saved-avatar.png");
  });

  it("does not save a text draft while deferred image selection is pending", async () => {
    const selection = deferred<{ value: string; fileName?: string } | null>();
    profileMocks.selectProfileImage.mockReturnValueOnce(selection.promise);
    const { wrapper } = await mountEditor();

    await wrapper.get("#profile-name").setValue("draft-name");
    await changeButtonOf(wrapper).trigger("click");

    const saveButton = saveButtonOf(wrapper);
    expect(saveButton.attributes("disabled")).toBeDefined();
    await saveButton.trigger("click");
    expect(profileMocks.saveProfileChanges).not.toHaveBeenCalled();

    selection.resolve({ value: "selected-avatar.png" });
    await flushPromises();
    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(profileMocks.saveProfileChanges).toHaveBeenCalledWith({
      name: "draft-name",
      title: DEFAULT_PROFILE.title,
      motto: DEFAULT_PROFILE.motto,
      avatar: "selected-avatar.png",
      hero: DEFAULT_PROFILE.hero,
      timetable_bg: "",
      my_subjects: [],
    });
  });

  it("waits for the previous pending file cleanup before saving a replacement", async () => {
    profileMocks.selectProfileImage
      .mockResolvedValueOnce({ value: "old-avatar.png", fileName: "old-avatar.png" })
      .mockResolvedValueOnce({ value: "new-avatar.png", fileName: "new-avatar.png" });
    const { wrapper } = await mountEditor();

    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    const cleanup = deferred<void>();
    profileMocks.discardSelectedProfileImage.mockReturnValueOnce(cleanup.promise);
    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    const saveButton = saveButtonOf(wrapper);
    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledWith("old-avatar.png");
    expect(saveButton.attributes("disabled")).toBeDefined();
    await saveButton.trigger("click");
    expect(profileMocks.saveProfileChanges).not.toHaveBeenCalled();

    cleanup.resolve();
    await flushPromises();
    expect(wrapper.findAll("img")[2].attributes("src")).toBe("new-avatar.png");
    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalledWith("new-avatar.png");

    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();
    expect(profileMocks.saveProfileChanges).toHaveBeenCalledWith({
      name: DEFAULT_PROFILE.name,
      title: DEFAULT_PROFILE.title,
      motto: DEFAULT_PROFILE.motto,
      avatar: "new-avatar.png",
      hero: DEFAULT_PROFILE.hero,
      timetable_bg: "",
      my_subjects: [],
    });
    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalledWith("new-avatar.png");
  });

  it("keeps save blocked while restoring a pending image", async () => {
    profileMocks.selectProfileImage.mockResolvedValueOnce({
      value: "pending-hero.png",
      fileName: "pending-hero.png",
    });
    const { wrapper } = await mountEditor();

    await changeButtonOf(wrapper, 1).trigger("click");
    await flushPromises();

    const cleanup = deferred<void>();
    profileMocks.discardSelectedProfileImage.mockReturnValueOnce(cleanup.promise);
    await restoreButtonOf(wrapper).trigger("click");
    await flushPromises();

    const saveButton = saveButtonOf(wrapper);
    expect(saveButton.attributes("disabled")).toBeDefined();
    await saveButton.trigger("click");
    expect(profileMocks.saveProfileChanges).not.toHaveBeenCalled();

    cleanup.resolve();
    await flushPromises();
    expect(wrapper.findAll("img")[3].attributes("src")).toBe("hero-fallback");
  });

  it("attempts every pending file in one kind and retries failed files", async () => {
    profileMocks.selectProfileImage
      .mockResolvedValueOnce({ value: "old-avatar.png", fileName: "old-avatar.png" })
      .mockResolvedValueOnce({ value: "new-avatar.png", fileName: "new-avatar.png" });
    const { wrapper } = await mountEditor();

    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();
    profileMocks.discardSelectedProfileImage
      .mockRejectedValueOnce(new Error("old file cleanup failed"))
      .mockRejectedValueOnce(new Error("new file cleanup failed"))
      .mockResolvedValue(undefined);

    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(profileMocks.discardSelectedProfileImage).toHaveBeenNthCalledWith(1, "old-avatar.png");
    expect(profileMocks.discardSelectedProfileImage).toHaveBeenNthCalledWith(2, "new-avatar.png");
    expect(wrapper.get('[role="alert"]').text()).toContain("old file cleanup failed");
    expect(wrapper.findAll("img")[2].attributes("src")).toBe("old-avatar.png");

    const retry = deferred<void>();
    let secondRetryCalled = false;
    profileMocks.discardSelectedProfileImage.mockImplementation((fileName: string) => {
      if (fileName === "old-avatar.png") {
        return Promise.reject(new Error("old retry failed"));
      }
      if (fileName === "new-avatar.png") {
        secondRetryCalled = true;
        return retry.promise;
      }
      return Promise.resolve();
    });

    const restore = restoreButtonOf(wrapper).trigger("click");
    await flushPromises();
    expect(secondRetryCalled).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);

    retry.resolve();
    await restore;
    await flushPromises();

    expect(profileMocks.discardSelectedProfileImage).toHaveBeenNthCalledWith(3, "old-avatar.png");
    expect(profileMocks.discardSelectedProfileImage).toHaveBeenNthCalledWith(4, "new-avatar.png");
    expect(wrapper.get('[role="alert"]').text()).toContain("old retry failed");
    expect(wrapper.findAll("img")[2].attributes("src")).toBe("old-avatar.png");

    profileMocks.discardSelectedProfileImage.mockResolvedValue(undefined);
    await restoreButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(wrapper.findAll("img")[2].attributes("src")).toBe("avatar-fallback");
  });

  it("keeps a pending draft previewable and saveable when a later guard cancels navigation", async () => {
    profileMocks.selectProfileImage.mockResolvedValueOnce({
      value: "pending-avatar.png",
      fileName: "pending-avatar.png",
    });
    const { router, wrapper } = await mountEditor();

    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();
    await wrapper.get("#profile-name").setValue("Pending draft");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await router.push("/blocked");
    await flushPromises();

    expect(confirm).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.path).toBe("/profile");
    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalled();
    expect(wrapper.findAll("img")[2].attributes("src")).toBe("pending-avatar.png");
    expect(wrapper.text()).toContain("Pending draft");
    expect(wrapper.get("#profile-name").attributes("disabled")).toBeUndefined();

    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(profileMocks.saveProfileChanges).toHaveBeenCalledWith({
      name: "Pending draft",
      title: DEFAULT_PROFILE.title,
      motto: DEFAULT_PROFILE.motto,
      avatar: "pending-avatar.png",
      hero: DEFAULT_PROFILE.hero,
      timetable_bg: "",
      my_subjects: [],
    });
    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalled();
  });

  it("waits for an active image operation before unmount cleanup", async () => {
    profileMocks.selectProfileImage.mockResolvedValueOnce({
      value: "old-avatar.png",
      fileName: "old-avatar.png",
    });
    const { host, wrapper } = await mountEditor();

    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    const selection = deferred<{ value: string; fileName: string }>();
    const cleanup = deferred<void>();
    profileMocks.selectProfileImage.mockReturnValueOnce(selection.promise);
    profileMocks.discardSelectedProfileImage.mockImplementation((fileName: string) => {
      if (fileName === "old-avatar.png") return cleanup.promise;
      return Promise.resolve();
    });

    const choosing = changeButtonOf(wrapper).trigger("click");
    selection.resolve({ value: "late-avatar.png", fileName: "late-avatar.png" });
    await flushPromises();
    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledOnce();
    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledWith("old-avatar.png");

    host.unmount();
    await flushPromises();
    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledTimes(1);

    cleanup.resolve();
    await choosing;
    await flushPromises();

    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledTimes(2);
    expect(profileMocks.discardSelectedProfileImage).toHaveBeenNthCalledWith(2, "late-avatar.png");
  });

  it("starts cleanup for both pending image kinds during unmount", async () => {
    profileMocks.selectProfileImage
      .mockResolvedValueOnce({ value: "old-avatar.png", fileName: "old-avatar.png" })
      .mockResolvedValueOnce({ value: "pending-hero.png", fileName: "pending-hero.png" });
    const { host, wrapper } = await mountEditor();

    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();
    await changeButtonOf(wrapper, 1).trigger("click");
    await flushPromises();

    const avatarCleanup = deferred<void>();
    const heroCleanup = deferred<void>();
    profileMocks.discardSelectedProfileImage.mockImplementation((fileName: string) => {
      if (fileName === "old-avatar.png") return avatarCleanup.promise;
      if (fileName === "pending-hero.png") return heroCleanup.promise;
      return Promise.resolve();
    });

    host.unmount();
    await flushPromises();

    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledWith("old-avatar.png");
    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledWith("pending-hero.png");

    avatarCleanup.resolve();
    heroCleanup.resolve();
    await flushPromises();
  });

  it("restores controls after a later navigation guard cancels leaving", async () => {
    const { router, wrapper } = await mountEditor();

    await router.push("/blocked");

    expect(router.currentRoute.value.path).toBe("/profile");
    expect(wrapper.get("#profile-name").attributes("disabled")).toBeUndefined();
    expect(changeButtonOf(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("waits for a deferred save before cleaning a pending image on unmount", async () => {
    profileMocks.selectProfileImage.mockResolvedValueOnce({
      value: "saved-avatar.png",
      fileName: "saved-avatar.png",
    });
    const { host, wrapper } = await mountEditor();
    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    const save = deferred<void>();
    profileMocks.saveProfileChanges.mockImplementationOnce(async (next: Profile) => {
      await save.promise;
      profileMocks.profile.value = { ...next };
    });
    await saveButtonOf(wrapper).trigger("click");
    expect(profileMocks.saveProfileChanges).toHaveBeenCalledOnce();

    host.unmount();
    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalled();

    save.resolve();
    await flushPromises();

    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalled();
    expect(profileMocks.profile.value.avatar).toBe("saved-avatar.png");
  });

  it("cleans a pending image after a rejected save settles during unmount", async () => {
    profileMocks.selectProfileImage.mockResolvedValueOnce({
      value: "failed-save-avatar.png",
      fileName: "failed-save-avatar.png",
    });
    const { host, wrapper } = await mountEditor();
    await changeButtonOf(wrapper).trigger("click");
    await flushPromises();

    const save = deferred<void>();
    profileMocks.saveProfileChanges.mockImplementationOnce(async () => {
      await save.promise;
      throw new Error("persist failed");
    });
    await saveButtonOf(wrapper).trigger("click");
    expect(profileMocks.saveProfileChanges).toHaveBeenCalledOnce();

    host.unmount();
    expect(profileMocks.discardSelectedProfileImage).not.toHaveBeenCalled();

    save.resolve();
    await flushPromises();

    expect(profileMocks.discardSelectedProfileImage).toHaveBeenCalledWith(
      "failed-save-avatar.png",
    );
  });

  it("does not apply deferred profile initialization after unmount", async () => {
    const initialization = deferred<void>();
    profileMocks.ensureProfile.mockReturnValueOnce(initialization.promise);
    const { host, wrapper } = await mountEditor();

    profileMocks.profile.value = { ...DEFAULT_PROFILE, name: "Late Name" };
    host.unmount();
    initialization.resolve();
    await flushPromises();

    expect(draftOf(wrapper).name).toBe(DEFAULT_PROFILE.name);
  });
});

describe("profile subject editor (任教学科)", () => {
  afterEach(() => {
    for (const host of mountedHosts.splice(0)) {
      const element = host.element;
      host.unmount();
      element?.remove();
    }
    vi.restoreAllMocks();
  });

  function chipOf(wrapper: VueWrapper, label: string) {
    return wrapper.findAll('button[data-test="subject-chip"]').find((b) => b.text() === label);
  }

  it("toggles a subject chip and saves it into my_subjects", async () => {
    const { wrapper } = await mountEditor();
    const chip = chipOf(wrapper, "语文")!;

    await chip.trigger("click");
    expect(chip.classes()).toContain("bg-ink");
    expect(saveButtonOf(wrapper).attributes("disabled")).toBeUndefined();

    await saveButtonOf(wrapper).trigger("click");
    await flushPromises();

    expect(profileMocks.saveProfileChanges).toHaveBeenCalledWith(
      expect.objectContaining({ my_subjects: ["语文"] }),
    );
    expect(profileMocks.profile.value.my_subjects).toEqual(["语文"]);
    expect(saveButtonOf(wrapper).attributes("disabled")).toBeDefined();
  });

  it("adds a custom subject as a selected chip without duplicating it", async () => {
    const { wrapper } = await mountEditor();
    const input = wrapper.get("#profile-new-subject");
    await input.setValue("  写字 ");
    const addBtn = wrapper.findAll("button").find((b) => b.text() === "添加")!;
    await addBtn.trigger("click");

    const chip = chipOf(wrapper, "写字")!;
    expect(chip).toBeDefined();
    expect(chip.classes()).toContain("bg-ink");
    expect((input.element as HTMLInputElement).value).toBe("");

    // 重复添加只保留一份；再点一次 chip 可取消选择
    await input.setValue("写字");
    await addBtn.trigger("click");
    expect(wrapper.findAll('button[data-test="subject-chip"]').filter((b) => b.text() === "写字")).toHaveLength(1);
    await chip.trigger("click");
    expect(chip.classes()).not.toContain("bg-ink");
  });
});
