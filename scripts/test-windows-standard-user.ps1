# Repository CI only. Never called by setup, hooks, packages, or npm test.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'GitHub-hosted Windows CI fixture only.' }
$name = 'cf' + [Guid]::NewGuid().ToString('N').Substring(0, 14)
$base = Join-Path $env:SystemRoot ('Temp\cuefluent-acl-' + [Guid]::NewGuid().ToString('N'))
$programDataBase = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('Cuefluent-ci-' + [Guid]::NewGuid().ToString('N'))
$programDataOwned = $false
$programData = Join-Path $programDataBase 'standard-user'
$precreated = $programData + '-admin'
$password = ConvertTo-SecureString ('Cf9!' + [Guid]::NewGuid().ToString('N') + '!7') -AsPlainText -Force
$created = $false
$child = $null
$otherName = 'cf' + [Guid]::NewGuid().ToString('N').Substring(0, 14)
$otherPassword = ConvertTo-SecureString ('Cf9!' + [Guid]::NewGuid().ToString('N') + '!7') -AsPlainText -Force
$otherCreated = $false
$otherChild = $null
function Remove-FixtureUser($fixtureName, $fixtureSID) {
  try {
    $until = [DateTime]::UtcNow.AddSeconds(30)
    do {
      $profiles = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $fixtureSID })
      if (-not ($profiles | Where-Object Loaded)) { break }
      Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $until)
    foreach ($fixtureProfile in $profiles) {
      if ($fixtureProfile.Loaded) { throw 'Fixture profile remained loaded after child exit.' }
      Remove-CimInstance -InputObject $fixtureProfile
    }
  } finally { Remove-LocalUser -Name $fixtureName }
}
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
  $files = @('storage-standard-user.mjs', 'storage-standard-user-access.mjs', 'storage-platform.mjs', 'windows-profile.mjs', 'workflow-storage.mjs', 'windows-discovery.mjs', 'windows-setup-guards.mjs', 'intake-lock.mjs', 'process-identity.mjs', 'workflow-config.mjs', 'workflow-paths.mjs', 'workflow-routes.mjs', 'workflow-values.mjs', 'workflow-budget.mjs', 'collection-grant.mjs', 'file-io.mjs', 'runtime-paths.mjs', 'test-support\storage-fixture.mjs', 'test-support\core-storage.mjs')
  foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $scripts $file) }
  $node = Join-Path $base 'node.exe'
  Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination $node
  $work = Join-Path $base 'work'
  New-Item -ItemType Directory -Path $work | Out-Null
  & $aclTool $work '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*' + $sid + ':(OI)(CI)F') '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not protect fixture working directory.' }
  # Own the test container exclusively. Its shared creation grants exercise the
  # native descriptor without requiring cleanup of an unowned top-level child.
  New-Item -ItemType Directory -Path $programDataBase | Out-Null
  $programDataOwned = $true
  & $aclTool $programDataBase '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*' + $sid + ':(OI)(CI)(RX,WD,AD)') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare shared candidate parent.' }
  New-Item -ItemType Directory -Path $precreated | Out-Null
  & $aclTool $precreated '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*' + $sid + ':(OI)(CI)RX') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not protect administrator-precreated candidate.' }
  Set-Content -LiteralPath (Join-Path $precreated 'owner.txt') -Value 'administrator fixture' -NoNewline
  $credential = [PSCredential]::new(($env:COMPUTERNAME + '\' + $name), $password)
  # Password stays in PSCredential: never argv, environment, artifacts, or logs.
  $arguments = '"' + (Join-Path $scripts 'storage-standard-user.mjs') + '" --ci-standard-user "' + $work + '" "' + $sid + '" "' + $programData + '"'
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
  Get-Content -LiteralPath $stdout
  if ((Get-Content -Raw -LiteralPath (Join-Path $precreated 'owner.txt')) -ne 'administrator fixture') { throw 'Precreated fixture was modified.' }
  # A runner administrator is deliberately allowed by private ACLs. Use another
  # standard-user token to prove denial against the first user's actual output.
  $other = New-LocalUser -Name $otherName -Password $otherPassword -AccountNeverExpires -PasswordNeverExpires
  $otherCreated = $true
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $other
  $otherSID = $other.SID.Value
  # The first child has finished creation. Broaden only the owned parent now;
  # protected private descendants must not inherit this second user's grant.
  & $aclTool $programDataBase '/grant' ('*' + $otherSID + ':(OI)(CI)(RX,WD,AD)') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare shared-parent positive control.' }
  $target = Join-Path $programData 'nested\published.json'
  $before = Get-FileHash -LiteralPath $target -Algorithm SHA256
  $otherWork = Join-Path $base 'other'
  & $aclTool $base '/grant' ('*' + $otherSID + ':(OI)(CI)RX') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare second-user traversal.' }
  New-Item -ItemType Directory -Path $otherWork | Out-Null
  & $aclTool $otherWork '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*' + $otherSID + ':(OI)(CI)F') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not protect second-user working directory.' }
  $otherCredential = [PSCredential]::new(($env:COMPUTERNAME + '\' + $otherName), $otherPassword)
  # Keep alternate-token command lines short; the helper is copied with the same
  # read-only source graph, and needs neither script-policy changes nor a shell.
  $otherArguments = '"' + (Join-Path $scripts 'storage-standard-user-access.mjs') + '" --ci-standard-user-access "' + $otherSID + '" "' + $programData + '"'
  if ($otherArguments.Length + $node.Length + 4 -gt 1024) { throw 'Second-user command exceeds the native logon-process limit.' }
  $otherChild = Start-Process -FilePath $node -ArgumentList $otherArguments -Credential $otherCredential -LoadUserProfile -WorkingDirectory $otherWork -PassThru -RedirectStandardOutput (Join-Path $otherWork 'stdout.txt') -RedirectStandardError (Join-Path $otherWork 'stderr.txt')
  $null = $otherChild.Handle
  if (-not $otherChild.WaitForExit(60000)) { throw 'Second-user fixture exceeded its budget.' }
  $otherChild.Refresh()
  Get-Content -LiteralPath (Join-Path $otherWork 'stdout.txt')
  if ($otherChild.ExitCode -ne 0) {
    Get-Content -LiteralPath (Join-Path $otherWork 'stderr.txt')
    throw 'Second-user fixture failed.'
  }
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $before.Hash -or (Test-Path -LiteralPath (Join-Path $programData 'foreign.json'))) { throw 'Private fixture contents changed.' }
} finally {
  if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
  if ($otherChild -and -not $otherChild.HasExited) { Stop-Process -Id $otherChild.Id -Force -ErrorAction SilentlyContinue }
  try {
    if ($otherCreated) { Remove-FixtureUser $otherName $otherSID }
  } finally {
    try {
      if ($created) { Remove-FixtureUser $name $sid }
    } finally {
      if ($programDataOwned) { Remove-Item -LiteralPath $programDataBase -Recurse -Force }
      if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
      if ($child) { $child.Dispose() }
      if ($otherChild) { $otherChild.Dispose() }
      $password.Dispose()
      $otherPassword.Dispose()
    }
  }
}
