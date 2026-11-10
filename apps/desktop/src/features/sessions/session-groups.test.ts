import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@/lib/platform/types";
import { buildRows, isProjectWorkspace, workspaceKey, workspaceName } from "./session-groups";

const s = (n: number, workspace: string): SessionSummary => ({
  path: `/s/${n}.jsonl`,
  id: `id-${n}`,
  name: null,
  title: `会话 ${n}`,
  workspace,
  createdAt: 0,
  updatedAt: 100 - n,
  messageCount: 1,
  archived: false,
});

const DEFAULT = "C:\\Primus\\data\\users\\S-1-5-21\\chat";
const KEY = workspaceKey(DEFAULT);

describe("会话分组", () => {
  it("默认工作目录与空串不算项目；项目名取最后一段，比较不分大小写与斜杠", () => {
    expect(isProjectWorkspace(DEFAULT, KEY)).toBe(false);
    expect(isProjectWorkspace("c:/primus/data/users/s-1-5-21/chat/", KEY)).toBe(false);
    expect(isProjectWorkspace("", KEY)).toBe(false);
    expect(isProjectWorkspace("D:\\code\\tihu", KEY)).toBe(true);
    // 只与当前用户的默认目录比较：别处同样以 users/<名>/chat 结尾的文件夹仍是项目
    expect(isProjectWorkspace("D:\\projects\\users\\alice\\chat", KEY)).toBe(true);
    expect(workspaceName("D:\\code\\tihu\\")).toBe("tihu");
    expect(workspaceKey("D:\\Code\\Tihu\\")).toBe(workspaceKey("d:/code/tihu"));
  });

  it("项目在前（最近活动的默认展开），无项目的会话在“最近”", () => {
    const rows = buildRows([s(1, "D:\\a"), s(2, DEFAULT), s(3, "D:\\b"), s(4, "d:/a/")], {
      projectsOpen: true,
      toggled: {},
      defaultKey: KEY,
    });
    expect(rows.map((r) => (r.kind === "session" ? r.session.id : r.key))).toEqual([
      "h:projects",
      "p:d:/a",
      "id-1",
      "id-4",
      "p:d:/b",
      "h:recent",
      "id-2",
    ]);
  });

  it("用户折叠与当前标签所在项目；“项目”分组收起时只留标题", () => {
    const list = [s(1, "D:\\a"), s(2, "D:\\b")];
    const rows = buildRows(list, {
      projectsOpen: true,
      toggled: { "d:/a": false },
      activeKey: "d:/b",
    });
    expect(rows.filter((r) => r.kind === "session").map((r) => r.key)).toEqual(["/s/2.jsonl"]);
    expect(
      buildRows(list, { projectsOpen: false, toggled: {}, defaultKey: KEY }).map((r) => r.key),
    ).toEqual(["h:projects"]);
  });

  it("没有项目时不显示分组标题", () => {
    expect(
      buildRows([s(1, DEFAULT)], { projectsOpen: true, toggled: {}, defaultKey: KEY }),
    ).toEqual([{ kind: "session", key: "/s/1.jsonl", session: s(1, DEFAULT), nested: false }]);
  });
});
