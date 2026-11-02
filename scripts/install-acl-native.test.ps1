param([Parameter(Mandatory)][string] $Scratch)
$ErrorActionPreference = 'Stop'
Write-Output 'native ACL regression: PowerShell started'
# Test the exact embedded P/Invoke helper without running the elevated installer entry point.
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/windows/install-acl.ps1') -Raw
$parseTokens = $null; $parseErrors = $null
$sourceAst = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$parseTokens, [ref]$parseErrors)
$native = $sourceAst.Find({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type' }, $true)
if (-not $native) { throw 'native helper missing' }
# NSIS has a native System.dll in its plugin working directory. Compile the exact production command
# there so a relative .NET framework reference cannot accidentally pick up that plugin.
$pluginDir = Join-Path $Scratch 'plugins'
$null = New-Item -ItemType Directory -Path $pluginDir
Copy-Item -LiteralPath (Join-Path ([Environment]::SystemDirectory) 'version.dll') -Destination (Join-Path $pluginDir 'System.dll')
$previousDirectory = [Environment]::CurrentDirectory
Push-Location $pluginDir
try {
  [Environment]::CurrentDirectory = $pluginDir
  . ([ScriptBlock]::Create($native.Extent.Text))
} finally {
  [Environment]::CurrentDirectory = $previousDirectory
  Pop-Location
}
Write-Output 'native ACL regression: helper compiled'
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
Write-Output 'native ACL regression: probe handles ready'
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
  # Compare binary ACEs: SDDL can render the runner's RID-500 SID as LA, and reorder allow ACEs.
  function Get-AceSet($Acl) {
    @($Acl | ForEach-Object {
      $aceBytes = New-Object byte[] $_.BinaryLength
      $_.GetBinaryForm($aceBytes, 0)
      [Convert]::ToBase64String($aceBytes)
    } | Sort-Object)
  }
  $actualSd = [Security.AccessControl.RawSecurityDescriptor]::new($rootAcl.GetSecurityDescriptorBinaryForm(), 0)
  $aces = Get-AceSet $actualSd.DiscretionaryAcl
  $expectedAces = Get-AceSet $sd.DiscretionaryAcl
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

# Metadata-only WRITE_DAC handles survive changes to DACL and are not blocked by read sharing.
$retainedPath = Join-Path $Scratch 'retained-acl-handle'
$null = New-Item -ItemType Directory -Path $retainedPath
$attacker = [PrimusInstallHandle]::CreateFile($retainedPath, 0x60000, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
if ($attacker.IsInvalid) { throw 'cannot create retained WRITE_DAC test handle' }
try {
  $installer = [PrimusInstallHandle]::Open($retainedPath)
  try {
    $restricted = New-Object Security.AccessControl.RawSecurityDescriptor("O:${sid}D:P(A;;FR;;;$sid)(A;;FR;;;OW)")
    $restrictedBytes = New-Object byte[] $restricted.BinaryLength
    $restricted.GetBinaryForm($restrictedBytes, 0)
    if (-not [PrimusInstallHandle]::SetKernelObjectSecurity($installer, [uint32]2147483652, $restrictedBytes)) { throw 'cannot restrict probe DACL' }
    $restored = New-Object Security.AccessControl.RawSecurityDescriptor("O:${sid}D:P(A;OICI;FA;;;$sid)")
    $restoredBytes = New-Object byte[] $restored.BinaryLength
    $restored.GetBinaryForm($restoredBytes, 0)
    if (-not [PrimusInstallHandle]::SetKernelObjectSecurity($attacker, [uint32]2147483652, $restoredBytes)) { throw 'retained-handle vulnerability was not reproduced' }
  } finally { $installer.Dispose() }

  # Execute the production admission check: it must refuse the untrusted object, before changing ACL.
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
  foreach ($name in @('Test-Link','Test-Locked','Get-LinkCount','Hold-Item','Prepare-InstallDirectory')) {
    $fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    . ([ScriptBlock]::Create($fn.Extent.Text))
  }
  $Trusted = @('S-1-5-18','S-1-5-32-544')
  $ReadOnlyMask = [int]0x1200a9 -bor [int]0x20000000 -bor [int]::MinValue
  $script:held = New-Object 'System.Collections.Generic.List[System.IDisposable]'
  $beforeReject = (Get-Acl -LiteralPath $retainedPath).Sddl
  $rejected = $false
  try { $null = Hold-Item $retainedPath } catch { $rejected = $_.Exception.Message -like '*existing program item is not trusted*' }
  finally { foreach ($heldHandle in $script:held) { $heldHandle.Dispose() } }
  if (-not $rejected) { throw 'untrusted retained-handle object was accepted' }
  if ((Get-Acl -LiteralPath $retainedPath).Sddl -ne $beforeReject) { throw 'rejection changed the original ACL' }

  $dir = $retainedPath
  $marker = Join-Path $dir 'keep.txt'
  [IO.File]::WriteAllText($marker, 'preserve')
  $rejected = $false
  try { Prepare-InstallDirectory } catch { $rejected = $_.Exception.Message -like '*existing program item is not trusted*' }
  if (-not $rejected) { throw 'non-empty untrusted directory was accepted' }
  if ([IO.File]::ReadAllText($marker) -ne 'preserve' -or (Get-Acl -LiteralPath $dir).Sddl -ne $beforeReject) { throw 'admission modified existing data or ACL' }
  [IO.File]::Delete($marker)

  # Empty-directory replacement must not adopt the old object. A retained handle may make deletion fail;
  # if replacement is possible, writing through the old handle must never affect the new directory.
  $deleted = $false
  try { [IO.Directory]::Delete($retainedPath); $deleted = $true } catch { Write-Output 'retained handle prevented replacement (safe refusal)' }
  if ($deleted) {
    [PrimusInstallHandle]::CreateTrustedDirectory($retainedPath, $restoredBytes)
    $freshSddl = (Get-Acl -LiteralPath $retainedPath).Sddl
    $null = [PrimusInstallHandle]::SetKernelObjectSecurity($attacker, [uint32]2147483652, $restrictedBytes)
    if ((Get-Acl -LiteralPath $retainedPath).Sddl -ne $freshSddl) { throw 'old handle changed the replacement object' }
  }
} finally { $attacker.Dispose() }
Write-Output 'retained WRITE_DAC reproduced; untrusted object rejected; replacement isolated'
