# Run in elevated Windows CI; the ordinary native regression stays usable without admin rights.
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'elevated ACL regression requires administrator rights' }
. (Join-Path $PSScriptRoot 'install-acl-fixtures.ps1')
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/windows/install-acl.ps1') -Raw
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'install-acl.ps1 parse failed' }
$native = $ast.Find({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type' }, $true)
if (-not $native) { throw 'native helper missing' }
. ([ScriptBlock]::Create($native.Extent.Text))
foreach ($name in @('Test-Locked', 'Prepare-InstallDirectory')) {
  $fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $fn) { throw "production function missing: $name" }
  . ([ScriptBlock]::Create($fn.Extent.Text))
}
$Trusted = @('S-1-5-18', 'S-1-5-32-544')
$ReadOnlyMask = [int]0x1200a9 -bor [int]0x20000000 -bor [int]::MinValue
$data = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.dev-data'))
$scratch = Join-Path $data ('install-acl-elevated-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $scratch
try {
  # Reproduce a creator's explicit grant, independent of the runner image's default ACL.
  $dir = Join-Path $scratch 'trusted-existing'
  $null = New-Item -ItemType Directory -Path $dir
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $dir /grant "*${sid}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not add explicit user grant' }
  & icacls.exe $dir /setowner '*S-1-5-32-544' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not set legacy fixture owner' }
  & icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not set legacy fixture grants' }
  if (Test-Locked $dir $true $true) { throw 'legacy fixture unexpectedly removed the explicit user grant' }
  Set-TrustedInstallDirectoryAcl $dir
  if (-not (Test-Locked $dir $true $true)) { throw 'replacement fixture is not accepted by production admission' }
  $trustedAcl = Get-Acl -LiteralPath $dir
  $trustedSddl = $trustedAcl.Sddl
  $trustedDacl = Get-InstallAclAceSet $trustedAcl
  $marker = Join-Path $dir 'keep.txt'
  [IO.File]::WriteAllText($marker, 'preserve')
  Prepare-InstallDirectory
  if ((Get-Acl -LiteralPath $dir).Sddl -ne $trustedSddl -or [IO.File]::ReadAllText($marker) -ne 'preserve') { throw 'trusted existing directory was changed' }
  Write-Output 'explicit creator grant removed; trusted existing directory accepted without replacement'

  $dir = Join-Path $scratch 'empty-untrusted'
  $null = New-Item -ItemType Directory -Path $dir
  & icacls.exe $dir /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not prepare empty untrusted directory' }
  if (Test-Locked $dir $true $true) { throw 'empty fixture must start untrusted' }
  Prepare-InstallDirectory
  $acl = Get-Acl -LiteralPath $dir
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw 'replacement owner is not Administrators' }
  if (-not $acl.AreAccessRulesProtected) { throw 'replacement DACL is not protected' }
  if ((Get-InstallAclAceSet $acl) -ne $trustedDacl) { throw 'replacement DACL does not match trusted fixture' }
  if (-not (Test-Locked $dir $true $true)) { throw 'replacement does not pass production admission' }
  Write-Output 'production empty-directory replacement sets Administrators owner and protected read-only DACL'
} finally {
  $resolved = [IO.Path]::GetFullPath($scratch)
  if (-not $resolved.StartsWith($data + '\install-acl-elevated-', [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe scratch cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
