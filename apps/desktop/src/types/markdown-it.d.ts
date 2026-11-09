// markdown-it 15 不带类型声明：这里只声明本项目用到的部分（message-content.tsx、markdown-links.ts）。
declare module "markdown-it" {
  interface Token {
    type: string;
    tag: string;
    nesting: number;
    level: number;
    content: string;
    markup: string;
    info: string;
    meta: unknown;
    children: Token[] | null;
    attrGet(name: string): string | null;
    attrSet(name: string, value: string): void;
  }
  interface StateCore {
    tokens: Token[];
    Token: new (type: string, tag: string, nesting: number) => Token;
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
    core: { ruler: { push(name: string, rule: (state: StateCore) => void): void } };
    utils: { escapeHtml(text: string): string };
    /** 链接地址校验：返回 false 的地址不生成链接 */
    validateLink(url: string): boolean;
    /** 关闭指定的解析规则（如 "image"） */
    disable(rules: string | string[]): this;
    render(src: string, env?: unknown): string;
  }
}
