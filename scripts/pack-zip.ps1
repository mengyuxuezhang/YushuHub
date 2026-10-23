param(
  [string]$Version = "",
  [string]$OutputDir = "release",
  [string]$BaseUrl = "https://updates.okpa.cn/agent/ai-admin",
  [string]$ReleaseNotes = ""
)

$ErrorActionPreference = "Stop"

function Remove-WithRetry {
  param([string]$Path)
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

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pkg = Get-Content -Raw (Join-Path $root "package.json") | ConvertFrom-Json
if (-not $Version) {
  $Version = $pkg.version
}

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
)

Get-ChildItem -LiteralPath $root -Force | Where-Object {
  if ($_.PSIsContainer) {
    return $excludeDirs -notcontains $_.Name
  }
  return $excludeFiles -notcontains $_.Name
} | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force
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
  Where-Object { $_.Name -eq 'node_modules' } |
  Sort-Object { $_.FullName.Length } -Descending |
  Remove-Item -Recurse -Force

# Development-only tests and packaging tools are not required by a deployed Admin instance. Keeping
# them out also prevents security-fixture strings from becoming part of the supplier distribution.
Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
  $_.Name -match '\.test\.mjs$' -or
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
