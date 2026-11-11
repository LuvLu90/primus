// 一轮结束后要自动预览的文件：最后一条用户消息之后，Agent 用 write / edit 成功写出的最后一个文件。
// 最后一个目标是预览工具（primus-preview 的 `preview`）成功打开的文件 / 文件夹时不再自动预览：工具请求时
// 右栏已经打开了它（preview-request），一轮结束时再打开会重置用户在文件夹里的位置与返回记录；之前写出的文件
// 也不会盖掉它。
import { type AgentMessage, PREVIEW_TOOL } from "@primus/protocol";

const SHOWN_TOOLS = new Set(["write", "edit", PREVIEW_TOOL]);

/** 工具参数里的文件路径（`path`，兼容 `file_path`） */
function pathArg(args: Record<string, unknown> | undefined): string | null {
  const v = args?.path ?? args?.file_path;
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * 最近一轮里最后一个写成功的文件路径（原样返回，相对路径由调用方按工作区解析）；没有、或最后一个目标是
 * 预览成功的工具调用（已在右栏打开）时为 null
 */
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
      if (block?.type !== "toolCall" || !SHOWN_TOOLS.has(block.name) || !ok.has(block.id)) continue;
      const path = pathArg(block.arguments);
      if (path) return block.name === PREVIEW_TOOL ? null : path;
    }
  }
  return null;
}
