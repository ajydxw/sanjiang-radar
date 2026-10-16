param(
    [Parameter(Mandatory = $true)][ValidateSet('Protect', 'Seal', 'Open')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$privateRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) '.sites-runtime'))
$target = [IO.Path]::GetFullPath($Path)
if ($target -ne $privateRoot -and -not $target.StartsWith($privateRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Credential paths must stay inside the private project runtime directory.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')

function Protect-Directory([string]$directory) {
    $ancestor = $directory
    while ($ancestor.Length -ge $privateRoot.Length) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Private directories cannot use symbolic links or junctions.'
        }
        $ancestor = Split-Path -Parent $ancestor
    }
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $entries = @((Get-Item -LiteralPath $directory -Force)) + @(Get-ChildItem -LiteralPath $directory -Force -Recurse)
    if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
        throw 'Private directories cannot contain symbolic links or junctions.'
    }
    foreach ($entry in $entries) {
        $acl = Get-Acl -LiteralPath $entry.FullName
        if ($entry.PSIsContainer) {
            $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        } else {
            $inheritance = [Security.AccessControl.InheritanceFlags]::None
        }
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
        $acl.SetOwner($identity)
        foreach ($sid in @($identity, $system)) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, 'None', 'Allow'))
        }
        if ($PSVersionTable.PSEdition -eq 'Core') {
            [IO.FileSystemAclExtensions]::SetAccessControl($entry, $acl)
        } elseif ($entry.PSIsContainer) { [IO.Directory]::SetAccessControl($entry.FullName, $acl) }
        else { [IO.File]::SetAccessControl($entry.FullName, $acl) }
        $actual = Get-Acl -LiteralPath $entry.FullName
        if (-not $actual.AreAccessRulesProtected -or ($actual.Access | Where-Object {
            $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($identity.Value, $system.Value) -or $_.AccessControlType -ne 'Allow'
        })) { throw 'Private directory permission verification failed.' }
    }
}

try {
    $directory = if ($Action -eq 'Protect') { $target } else { Split-Path -Parent $target }
    Protect-Directory $directory
    if ($Action -eq 'Protect') { return }
    Add-Type -AssemblyName System.Security
    $entropy = [Text.Encoding]::UTF8.GetBytes('sanjiang-radar:local-secret:v1')
    if ($Action -eq 'Seal') {
        [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
        $value = [Console]::In.ReadToEnd()
        if (-not $value -or $value.Length -gt 2048) { throw 'Invalid credential format.' }
        $bytes = [Text.Encoding]::UTF8.GetBytes($value)
        $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, 'CurrentUser')
        $verified = [Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, 'CurrentUser')
        if ([Convert]::ToBase64String($bytes) -ne [Convert]::ToBase64String($verified)) { throw 'Credential encryption verification failed.' }
        $temporary = $target + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        try {
            [IO.File]::WriteAllText($temporary, 'sju-dpapi-v1:' + [Convert]::ToBase64String($protected), [Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temporary -Destination $target -Force
        } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    } else {
        $stored = [IO.File]::ReadAllText($target)
        if (-not $stored.StartsWith('sju-dpapi-v1:') -or $stored.Length -gt 8192) { throw 'Invalid stored credential format.' }
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($stored.Substring(13)), $entropy, 'CurrentUser')
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
    }
} catch { throw 'Local credential protection failed; credentials were not read or saved.' }
finally {
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($verified) { [Array]::Clear($verified, 0, $verified.Length) }
}
