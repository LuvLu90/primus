// 扩展 → 前端的 primus:* 数据（第 6.6 节、附录 A）：setWidget("primus:<主题>", [JSON.stringify(PrimusData)])。

/** 上下文清单的数据主题（primus-context-stats，前端发 `/primus-context-stats` 后推送） */
export const CONTEXT_STATS_WIDGET = "primus:context-stats";
export const CONTEXT_STATS_COMMAND = "primus-context-stats";

/**
 * 上下文里已加载的内容分组。只列名称，不给 token 数：Core 不提供分项 token 统计，
 * 上下文的 token 数只以 Core 的 contextUsage 为准（不估算）
 */
export type ContextStatsGroupKey = "systemTools" | "mcpTools" | "skills" | "memoryFiles";

export interface ContextStatsGroup {
  key: ContextStatsGroupKey;
  /** 工具名、技能名或记忆文件路径，按名称排序 */
  items: string[];
}

/** 本会话实际调用过的一个工具 */
export interface ContextStatsUsedTool {
  name: string;
  /** 调用次数（当前分支的 assistant 消息里 toolCall 的个数） */
  count: number;
}

/** `primus:context-stats` 的 data：只读清单，不改动上下文，不含任何估算值 */
export interface ContextStatsData {
  /** 已声明给模型的工具、系统提示词里列出的技能与记忆文件（名称） */
  groups: ContextStatsGroup[];
  /**
   * 本会话（当前分支）实际调用过的工具，按次数从多到少。未启用、未调用的工具（延迟加载 / 只供代码模式 / 关闭）
   * 不列出：它们不在上下文里
   */
  usedTools: ContextStatsUsedTool[];
}
