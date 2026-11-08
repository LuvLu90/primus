// 扩展 → 前端的 primus:* 数据（第 6.6 节、附录 A）：setWidget("primus:<主题>", [JSON.stringify(PrimusData)])。

/** 上下文分项统计的数据主题（primus-context-stats，前端发 `/primus-context-stats` 后推送） */
export const CONTEXT_STATS_WIDGET = "primus:context-stats";
export const CONTEXT_STATS_COMMAND = "primus-context-stats";

/** 上下文窗口里能单独估算的分项；“消息”与“可用空间”由前端用 Core 给出的总量推出 */
export type ContextStatsCategoryKey =
  | "systemPrompt"
  | "systemTools"
  | "mcpTools"
  | "skills"
  | "memoryFiles";

export interface ContextStatsItem {
  /** 工具名、技能名或记忆文件路径 */
  name: string;
  /** 估算 token（字符数 / 4，与 Core 压缩时的估算方法一致） */
  tokens: number;
}

export interface ContextStatsCategory {
  key: ContextStatsCategoryKey;
  /** 估算 token（字符数 / 4） */
  tokens: number;
  /** 分项明细（工具、技能、记忆文件），按 token 从大到小 */
  items: ContextStatsItem[];
}

/** 本会话实际调用过的一个工具 */
export interface ContextStatsUsedTool {
  name: string;
  /** 调用次数（当前分支的 assistant 消息里 toolCall 的个数） */
  count: number;
}

/** `primus:context-stats` 的 data：只读估算，不改动上下文 */
export interface ContextStatsData {
  /** 估算方法：字符数 / 4 */
  estimator: "chars/4";
  categories: ContextStatsCategory[];
  /**
   * 本会话（当前分支）实际调用过的工具，按次数从多到少。未启用、未调用的工具（延迟加载 / 只供代码模式 / 关闭）
   * 不列出：它们不在上下文里
   */
  usedTools: ContextStatsUsedTool[];
}
