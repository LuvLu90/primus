import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "directory freeze does not modify an inheritable external hard link",
  () => {
    const data = resolve(".dev-data");
    mkdirSync(data, { recursive: true });
    const scratch = mkdtempSync(join(data, "install-acl-native-"));
    if (!scratch.startsWith(`${data}\\install-acl-native-`))
      throw new Error("invalid scratch path");
    try {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fileURLToPath(new URL("./install-acl-native.test.ps1", import.meta.url)),
          "-Scratch",
          scratch,
        ],
        {
          encoding: "utf8",
          timeout: 30000,
          env: Object.fromEntries(
            Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"),
          ),
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("native freeze does not propagate");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  40000,
);
