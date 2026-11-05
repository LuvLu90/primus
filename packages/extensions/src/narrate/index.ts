// primus-narrate：让模型在长任务里边做边说。
// 桌面端把每轮回复展示成“工作过程 + 总结”：过程里的简短说明（我先看看……、问题定位到……）
// 让用户随时知道做到哪一步。这里在每轮开始前往系统提示词末尾追加一段工作方式说明，不改动 Core。

/** 追加到系统提示词末尾的工作方式说明 */
export const NARRATE_PROMPT = `
# 进度说明
用户在桌面应用里看你的工作过程，工具调用会折叠显示，你写的文字会完整显示。
- 需要调用工具时，先用一两句话说明接下来要做什么、为什么（例如“我先看一下项目结构和相关代码，定位问题”）。
- 每完成一个阶段（定位到原因、改完一部分、验证完成），用一两句话说明发现了什么、下一步做什么，再继续。
- 不要每次工具调用都说话；连续的同类操作（读几个文件、跑几条命令）合在一起说一次即可。
- 全部完成后，最后一条回复写总结：做了哪些改动、验证结果、还需要用户做什么。总结里不要再调用工具。
- 说明使用用户的语言，简洁具体，不要客套。`;

interface NarrateApi {
  on?: (
    event: "before_agent_start",
    handler: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined,
  ) => void;
}

export default function narrate(pi: unknown): void {
  const api = pi as NarrateApi | null | undefined;
  if (typeof api?.on !== "function") return;
  api.on("before_agent_start", (event) => {
    if (typeof event?.systemPrompt !== "string" || event.systemPrompt.includes(NARRATE_PROMPT))
      return undefined;
    return { systemPrompt: `${event.systemPrompt}\n${NARRATE_PROMPT}` };
  });
}
