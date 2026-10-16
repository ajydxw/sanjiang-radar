import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, access, rm, symlink, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from './feed-files.mjs';
import { loadTunnelToken, readSecret, saveSecret, secureDirectory } from './local-secrets.mjs';

function inspectPermissions(path) {
  const literal = path.replaceAll("'", "''");
  const script = `Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $entries = @((Get-Item -LiteralPath '${literal}' -Force)) + @(Get-ChildItem -LiteralPath '${literal}' -Force -Recurse)
    $safe = @($entries | Where-Object {
      $acl = Get-Acl -LiteralPath $_.FullName
      -not $acl.AreAccessRulesProtected -or ($acl.Access | Where-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($identity, 'S-1-5-18') -or $_.AccessControlType -ne 'Allow'
      })
    }).Count -eq 0
    [Console]::Out.Write($safe.ToString().ToLowerInvariant())`;
  return new Promise((done, fail) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', value => { output += value; });
    child.once('error', fail);
    child.once('close', code => code === 0 ? done(output) : fail(new Error('ACL check failed')));
  });
}

test('Windows private credentials: migration, DPAPI roundtrip, access boundaries and fail-closed recovery', { skip: process.platform !== 'win32' }, async () => {
  const base = resolve(projectRoot, '.sites-runtime/security-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'credentials-'));
  // All credentials in this test are deliberately fake.
  const token = 'test-only-token-12345678901234567890';
  const config = resolve(root, 'cpolar.yml');
  const secret = resolve(root, 'authtoken.dpapi');
  try {
    await writeFile(config, `authtoken: "${token}"\nregion: cn_top\n`);
    assert.equal(await loadTunnelToken(config, secret), token);
    await assert.rejects(access(config), { code: 'ENOENT' });
    assert.equal((await readFile(secret, 'utf8')).includes(token), false);
    assert.equal(await readSecret(secret), token);
    assert.equal(await loadTunnelToken(config, secret), token);
    assert.equal(await inspectPermissions(root), 'true');

    await writeFile(config, `authtoken: "${token}"\n`);
    await writeFile(secret, 'sju-dpapi-v1:not-valid-ciphertext');
    await assert.rejects(loadTunnelToken(config, secret), /凭证保护失败/);
    assert.equal((await readFile(config, 'utf8')).includes(token), true, 'failed decryption must preserve legacy credentials');
    await saveSecret(secret, token);
    assert.equal(await loadTunnelToken(config, secret), token);

    const outside = resolve(projectRoot, 'artifacts');
    await assert.rejects(secureDirectory(outside), /凭证保护失败/);
    const child = resolve(root, 'linked');
    const destination = resolve(root, 'target');
    await mkdir(destination);
    await symlink(destination, child, 'junction');
    await assert.rejects(secureDirectory(root), /凭证保护失败/);
    await unlink(child);
  } finally {
    assert.ok(root.startsWith(base + '\\'));
    await rm(root, { recursive: true, force: true });
  }
});
