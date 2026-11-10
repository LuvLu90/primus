import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("installer trusted directory fixtures", () => {
  it("replaces and verifies the complete owner and protected DACL", () => {
    const fixture = read("./install-acl-fixtures.ps1");
    expect(fixture).toContain("New-Object Security.AccessControl.DirectorySecurity");
    expect(fixture).toContain(
      "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;OICI;0x1200a9;;;AC)",
    );
    expect(fixture).toContain("Set-Acl -LiteralPath $Path -AclObject $acl");
    expect(fixture).toContain("$actual.GetOwner([Security.Principal.SecurityIdentifier]).Value");
    expect(fixture).toContain("-not $actual.AreAccessRulesProtected");
    expect(fixture).toContain("(Get-InstallAclAceSet $actual) -ne (Get-InstallAclAceSet $acl)");
  });

  it("MSI hard-link fixture uses the verified complete ACL", () => {
    const smoke = read("./msi-smoke.ps1");
    expect(smoke).toContain(". (Join-Path $PSScriptRoot 'install-acl-fixtures.ps1')");
    const setup = smoke.indexOf("Set-TrustedInstallDirectoryAcl $linkDir");
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(setup).toBeLessThan(smoke.indexOf("New-Item -ItemType HardLink"));
    expect(smoke).not.toContain("$linkDir /inheritance:r /grant:r");
    expect(smoke).toContain("program file has more than one hard link");
    expect(smoke).toContain("(Get-Acl -LiteralPath $linkTarget).Sddl -eq $linkSddl");
  });

  it("copies the shared fixture alongside the smoke script for VM runs", () => {
    expect(read("./vm/Reset-PrimusTestVM.ps1")).toContain(
      "foreach ($name in @('smoke-core-rpc.mjs', 'core-dist.mjs', 'install-acl-fixtures.ps1', 'update-service-checks.ps1', 'update-service-smoke.ps1'))",
    );
  });

  it("both Windows CI architectures run the elevated production admission regression", () => {
    const workflow = read("../.github/workflows/ci.yml");
    expect(
      workflow.match(/run: powershell\.exe .* -File scripts\/install-acl-elevated.test.ps1/g),
    ).toHaveLength(2);
    const test = read("./install-acl-elevated.test.ps1");
    expect(test).toContain("Prepare-InstallDirectory");
    expect(test).toContain("'empty-untrusted'");
    expect(test).toContain("-not $acl.AreAccessRulesProtected");
    expect(test).toContain("-ne $trustedDacl");
  });
});
