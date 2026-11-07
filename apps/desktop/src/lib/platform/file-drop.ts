// 文件拖放：Tauri 窗口内由原生拖放事件给出本地路径（WebView 收不到文件的 HTML5 drop），
// 浏览器预览没有本地路径，返回 undefined，由组件自己处理 HTML5 drop（只能拿到文件内容）。
// 与窗口控制一样不是附录 B 的薄壳命令（Tauri 内置的 webview 事件）。

export interface FileDropEvent {
  type: "enter" | "over" | "leave" | "drop";
  /** 拖入的本地路径（enter / drop 时有） */
  paths: string[];
  /** 光标位置（CSS 像素，相对窗口内容左上角）；leave 时没有 */
  position?: { x: number; y: number };
}

export interface FileDropSource {
  /** 订阅拖放事件，返回取消订阅函数 */
  listen(listener: (event: FileDropEvent) => void): Promise<() => void>;
}
