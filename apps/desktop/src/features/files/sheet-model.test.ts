import { Workbook } from "@cj-tech-master/excelts";
import { ZipArchive, ZipReader } from "@cj-tech-master/excelts/archive";
import { describe, expect, it } from "vitest";
import {
  columnName,
  MAX_COLS,
  MAX_ROWS,
  offsetsOf,
  parseCsv,
  readWorkbook,
  sheetFromCsv,
} from "./sheet-model";

/** 用真实的解析库写出 xlsx 字节，再按预览的方式读回 */
async function xlsxBytes(build: (wb: Workbook) => void): Promise<ArrayBuffer> {
  const wb = new Workbook();
  build(wb);
  const buf = (await wb.xlsx.writeBuffer()) as Uint8Array;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 重排压缩包：把 xl/sharedStrings.xml 挪到第一张工作表之前 */
async function sharedStringsFirst(data: ArrayBuffer): Promise<ArrayBuffer> {
  const items: { path: string; bytes: Uint8Array }[] = [];
  for await (const entry of new ZipReader(new Uint8Array(data)).entries())
    items.push({ path: entry.path, bytes: await entry.bytes() });
  const strings = items.filter((i) => i.path === "xl/sharedStrings.xml");
  const rest = items.filter((i) => i.path !== "xl/sharedStrings.xml");
  const at = rest.findIndex((i) => i.path.startsWith("xl/worksheets/"));
  rest.splice(at, 0, ...strings);
  const out = new ZipArchive();
  for (const item of rest) out.add(item.path, item.bytes);
  const buf = await out.bytes();
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("表格预览数据模型", () => {
  it("列字母与偏移", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
      "A",
      "B",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
    expect(offsetsOf([10, 0, 5])).toEqual([0, 10, 10, 15]);
  });

  it("xlsx：按数字格式显示、合并单元格、基础样式、列宽，隐藏的工作表不显示", async () => {
    const data = await xlsxBytes((wb) => {
      const ws = wb.addWorksheet("销售");
      ws.columns = [{ width: 12 }, { width: 20 }, { width: 14, hidden: true }];
      ws.addRow(["日期", "金额", "占比"]);
      ws.getRow(1).font = { bold: true, color: { argb: "FFC00000" } };
      ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE699" } };
      const row = ws.addRow([new Date(Date.UTC(2026, 0, 2)), 1234.5, 0.25]);
      row.getCell(1).numFmt = "yyyy-mm-dd";
      row.getCell(2).numFmt = "#,##0.00";
      row.getCell(3).numFmt = "0.0%";
      ws.getCell("A4").value = "合并标题";
      ws.mergeCells("A4:B5");
      ws.getCell("A6").value = { formula: "B2*2", result: 2469 };
      ws.getCell("A7").value = "很长的一段文字会溢出到右侧";
      wb.addWorksheet("第二页").getCell("B2").value = "你好";
      wb.addWorksheet("隐藏", { state: "hidden" }).getCell("A1").value = "x";
    });
    const sheets = await readWorkbook(data);
    expect(sheets.map((s) => s.name)).toEqual(["销售", "第二页"]);
    const [sales, second] = sheets;
    if (!sales || !second) throw new Error("缺少工作表");
    // 内容少的表补齐到 30 行 × 10 列（空行空列用默认行高列宽）
    expect(sales.rows).toBe(30);
    expect(sales.cols).toBe(10);
    expect(sales.clipped).toBe(false);
    expect(sales.colWidths).toEqual([89, 145, 0, 64, 64, 64, 64, 64, 64, 64]);
    expect(sales.rowHeights[29]).toBe(20);
    const header = sales.cells.get(0)?.[0];
    expect(header).toMatchObject({ text: "日期", align: "left", filled: true });
    expect(header?.style).toMatchObject({
      fontWeight: 600,
      color: "#C00000",
      backgroundColor: "#FFE699",
    });
    const values = sales.cells.get(1);
    expect(values?.map((c) => c?.text)).toEqual(["2026-01-02", "1,234.50", "25.0%"]);
    expect(values?.map((c) => c?.align)).toEqual(["right", "right", "right"]);
    // 合并区域：左上角的格子跨两行两列，区域内的其他格子不再单独显示
    expect(sales.merges).toEqual([
      {
        range: { top: 3, left: 0, bottom: 4, right: 1 },
        cell: expect.objectContaining({ text: "合并标题" }),
      },
    ]);
    expect(sales.cells.get(3)?.[0]).toBeUndefined();
    expect(sales.cells.get(5)?.[0]).toMatchObject({ text: "2469", align: "right" });
    // 左对齐文本溢出到右侧连续的空单元格，放得下为止
    expect(sales.cells.get(6)?.[0]?.spill).toBe(89 + 145);
    expect(sales.cells.get(0)?.[1]?.spill).toBeUndefined();
    expect(second.cells.get(1)?.[1]?.text).toBe("你好");
  });

  it("xlsx：超出 1000 行时改为流式读取开头，并标记", async () => {
    const data = await xlsxBytes((wb) => {
      const ws = wb.addWorksheet("大表");
      for (let r = 1; r <= MAX_ROWS + 5; r++) ws.getCell(r, 1).value = r;
      ws.getCell(1, MAX_COLS + 3).value = "远处";
    });
    const [sheet] = await readWorkbook(data);
    expect(sheet?.rows).toBe(MAX_ROWS);
    expect(sheet?.cols).toBe(MAX_COLS);
    expect(sheet?.clipped).toBe(true);
    expect(sheet?.cells.get(MAX_ROWS - 1)?.[0]?.text).toBe(String(MAX_ROWS));
    expect(sheet?.cells.get(0)?.[0]?.text).toBe("1");
  });

  it("xlsx：流式读取在第一张表读满 1000 行后跳过它余下的数据，后面的工作表照常显示", async () => {
    const data = await xlsxBytes((wb) => {
      const big = wb.addWorksheet("大表");
      // 余下的数据远大于解压流的缓冲：不排空就会因背压卡住，后面的工作表永远读不到
      for (let r = 1; r <= MAX_ROWS * 5; r++) {
        for (let c = 1; c <= 40; c++) big.getCell(r, c).value = r * 1000 + c;
      }
      wb.addWorksheet("第二张").getCell("A1").value = "第二张的内容";
    });
    // 共享字符串排在工作表前面（不少写出工具如此）：读取器边解压边解析工作表，不先缓冲整项
    const sheets = await readWorkbook(await sharedStringsFirst(data));
    expect(sheets.map((s) => s.name)).toEqual(["大表", "第二张"]);
    expect(sheets[0]?.rows).toBe(MAX_ROWS);
    expect(sheets[0]?.clipped).toBe(true);
    expect(sheets[1]?.cells.get(0)?.[0]?.text).toBe("第二张的内容");
  }, 20_000);

  it("xlsx：远处的单元格超出 100 列时只显示前 100 列", async () => {
    const data = await xlsxBytes((wb) => {
      const ws = wb.addWorksheet("宽表");
      ws.getCell("A1").value = "左";
      ws.getCell(2, MAX_COLS + 5).value = "远处";
      ws.mergeCells("A3:C3");
    });
    const [sheet] = await readWorkbook(data);
    expect(sheet?.cols).toBe(MAX_COLS);
    expect(sheet?.clipped).toBe(true);
    expect(sheet?.merges).toHaveLength(1);
  });

  it("不是有效的工作簿时报错", async () => {
    await expect(readWorkbook(new Uint8Array([1, 2, 3]).buffer)).rejects.toThrow();
  });

  it("CSV：引号、引号内的分隔符与换行、转义引号", () => {
    expect(parseCsv('a,"b,c","d\n""e"""\r\n1,2,3\n', ",", 10)).toEqual({
      rows: [
        ["a", "b,c", 'd\n"e"'],
        ["1", "2", "3"],
      ],
      complete: true,
    });
    expect(parseCsv("1\n2\n3\n", ",", 2)).toEqual({ rows: [["1"], ["2"]], complete: false });
  });

  it("CSV / TSV 生成表格：识别分号分隔，数字右对齐，截断时丢掉最后一行", () => {
    const sheet = sheetFromCsv("名称;数量\n苹果;1,200\n香蕉;3.5\n半行;4", "a.csv", {
      truncated: true,
    });
    expect(sheet.rows).toBe(30);
    expect(sheet.cols).toBe(10);
    expect(sheet.cells.size).toBe(3);
    expect(sheet.cells.get(1)?.map((c) => [c?.text, c?.align])).toEqual([
      ["苹果", "left"],
      ["1,200", "right"],
    ]);
    const tsv = sheetFromCsv("a\tb,c\n", "a.tsv", { tsv: true });
    expect(tsv.cells.get(0)?.map((c) => c?.text)).toEqual(["a", "b,c"]);
    expect(sheetFromCsv("", "空.csv").rows).toBe(0);
  });
});
