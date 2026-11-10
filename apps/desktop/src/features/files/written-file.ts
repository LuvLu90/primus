// 一轮结束后要自动预览的文件：最后一条用户消息之后，Agent 用 write / edit 成功写出的最后一个文件。
import type { AgentMessage } from "@primus/protocol";

const WRITE_TOOLS = new Set(["write", "edit"]);

/** 工具参数里的文件路径（`path`，兼容 `file_path`） */
function pathArg(args: Record<string, unknown> | undefined): string | null {
  const v = args?.path ?? args?.file_path;
  return typeof v === "string" && v.trim() ? v : null;
}

/** 最近一轮里最后一个写成功的文件路径（原样返回，相对路径由调用方按工作区解析）；没有时为 null */
export function lastWrittenFile(messages: readonly AgentMessage[]): string | null {
  const ok = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user") break;
    if (m.role === "toolResult") {
      if (!m.isError) ok.add(m.toolCallId);
      continue;
    }
    if (m.role !== "assistant") continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const block = m.content[j];
      if (block?.type !== "toolCall" || !WRITE_TOOLS.has(block.name) || !ok.has(block.id)) continue;
      const path = pathArg(block.arguments);
      if (path) return path;
    }
  }
  return null;
}
