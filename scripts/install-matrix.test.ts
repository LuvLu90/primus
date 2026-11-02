import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("installation matrix security regressions", () => {
  it("requires gsudo and stops immediately after either ACL grant fails", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const matrix = workflow.slice(workflow.indexOf("\n  install-matrix:"));
    expect(matrix).toContain(
      'throw "gsudo 便携包中没有 $env:GSUDO_ARCH_DIR 版本；安装矩阵需要它以中完整性级别运行"',
    );
    expect(matrix).not.toContain("跳过中完整性级别写入测试");
    const gsudoStart = matrix.indexOf("      - name: 安装 gsudo");
    const gsudoRun = matrix.indexOf("        run: |", gsudoStart);
    expect(gsudoStart).toBeGreaterThanOrEqual(0);
    expect(gsudoRun).toBeGreaterThan(gsudoStart);
    expect(matrix.slice(gsudoStart, gsudoRun)).not.toMatch(/^\s+if:/m);
    expect(matrix).toContain(
      'Invoke-WebRequest -Uri "https://github.com/gerardog/gsudo/releases/download/v$env:GSUDO_VERSION/gsudo.portable.zip"',
    );
    expect(matrix).toContain("$bin | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8");
    const script = readFileSync(
      new URL("./install-matrix/matrix-checks.ps1", import.meta.url),
      "utf8",
    );
    for (const path of ["Stage", "OutDir"]) {
      expect(script).toMatch(
        new RegExp(
          `& icacls\\.exe \\$${path}[^\\r\\n]+\\r?\\nif \\(\\$LASTEXITCODE -ne 0\\) \\{ throw "icacls 授权 \\$${path} 失败（退出码 \\$LASTEXITCODE）" \\}`,
        ),
      );
    }
  });
  it.skipIf(process.platform !== "win32").each([
    ["out", "scripts"],
    ["输出 with spaces", "scripts"],
    ["trailing space dir\\", "scripts with spaces"],
  ])(
    "starts the real Faux service with output directory %s and stage %s",
    (outName, stageName) => {
      const data = resolve(".dev-data");
      mkdirSync(data, { recursive: true });
      const scratch = mkdtempSync(join(data, "matrix-launch-"));
      if (dirname(scratch) !== data) throw new Error("invalid scratch directory");
      try {
        const stage = join(scratch, stageName);
        for (const file of ["install-matrix/faux-serve.mjs", "core-contract/faux-model.mjs"]) {
          const target = join(stage, file);
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(new URL(file, import.meta.url), target);
        }
        const source = readFileSync(
          new URL("./install-matrix/matrix-checks.ps1", import.meta.url),
          "utf8",
        );
        // Execute the production Start-Process statement, not a separately quoted test approximation.
        const start = source.indexOf("$fauxArgs =");
        const end = source.indexOf("$deadline =", start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const launch = source.slice(start, end);
        const script = `
$ErrorActionPreference = 'Stop'
$node = $env:PRIMUS_TEST_NODE
$StageScripts = $env:PRIMUS_TEST_STAGE
$OutDir = $env:PRIMUS_TEST_OUT
$null = New-Item -ItemType Directory -Path $OutDir -Force
$faux = $null
try {
${launch}
  $deadline = (Get-Date).AddSeconds(15)
  $urlFile = Join-Path $OutDir 'faux-url.txt'
  while (-not (Test-Path -LiteralPath $urlFile) -and -not $faux.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path -LiteralPath $urlFile)) { throw 'Faux service did not create its URL file in the requested directory' }
  $url = (Get-Content -LiteralPath $urlFile -Raw).Trim()
  if ($url -notmatch '^http://127\\.0\\.0\\.1:[0-9]+$') { throw 'unexpected Faux URL' }
  $response = Invoke-WebRequest "$url/v1/messages" -Method Post -ContentType 'application/json' -Body '{"messages":[]}' -TimeoutSec 5
  if ($response.StatusCode -ne 200 -or $response.Content -notmatch 'tool_use') { throw 'Faux response was not the expected tool call' }
  if (-not (Test-Path -LiteralPath (Join-Path $OutDir 'faux-requests.jsonl'))) { throw 'request log missing' }
} finally {
  if ($faux -and -not $faux.HasExited) { Stop-Process -Id $faux.Id -Force; $faux.WaitForExit() }
  $errFile = Join-Path $OutDir 'faux.err.log'
  if (Test-Path -LiteralPath $errFile) { Get-Content -LiteralPath $errFile }
}
`;
        const result = spawnSync(
          "pwsh",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          {
            encoding: "utf8",
            timeout: 30_000,
            env: {
              ...process.env,
              PRIMUS_TEST_NODE: process.execPath,
              PRIMUS_TEST_STAGE: stage,
              PRIMUS_TEST_OUT: join(scratch, outName),
            },
          },
        );
        expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    40_000,
  );

  it("does not persist checkout credentials or grant access to the entire runner temp", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const matrix = workflow.slice(workflow.indexOf("\n  install-matrix:"));
    expect(matrix).toMatch(
      /uses: actions\/checkout@[^\n]+\n\s+with:\n\s+persist-credentials: false/,
    );
    expect(matrix).not.toMatch(/icacls.*\$(?:env:RUNNER_TEMP|env:GITHUB_WORKSPACE)/);
    expect(matrix.match(/icacls "\$dir" \/grant '\*S-1-5-32-545:\(OI\)\(CI\)RX'/g)).toHaveLength(2);
    expect(
      matrix.match(/\$dir = Join-Path \$env:RUNNER_TEMP "(?:gsudo|msedgedriver)"/g),
    ).toHaveLength(2);
    expect(
      workflow.match(
        /run: pnpm exec vitest run scripts\/install-acl-native.test.ts scripts\/install-matrix.test.ts/g,
      ),
    ).toHaveLength(2);
  });

  it("checks actual WebView2 cache creation under an inherited directory override", () => {
    const script = readFileSync(new URL("./install-matrix/std-user.ps1", import.meta.url), "utf8");
    expect(script).toContain("-Environment @{ WEBVIEW2_USER_DATA_FOLDER = $overrideDir }");
    expect(script).toContain("Assert-True ($webviewItems.Count -gt 0)");
    expect(script).toContain("Assert-True (-not (Test-Path -LiteralPath $overrideDir))");
    expect(script).not.toContain("New-ItemProperty");
    expect(script).toContain("Get-ItemPropertyValue -LiteralPath $policyKey -Name 'Primus.exe'");
    const admin = readFileSync(
      new URL("./install-matrix/matrix-checks.ps1", import.meta.url),
      "utf8",
    );
    expect(admin).toContain("HKLM:\\Software\\Policies\\Microsoft\\Edge\\WebView2\\UserDataFolder");
    expect(admin).toContain("$existingPolicy.GetValueNames() -contains 'Primus.exe'");
    expect(admin).toContain(
      "if ($policyApplied) { Remove-ItemProperty -LiteralPath $policyKey -Name 'Primus.exe' }",
    );
  });

  it("uses a new isolated secondary volume without changing the runner's existing disk", () => {
    const script = readFileSync(
      new URL("./install-matrix/prepare-location.ps1", import.meta.url),
      "utf8",
    );
    expect(script).toContain("if (Test-Path -LiteralPath $vhd) { throw");
    expect(script).toContain("-not (Get-PSDrive -Name $_ -ErrorAction SilentlyContinue)");
    expect(script).toContain('"assign letter=$letter"');
    expect(script).toContain(`$dir = "\${letter}:\\primus"`);
    expect(script).not.toContain("icacls");
    expect(script).not.toContain("if (Test-FixedDrive 'D')");
  });
});
