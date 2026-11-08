import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon, strokeExtra } from "./icon";
import { iconHtml } from "./icon-html";
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
    const { container } = render(<Icon name="file-code" size="sm" />);
    const host = document.createElement("div");
    host.innerHTML = iconHtml("file-code", "x", "sm");
    const a = container.querySelector("path");
    const b = host.querySelector("path");
    expect(b?.getAttribute("stroke-width")).toBe(a?.getAttribute("stroke-width"));
  });
});
