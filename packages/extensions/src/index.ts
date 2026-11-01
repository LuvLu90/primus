// primus-bundle.js 入口：依次注册各第一方扩展模块（附录 A）。

import checkpoint from "./checkpoint/index.ts";
import guard from "./guard/index.ts";
import plan from "./plan/index.ts";
import shell from "./shell/index.ts";
import subagent from "./subagent/index.ts";

export default [guard, checkpoint, subagent, plan, shell];
