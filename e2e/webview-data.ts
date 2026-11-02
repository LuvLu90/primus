import { win32 } from "node:path";

/** whoami 的最后一个 CSV 字段；支持本地、域、Entra ID 与服务用户 SID。 */
export function sidFromWhoami(output: string): string {
  const sid = output.trim().split(",").at(-1)?.replaceAll('"', "");
  if (!sid || !/^S-1-(?:\d+-)*\d+$/.test(sid)) throw new Error("无法解析当前 Windows 用户 SID");
  return sid;
}

/** E2E 显式传 --data-dir：debug 用仓库 .dev-data，其余用被测程序同目录 data。 */
export function e2eDataRoot(application: string, repo: string): string {
  return application.split(/[\\/]/).some((part) => part.toLowerCase() === "debug")
    ? win32.join(repo, ".dev-data")
    : win32.join(win32.dirname(application), "data");
}
