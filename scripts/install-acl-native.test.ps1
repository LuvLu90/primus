param([Parameter(Mandatory)][string] $Scratch)
$ErrorActionPreference = 'Stop'
# Test the exact embedded P/Invoke helper without running the elevated installer entry point.
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/windows/install-acl.ps1') -Raw
$native = [regex]::Match($source, "(?s)Add-Type -TypeDefinition '(.+?)'\r?\n")
if (-not $native.Success) { throw 'native helper missing' }
Add-Type -TypeDefinition $native.Groups[1].Value
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $Scratch /grant "*${sid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'scratch permissions could not be prepared' }
$root = Join-Path $Scratch 'install'
$null = New-Item -ItemType Directory -Path $root
$target = Join-Path $Scratch 'external.exe'
[IO.File]::WriteAllText($target, 'unchanged')
$link = Join-Path $root 'Primus.exe'
$null = New-Item -ItemType HardLink -Path $link -Target $target
$before = (Get-Acl -LiteralPath $target).Sddl
if ((Get-Acl -LiteralPath $target).AreAccessRulesProtected) { throw 'target must inherit' }
$handle = [PrimusInstallHandle]::Open($root)
try {
  # Non-admin test: retain the current user's full control so the scratch directory is removable.
  $sd = New-Object Security.AccessControl.RawSecurityDescriptor("O:${sid}D:PAI(A;OICI;FA;;;$sid)(A;OICI;FR;;;BU)")
  $bytes = New-Object byte[] $sd.BinaryLength
  $sd.GetBinaryForm($bytes, 0)
  if (-not [PrimusInstallHandle]::SetKernelObjectSecurity($handle, [uint32]2147483653, $bytes)) {
    throw "SetKernelObjectSecurity failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $rootAcl = Get-Acl -LiteralPath $root
  if ($rootAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'directory owner was not set' }
  if (-not $rootAcl.AreAccessRulesProtected) { throw 'directory DACL is not protected' }
  $actualDacl = $rootAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  # Kernel API does not set the auto-inherited bookkeeping flag; Get-Acl may canonicalize equal allow ACEs.
  $aces = @([regex]::Matches($actualDacl, '\([^)]+\)') | ForEach-Object Value | Sort-Object)
  $expectedAces = @("(A;OICI;FA;;;$sid)", '(A;OICI;FR;;;BU)' | Sort-Object)
  if (($aces -join '') -ne ($expectedAces -join '')) { throw "directory DACL does not match requested ACEs: $actualDacl" }
  if ((Get-Acl -LiteralPath $target).Sddl -ne $before) { throw 'directory freeze propagated to external hard link' }
  $renamed = $false
  try { Rename-Item -LiteralPath $root -NewName 'renamed' -ErrorAction Stop; $renamed = $true } catch { }
  if ($renamed) { throw 'held directory could be renamed' }
  $fileHandle = [PrimusInstallHandle]::Open($link)
  try {
    $deleted = $false
    try { Remove-Item -LiteralPath $link -ErrorAction Stop; $deleted = $true } catch { }
    if ($deleted) { throw 'held file could be replaced' }
    if ([IO.File]::ReadAllText($target) -ne 'unchanged') { throw 'target content changed' }
  } finally { $fileHandle.Dispose() }
  $ordinary = Join-Path $root 'ordinary.exe'
  [IO.File]::WriteAllText($ordinary, 'ordinary')
  $ordinaryHandle = [PrimusInstallHandle]::Open($ordinary)
  try {
    & icacls.exe $ordinary /reset /L /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'held file prevents ACL repair' }
  } finally { $ordinaryHandle.Dispose() }
} finally { $handle.Dispose() }
Write-Output 'native freeze does not propagate; directory and file handles prevent replacement'
