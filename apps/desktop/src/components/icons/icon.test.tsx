import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileIcon } from "./file-icon";
import { FILE_ICONS, type FileIconName } from "./file-icons.generated";
import { Icon, strokeExtra } from "./icon";
import { fileIconHtml, iconHtml } from "./icon-html";
import { ICON_NODES } from "./icons.generated";

describe("Icon", () => {
  it("默认是装饰性的（aria-hidden），尺寸用令牌类，className 透传", () => {
    const { container } = render(<Icon name="check" size="sm" className="text-muted" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
    expect(svg?.getAttribute("class")).toBe("shrink-0 size-icon-sm text-muted");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("data-icon")).toBe("check");
  });

  it("给了 label 时作为图片可按名称查到", () => {
    render(<Icon name="alert-circle" label="出错了" />);
    const img = screen.getByRole("img", { name: "出错了" });
    expect(img.getAttribute("aria-hidden")).toBeNull();
    expect(img.getAttribute("class")).toContain("size-icon-md");
  });

  it("所有图标只用 currentColor / none 着色", () => {
    const { container } = render(
      <div>
        {(Object.keys(ICON_NODES) as (keyof typeof ICON_NODES)[]).map((name) => (
          <Icon key={name} name={name} size="2xs" />
        ))}
      </div>,
    );
    const painted = container.querySelectorAll("[fill], [stroke]");
    expect(painted.length).toBeGreaterThan(0);
    for (const el of painted) {
      for (const attr of ["fill", "stroke"]) {
        const v = el.getAttribute(attr);
        if (v !== null) expect(["currentColor", "none"]).toContain(v);
      }
    }
  });

  it("各尺寸的渲染线宽一致：小尺寸加粗，大尺寸保持源线宽", () => {
    expect(strokeExtra("lg")).toBe(0);
    expect(strokeExtra("xl")).toBe(0);
    for (const [size, px] of [
      ["2xs", 10],
      ["xs", 12],
      ["sm", 14],
      ["md", 16],
    ] as const) {
      expect(((1.5 + strokeExtra(size)) * px) / 24).toBeCloseTo(1.25, 2);
    }
    const { container } = render(<Icon name="check" size="xs" />);
    const path = container.querySelector("path");
    expect(path?.getAttribute("stroke")).toBe("currentColor");
    expect(path?.getAttribute("stroke-width")).toBe(String(strokeExtra("xs")));
  });
});

describe("iconHtml", () => {
  it("输出装饰性 SVG 字符串，属性名转成 SVG 写法，颜色只用 currentColor", () => {
    const html = iconHtml("external-link", "md-link-icon", "xs");
    expect(html.startsWith("<svg ")).toBe(true);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="md-link-icon"');
    expect(html).toContain('data-icon="external-link"');
    expect(html).not.toMatch(/strokeWidth|fillRule|clipRule/);
    expect(html).not.toMatch(/#[0-9a-f]{3,6}"/i);
  });

  it("线宽与 <Icon> 同一规则", () => {
    const { container } = render(<Icon name="file-text" size="sm" />);
    const host = document.createElement("div");
    host.innerHTML = iconHtml("file-text", "x", "sm");
    const a = container.querySelector("path");
    const b = host.querySelector("path");
    expect(b?.getAttribute("stroke-width")).toBe(a?.getAttribute("stroke-width"));
  });
});

describe("FileIcon", () => {
  it("装饰性、尺寸用令牌类、viewBox 取自源图标", () => {
    const { container } = render(<FileIcon name="typescript" size="sm" className="ml-1" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toBe("shrink-0 size-icon-sm ml-1");
    expect(svg?.getAttribute("viewBox")).toBe(FILE_ICONS.typescript.viewBox);
    expect(svg?.getAttribute("data-file-icon")).toBe("typescript");
  });

  it("所有文件类型图标的颜色都是 --color-file-* 令牌，不写字面色值", () => {
    const { container } = render(
      <div>
        {(Object.keys(FILE_ICONS) as FileIconName[]).map((name) => (
          <FileIcon key={name} name={name} />
        ))}
      </div>,
    );
    const painted = container.querySelectorAll("svg *");
    expect(painted.length).toBeGreaterThan(Object.keys(FILE_ICONS).length - 1);
    for (const el of painted) {
      const fill = el.getAttribute("fill");
      if (el.tagName !== "g") expect(fill).toMatch(/^var\(--color-file-[a-z0-9-]+\)$/);
      expect(el.getAttribute("stroke")).toBeNull();
    }
  });

  it("多色图标保留各自的颜色（Python 蓝黄、Vue 绿与深蓝）", () => {
    const fills = (name: FileIconName) =>
      new Set(FILE_ICONS[name].nodes.map(([, attrs]) => attrs.fill));
    expect(fills("python").size).toBe(2);
    expect(fills("vue")).toEqual(
      new Set(["var(--color-file-vue-green)", "var(--color-file-vue-navy)"]),
    );
  });

  it("fileIconHtml 与 <FileIcon> 输出同样的图形", () => {
    const { container } = render(<FileIcon name="pdf" />);
    const host = document.createElement("div");
    host.innerHTML = fileIconHtml("pdf", "md-file-icon");
    const svg = host.querySelector("svg");
    expect(svg?.getAttribute("class")).toBe("md-file-icon");
    expect(svg?.getAttribute("data-file-icon")).toBe("pdf");
    expect(svg?.innerHTML).toBe(container.querySelector("svg")?.innerHTML);
  });
});
