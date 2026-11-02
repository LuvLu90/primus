# Trusted installer test fixtures must replace the entire DACL. icacls /grant:r only
# replaces grants for the named SIDs and can leave an explicit creator/user grant.
function Get-InstallAclAceSet($Acl) {
  $sd = [Security.AccessControl.RawSecurityDescriptor]::new($Acl.GetSecurityDescriptorBinaryForm(), 0)
  (@($sd.DiscretionaryAcl | ForEach-Object {
    $bytes = New-Object byte[] $_.BinaryLength
    $_.GetBinaryForm($bytes, 0)
    [Convert]::ToBase64String($bytes)
  } | Sort-Object) -join ',')
}

function Set-TrustedInstallDirectoryAcl([string] $Path) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;OICI;0x1200a9;;;AC)')
  Set-Acl -LiteralPath $Path -AclObject $acl
  $actual = Get-Acl -LiteralPath $Path
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or -not $actual.AreAccessRulesProtected) {
    throw "trusted fixture owner or DACL protection is incorrect: $Path"
  }
  # ACE bytes avoid localized SID aliases, canonical ordering and auto-inheritance control flags.
  if ((Get-InstallAclAceSet $actual) -ne (Get-InstallAclAceSet $acl)) {
    throw "trusted fixture DACL does not match the requested grants: $Path"
  }
}
