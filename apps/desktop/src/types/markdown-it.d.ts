// markdown-it 15 不带类型声明：这里只声明本项目用到的部分（message-content.tsx）。
declare module "markdown-it" {
  interface Token {
    attrSet(name: string, value: string): void;
  }
  interface Options {
    html?: boolean;
    linkify?: boolean;
    breaks?: boolean;
    typographer?: boolean;
  }
  interface Renderer {
    renderToken(tokens: Token[], idx: number, options: Options): string;
  }
  type RenderRule = (
    tokens: Token[],
    idx: number,
    options: Options,
    env: unknown,
    self: Renderer,
  ) => string;
  interface RendererWithRules extends Renderer {
    rules: Record<string, RenderRule | undefined>;
  }
  export default class MarkdownIt {
    constructor(options?: Options);
    renderer: RendererWithRules;
    /** 关闭指定的解析规则（如 "image"） */
    disable(rules: string | string[]): this;
    render(src: string, env?: unknown): string;
  }
}
