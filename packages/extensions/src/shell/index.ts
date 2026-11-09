// primus-shell：见 packages/extensions/README.md 与技术方案第 12.3、12.4 节、附录 A。
// Windows 上薄壳在找得到 PowerShell 时把 Core 的命令工具从 bash（Git Bash）换成 powershell（settings.json 的
// defaultTools）。Core 的 powershell 工具会告诉模型这是 PowerShell，但模型仍常写 bash 习惯的命令；
// 本机多数只有 Windows PowerShell 5.1，它不支持 `&&` / `||`，`rm -rf`、`ls -la` 等也会报错。
// 这里在每轮开始前、命令工具只有 powershell 时，往系统提示词末尾追加 PowerShell 的写法要点，不改动 Core。

/** 命令工具只有 PowerShell 时追加到系统提示词末尾的写法要点 */
export const POWERSHELL_PROMPT = `
# powershell 工具
\`powershell\` 工具运行的是 PowerShell（可能是 Windows PowerShell 5.1），不是 bash。传给它的命令必须是 PowerShell 语法：
- 串联命令用 \`;\`，不要用 \`&&\` / \`||\`（5.1 不支持）；需要“前一条成功才继续”时写 \`cmd1; if ($LASTEXITCODE -eq 0) { cmd2 }\`（cmdlet 用 \`$?\` 判断）。
- 文件操作用 cmdlet：\`Get-ChildItem -Force\`、\`Remove-Item -Recurse -Force\`、\`New-Item -ItemType Directory -Force\`、\`Copy-Item\`、\`Move-Item\`；不要用 \`rm -rf\`、\`ls -la\`、\`mkdir -p\`、\`touch\`。
- 环境变量写 \`$env:NAME\`，设置写 \`$env:NAME = "值"\`；路径用 Windows 形式（\`D:\\work\\x\`），不要用 \`/d/work/x\`。
- Windows PowerShell 5.1 读 UTF-8 文件要写 \`Get-Content -Encoding UTF8\`；写文件优先用 write / edit 工具，必须用命令时写 \`Set-Content -Encoding UTF8\`（\`>\` 与 \`Out-File\` 写出 UTF-16LE）。
- 引号与转义：反引号 \` 是转义符；单引号内原样不展开，双引号内会展开 \`$\` 变量。
- 查找程序用 \`where.exe\` 或 \`Get-Command\`，不要写 \`where\`（它是 \`Where-Object\` 的别名）。
- 搜索文本用 \`Select-String\`，查看文件用 \`Get-Content\`；下载用 \`Invoke-WebRequest -UseBasicParsing\`（5.1 里 \`curl\` 是它的别名，参数与 curl 不同，要用真正的 curl 时写 \`curl.exe\`）。
- 含空格的路径加引号，运行带空格路径的程序写 \`& "C:\\Program Files\\x\\x.exe" 参数\`。`;

interface ShellApi {
  on?: (
    event: "before_agent_start",
    handler: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined,
  ) => void;
  getActiveTools?: () => string[];
}

/** 当前生效的命令工具只有 powershell（没有 bash）时才需要提示 */
export function powershellOnly(activeTools: readonly string[]): boolean {
  return activeTools.includes("powershell") && !activeTools.includes("bash");
}

export default function shell(pi: unknown): void {
  const api = pi as ShellApi | null | undefined;
  if (typeof api?.on !== "function") return;
  api.on("before_agent_start", (event) => {
    if (typeof event?.systemPrompt !== "string" || event.systemPrompt.includes(POWERSHELL_PROMPT))
      return undefined;
    let tools: string[] = [];
    try {
      tools = api.getActiveTools?.() ?? [];
    } catch {
      return undefined;
    }
    if (!Array.isArray(tools) || !powershellOnly(tools)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n${POWERSHELL_PROMPT}` };
  });
}
