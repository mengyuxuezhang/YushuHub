param(
  [string]$Version = "",
  [string]$OutputDir = "release",
  [string]$BaseUrl = "https://updates.okpa.cn/agent/ai-admin",
  [string]$ReleaseNotes = ""
)

$ErrorActionPreference = "Stop"

function Remove-WithRetry {
  param([string]$Path)
  Assert-StageRoot $Path
  for ($i = 0; $i -lt 5; $i++) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($i -eq 4) {
        Write-Warning "Unable to remove temporary path: $Path"
        return
      }
      Start-Sleep -Milliseconds 300
    }
  }
}

function Assert-StageRoot {
  param([string]$Path)
  $resolved = [IO.Path]::GetFullPath($Path)
  if ($resolved -ne [IO.Path]::GetFullPath((Join-Path $root '.pack'))) { throw 'Unexpected packaging cleanup path.' }
  if ((Test-Path -LiteralPath $resolved) -and ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Packaging stage must not be a symbolic link.' }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pkg = Get-Content -Raw (Join-Path $root "package.json") | ConvertFrom-Json
if (-not $Version) {
  $Version = $pkg.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$' -or $Version -ne $pkg.version) { throw 'Version must match package.json and use a safe semantic version.' }

$name = "agent-ai-admin-v$Version"
$stageRoot = Join-Path $root ".pack"
$stage = Join-Path $stageRoot $name
if ([System.IO.Path]::IsPathRooted($OutputDir)) {
  $outDir = $OutputDir
} else {
  $outDir = Join-Path $root $OutputDir
}
$zipPath = Join-Path $outDir "$name.zip"
$manifestPath = Join-Path $outDir "latest.json"

Assert-StageRoot $stageRoot
Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
New-Item -ItemType Directory -Force $outDir | Out-Null

$excludeDirs = @(
  ".git",
  ".pack",
  "node_modules",
  "web-admin",
  "tools",
  "ops",
  "release",
  "uploads",
  "data",
  "logs",
  "local-update",
  "tmp",
  "output",
  "docs",
  "test"
)

$excludeFiles = @(
  ".env",
  "install.php"
)

$publicDocs = @(
  "DEPLOY_ZIP.md",
  "NEW_PROJECT_DEPLOYMENT.md",
  "AUTH_EMAIL_ADMIN.md",
  "DESKTOP_EMAIL_AUTH_HANDOFF.md",
  "DESKTOP_DISTRIBUTION_SECURITY.md",
  "PAYMENT_INTEGRATION.md",
  "MODEL_PROXY_TIMEOUTS.md"
  "UPDATE_HISTORY.json"
  "AGENT_UPDATE_HISTORY.json"
  "ADMIN_RELEASE_ARCHIVE.json"
  "AGENT_RELEASE_ARCHIVE.json"
)

$allowedRoots = @('cloud', 'src', 'web', 'scripts', 'deploy')
$allowedFiles = @('package.json', 'package-lock.json', '.env.example', '.gitignore', 'README.md', 'LICENSE', 'COMMERCIAL_LICENSE.md', 'SECURITY.md')
$tracked = & git -C $root -c core.quotepath=false ls-files -- $allowedRoots $allowedFiles
if ($LASTEXITCODE -ne 0) { throw 'Package from a Git source checkout; untracked local files must not enter a distribution.' }
foreach ($relative in $tracked) {
  $parts = $relative.Replace('\', '/').Split('/')
  if ($parts -contains '..' -or [IO.Path]::IsPathRooted($relative)) { throw 'Unsafe tracked package path.' }
  if ($parts | Where-Object { $excludeDirs -contains $_ }) { continue }
  if ($excludeFiles -contains $parts[-1] -or $parts[-1] -match '\.log$') { continue }
  $sourceFile = Join-Path $root $relative
  if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { continue }
  if ((Get-Item -LiteralPath $sourceFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Tracked distribution files must not be symbolic links.' }
  $targetFile = Join-Path $stage $relative
  New-Item -ItemType Directory -Force (Split-Path -Parent $targetFile) | Out-Null
  Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
}

$stageDocs = Join-Path $stage "docs"
New-Item -ItemType Directory -Force $stageDocs | Out-Null
foreach ($doc in $publicDocs) {
  $sourceDoc = Join-Path (Join-Path $root "docs") $doc
  if (Test-Path -LiteralPath $sourceDoc) {
    Copy-Item -LiteralPath $sourceDoc -Destination $stageDocs -Force
  }
}

# Nested workspaces (for example web-admin) have their own dependency directories. They are
# development artifacts and must never be copied into the supplier package.
Get-ChildItem -LiteralPath $stage -Recurse -Directory -Force |
  Where-Object { $_.Name -eq 'node_modules' -or $_.Name -eq '__pycache__' } |
  Sort-Object { $_.FullName.Length } -Descending |
  ForEach-Object {
    $nested = [IO.Path]::GetFullPath($_.FullName)
    $prefix = [IO.Path]::GetFullPath($stage).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $nested.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Nested cleanup escaped packaging stage.' }
    if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { Remove-Item -LiteralPath $nested -Force }
    else { Remove-Item -LiteralPath $nested -Recurse -Force }
  }

# Development-only tests and packaging tools are not required by a deployed Admin instance. Keeping
# them out also prevents security-fixture strings from becoming part of the supplier distribution.
Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
  $_.Name -match '\.test\.mjs$' -or
  $_.Name -eq 'sync-release-archives.py' -or
  $_.Name -eq 'test_sync_release_archives.py' -or
  $_.FullName -eq (Join-Path $stage 'scripts\audit-distribution.mjs') -or
  $_.FullName -eq (Join-Path $stage 'scripts\audit-distribution.test.mjs') -or
  $_.FullName -eq (Join-Path $stage 'scripts\e2e-protected-skill.mjs') -or
  $_.FullName -eq (Join-Path $stage 'scripts\e2e-curated-mcp.mjs') -or
  $_.FullName -eq (Join-Path $stage 'scripts\e2e-credit-adjustment.mjs') -or
  $_.FullName -eq (Join-Path $stage 'scripts\e2e-model-v2.mjs') -or
  $_.FullName -eq (Join-Path $stage 'scripts\e2e-live-model-modalities.mjs') -or
  $_.FullName -eq (Join-Path $stage 'scripts\validate-user-usage-test-server.mjs') -or
  $_.FullName -eq (Join-Path $stage 'scripts\demo-reset.py') -or
  $_.FullName -eq (Join-Path $stage 'scripts\setup-demo-instance.py') -or
  $_.FullName -eq (Join-Path $stage 'src\middleware\demo-account-guard.mjs') -or
  $_.FullName -eq (Join-Path $stage 'scripts\check.mjs') -or
  $_.FullName -eq (Join-Path $stage 'scripts\deploy-admin-release.sh') -or
  $_.FullName -eq (Join-Path $stage 'scripts\pack-zip.ps1')
} | Remove-Item -Force

& node (Join-Path $root 'src/services/self-update-package.mjs') $stage $Version
if ($LASTEXITCODE -ne 0) { throw 'Admin update package completeness check failed.' }
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
  $stageFullPath = [IO.Path]::GetFullPath($stage).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
    $fileFullPath = [IO.Path]::GetFullPath($_.FullName)
    $relative = $fileFullPath.Substring($stageFullPath.Length).Replace([IO.Path]::DirectorySeparatorChar, "/").Replace([IO.Path]::AltDirectorySeparatorChar, "/")
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $relative) | Out-Null
  }
} finally {
  $zip.Dispose()
}
& node (Join-Path $root 'src/services/self-update-package.mjs') --archive $zipPath
if ($LASTEXITCODE -ne 0) { throw 'Admin update archive boundary check failed.' }
Remove-WithRetry -Path $stageRoot
& node (Join-Path $root "scripts\audit-distribution.mjs") $zipPath
if ($LASTEXITCODE -ne 0) {
  throw "Admin distribution isolation audit failed."
}

$sha = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($zipPath)
try {
  $hashBytes = $sha.ComputeHash($stream)
  $sha256 = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
} finally {
  $stream.Dispose()
  $sha.Dispose()
}
$publishedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
if (-not $ReleaseNotes) {
  $ReleaseNotes = "Update Agent AI Admin."
}
$baseUrlClean = $BaseUrl.TrimEnd([char]'/')

$historyPath = Join-Path (Join-Path $root "docs") "UPDATE_HISTORY.json"
$history = @()
if (Test-Path -LiteralPath $historyPath) {
  $history = @((([System.IO.File]::ReadAllText($historyPath, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json))
}
$currentEntry = [ordered]@{ version = $Version; publishedAt = $publishedAt; releaseNotes = $ReleaseNotes }
$boundedHistory = @($currentEntry)
foreach ($entry in $history) {
  $entryVersion = [string]$entry.version
  if (-not $entryVersion -or $entryVersion -eq $Version -or $boundedHistory.Count -ge 50) { continue }
  $boundedHistory += [ordered]@{ version = $entryVersion; publishedAt = [string]$entry.publishedAt; releaseNotes = [string]$entry.releaseNotes }
}

$manifest = [ordered]@{
  version = $Version
  url = "$baseUrlClean/$name.zip"
  sha256 = $sha256
  publishedAt = $publishedAt
  releaseNotes = $ReleaseNotes
  history = $boundedHistory
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $manifestJson + [Environment]::NewLine, $utf8NoBom)

Write-Host "Created: $zipPath"
Write-Host "Updated: $manifestPath"
