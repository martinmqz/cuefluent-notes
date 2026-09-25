# Repository CI only. Never called by setup, hooks, packages, or npm test.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'GitHub-hosted Windows CI fixture only.' }
$name = 'cf' + [Guid]::NewGuid().ToString('N').Substring(0, 14)
$base = Join-Path $env:SystemRoot ('Temp\cuefluent-acl-' + [Guid]::NewGuid().ToString('N'))
$password = ConvertTo-SecureString ('Cf9!' + [Guid]::NewGuid().ToString('N') + '!7') -AsPlainText -Force
$created = $false
$child = $null
try {
  $account = New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires
  $created = $true
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
  $sid = $account.SID.Value
  $adminMembers = @(Get-LocalGroupMember -SID 'S-1-5-32-544')
  if ($adminMembers.SID.Value -contains $sid) { throw 'Fixture account unexpectedly belongs to Administrators.' }
  New-Item -ItemType Directory -Path $base | Out-Null
  $aclTool = Join-Path $env:SystemRoot 'System32\icacls.exe'
  & $aclTool $base '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*' + $sid + ':(OI)(CI)RX') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not protect fixture directory.' }
  $source = Join-Path $base 'source'
  $scripts = Join-Path $source 'scripts'
  New-Item -ItemType Directory -Path (Join-Path $scripts 'test-support') -Force | Out-Null
  $files = @('storage-standard-user.mjs', 'storage-platform.mjs', 'workflow-storage.mjs', 'intake-lock.mjs', 'process-identity.mjs', 'workflow-config.mjs', 'workflow-paths.mjs', 'workflow-routes.mjs', 'workflow-values.mjs', 'workflow-budget.mjs', 'collection-grant.mjs', 'file-io.mjs', 'runtime-paths.mjs', 'test-support\storage-fixture.mjs', 'test-support\core-storage.mjs')
  foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $scripts $file) }
  $node = Join-Path $base 'node.exe'
  Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination $node
  $work = Join-Path $base 'work'
  New-Item -ItemType Directory -Path $work | Out-Null
  & $aclTool $work '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*' + $sid + ':(OI)(CI)F') '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not protect fixture working directory.' }
  $credential = [PSCredential]::new(($env:COMPUTERNAME + '\' + $name), $password)
  # Password stays in PSCredential: never argv, environment, artifacts, or logs.
  $arguments = '"' + (Join-Path $scripts 'storage-standard-user.mjs') + '" --ci-standard-user "' + $work + '" "' + $sid + '"'
  $stdout = Join-Path $work 'stdout.txt'
  $stderr = Join-Path $work 'stderr.txt'
  $child = Start-Process -FilePath $node -ArgumentList $arguments -Credential $credential -LoadUserProfile -WorkingDirectory $work -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $null = $child.Handle
  if (-not $child.WaitForExit(180000)) { throw 'Standard-user fixture exceeded its budget.' }
  $child.Refresh()
  if ($child.ExitCode -ne 0) {
    if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout }
    if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr }
    throw 'Standard-user fixture failed.'
  }
} finally {
  if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
  try {
    if ($created) {
      try {
        $until = [DateTime]::UtcNow.AddSeconds(30)
        do {
          $profiles = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid })
          if (-not ($profiles | Where-Object Loaded)) { break }
          Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $until)
        foreach ($fixtureProfile in $profiles) {
          if ($fixtureProfile.Loaded) { throw 'Fixture profile remained loaded after child exit.' }
          Remove-CimInstance -InputObject $fixtureProfile
        }
      } finally { Remove-LocalUser -Name $name }
    }
  } finally {
    if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
    if ($child) { $child.Dispose() }
    $password.Dispose()
  }
}
