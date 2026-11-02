import { win32 } from "node:path";

/** whoami 的最后一个 CSV 字段；支持本地、域、Entra ID 与服务用户 SID。 */
export function sidFromWhoami(output: string): string {
  const sid = output.trim().split(",").at(-1)?.replaceAll('"', "");
  if (!sid || !/^S-1-(?:\d+-)*\d+$/.test(sid)) throw new Error("无法解析当前 Windows 用户 SID");
  return sid;
}

/** E2E 显式传 --data-dir：debug 用仓库 .dev-data，其余用被测程序同目录 data。 */
export function e2eDataRoot(application: string, repo: string): string {
  const normalized = application.replaceAll("/", "\\");
  return /\\target\\(?:[^\\]+\\)?debug\\[^\\]+\.exe$/i.test(normalized)
    ? win32.join(repo, ".dev-data")
    : win32.join(win32.dirname(application), "data");
}

/** EdgeDriver 会把 args 重写为开关，值必须与名称放在同一个 name=value 参数中。 */
export function e2eAppArgs(dataRoot: string): string[] {
  return [`--data-dir=${dataRoot}`];
}
