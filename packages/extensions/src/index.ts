// primus-bundle.js 入口（附录 A）。Core 的 -e 要求扩展文件默认导出一个工厂函数 (pi) => void，
// 因此这里导出工厂，由它按顺序注册各第一方扩展模块；模块清单单独导出，供测试核对顺序。

import attach from "./attach/index.ts";
import auth from "./auth/index.ts";
import checkpoint from "./checkpoint/index.ts";
import contextStats from "./context-stats/index.ts";
import guard from "./guard/index.ts";
import narrate from "./narrate/index.ts";
import plan from "./plan/index.ts";
import shell from "./shell/index.ts";
import subagent from "./subagent/index.ts";

/** 一个第一方扩展模块：接收 Core 的扩展 API（类型不从上游包导入，见 AGENTS.md 第 2.2 节） */
export type PrimusExtension = (pi: unknown) => void;

/**
 * 注册顺序：guard 最先，保证其他扩展的工具调用都经过审批；auth 只设置模型令牌，不挂工具；narrate 只追加系统提示词；
 * contextStats 只注册一个只读的统计命令；attach 只在发送前把附件展开成 Core 原生的 `<file>` 引用
 */
export const modules: readonly PrimusExtension[] = [
  guard,
  auth,
  checkpoint,
  subagent,
  plan,
  shell,
  narrate,
  contextStats,
  attach,
];

export default function primus(pi: unknown): void {
  for (const register of modules) register(pi);
}
