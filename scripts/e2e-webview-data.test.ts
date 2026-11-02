import { describe, expect, it } from "vitest";
import { e2eAppArgs, e2eDataRoot, sidFromWhoami } from "../e2e/webview-data";

describe("E2E WebView2 data directory", () => {
  it("keeps the data directory in a single EdgeDriver name=value argument", () => {
    expect(e2eAppArgs("C:\\Program Files\\Primus\\data")).toEqual([
      "--data-dir=C:\\Program Files\\Primus\\data",
    ]);
  });
  it.each(["S-1-5-21-123-456-789-1001", "S-1-12-1-123-456-789-1001", "S-1-5-18"])(
    "accepts %s",
    (sid) => {
      expect(sidFromWhoami(`"machine,user","${sid}"\r\n`)).toBe(sid);
    },
  );
  it("rejects absent or path-like SID values", () => {
    for (const value of ["", '"user","S-1-..\\other"', '"S-1-5-18","not-a-sid"'])
      expect(() => sidFromWhoami(value)).toThrow();
  });
  it("matches installed, release and debug data roots", () => {
    expect(e2eDataRoot("C:\\Program Files\\Primus\\Primus.exe", "E:\\primus")).toBe(
      "C:\\Program Files\\Primus\\data",
    );
    expect(e2eDataRoot("E:\\primus\\target\\release\\Primus.exe", "E:\\primus")).toBe(
      "E:\\primus\\target\\release\\data",
    );
    expect(e2eDataRoot("E:\\primus\\target\\debug\\Primus.exe", "E:\\primus")).toBe(
      "E:\\primus\\.dev-data",
    );
  });
});
