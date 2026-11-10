import { beforeEach, describe, expect, it } from "vitest";
import {
  initialSessionListPrefs,
  PROJECT_NAME_MAX,
  sanitizePrefs,
  useSessionListPrefs,
} from "./session-list-prefs";

describe("会话列表偏好", () => {
  beforeEach(() => {
    localStorage.clear();
    useSessionListPrefs.setState(initialSessionListPrefs);
  });

  it("置顶：新置顶的在前，再次切换取消；移除项目同时取消置顶", () => {
    const s = useSessionListPrefs.getState();
    s.togglePinned("d:/a");
    s.togglePinned("d:/b");
    expect(useSessionListPrefs.getState().pinned).toEqual(["d:/b", "d:/a"]);
    s.togglePinned("d:/b");
    expect(useSessionListPrefs.getState().pinned).toEqual(["d:/a"]);
    s.remove("d:/a", 123);
    expect(useSessionListPrefs.getState()).toMatchObject({ pinned: [], removed: { "d:/a": 123 } });
  });

  it("改名去掉首尾空白并限制长度，留空删除", () => {
    const s = useSessionListPrefs.getState();
    s.rename("d:/a", `  ${"名".repeat(PROJECT_NAME_MAX + 5)}  `);
    expect(useSessionListPrefs.getState().names["d:/a"]).toBe("名".repeat(PROJECT_NAME_MAX));
    s.rename("d:/a", "   ");
    expect(useSessionListPrefs.getState().names).toEqual({});
  });

  it("本地存储里类型不对的字段被丢掉", () => {
    expect(sanitizePrefs(null)).toEqual({});
    expect(
      sanitizePrefs({
        projectsOpen: "yes",
        expanded: { "d:/a": true, "d:/b": 1 },
        pinned: ["d:/a", 3, "d:/a"],
        names: { "d:/a": "甲", "d:/b": " ", "d:/c": 2 },
        removed: { "d:/a": 5, "d:/b": "x", "d:/c": Number.NaN },
      }),
    ).toEqual({
      expanded: { "d:/a": true },
      pinned: ["d:/a"],
      names: { "d:/a": "甲" },
      removed: { "d:/a": 5 },
    });
  });

  it("从本地存储恢复", async () => {
    localStorage.setItem(
      "primus.sessionList",
      JSON.stringify({
        state: { projectsOpen: false, expanded: { "d:/a": false }, pinned: "bad" },
        version: 1,
      }),
    );
    await useSessionListPrefs.persist.rehydrate();
    expect(useSessionListPrefs.getState()).toMatchObject({
      projectsOpen: false,
      expanded: { "d:/a": false },
      pinned: [],
    });
  });
});
