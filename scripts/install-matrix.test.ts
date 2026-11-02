import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("installation matrix security regressions", () => {
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
      workflow.match(/run: pnpm exec vitest run scripts\/install-acl-native.test.ts/g),
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
