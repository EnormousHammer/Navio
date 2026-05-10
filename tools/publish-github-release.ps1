#requires -Version 5.1
<#
.SYNOPSIS
  Build with Electron Forge (optional) and create a GitHub Release with gh CLI.

.DESCRIPTION
  1) Ensures GitHub CLI is installed and you are logged in (gh auth login).
  2) Optionally runs npm run make.
  3) Uploads Windows artifacts from out/make + dist-eb (Navio-Windows-Setup-*.exe, Navio-*-win.zip) to a new release. macOS DMGs/ZIPs are built on CI or via npm run dist:mac on a Mac.

.PARAMETER Tag
  Release tag, e.g. v1.0.2. Default: v + version from package.json.

.PARAMETER SkipMake
  Skip npm run make (use existing out/make).

.PARAMETER VerifyTag
  Tag already exists on GitHub; only create the release (--verify-tag).

.PARAMETER TargetBranch
  Branch for new tag when not using -VerifyTag. Default: main.

.EXAMPLE
  .\tools\publish-github-release.ps1
.EXAMPLE
  .\tools\publish-github-release.ps1 -SkipMake -VerifyTag -Tag v1.0.1
#>
param(
  [string] $Tag = "",
  [switch] $SkipMake,
  [switch] $VerifyTag,
  [string] $TargetBranch = "main"
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Get-GhExe {
  $candidates = @(
    (Get-Command gh -ErrorAction SilentlyContinue)?.Source,
    "${env:ProgramFiles}\GitHub CLI\gh.exe",
    "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe"
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($candidates.Count -eq 0) { throw "GitHub CLI (gh) not found. Install: winget install GitHub.cli" }
  return $candidates[0]
}

$gh = Get-GhExe
Write-Host "Using: $gh" -ForegroundColor DarkGray

& $gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nNot logged in. Run in this terminal (browser flow):" -ForegroundColor Yellow
  Write-Host "  & `"$gh`" auth login -h github.com -p https -w`n" -ForegroundColor Cyan
  exit 1
}

$pkg = Get-Content -Raw .\package.json | ConvertFrom-Json
$ver = [string] $pkg.version
if (-not $Tag) { $Tag = "v$ver" }
if ($Tag -match '^v(.+)$') {
  $tagVer = [string]$Matches[1]
  if ($tagVer -ne $ver) {
    throw "Tag $Tag implies semver $tagVer but package.json version is $ver. Update package.json or pass -Tag v$ver."
  }
}

$repoUrl = $pkg.repository.url
if ($repoUrl -match "github\.com[:/]([^/]+)/([^/.#]+)") {
  $repo = "$($matches[1])/$($matches[2])"
} else {
  $repo = "EnormousHammer/Navio"
}

if (-not $SkipMake) {
  Write-Host "Running npm run make ..." -ForegroundColor Cyan
  npm run make
  Write-Host "Running npm run dist:win (NSIS installer) ..." -ForegroundColor Cyan
  $prevCsc = $env:CSC_IDENTITY_AUTO_DISCOVERY
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  try {
    npm run dist:win
  } finally {
    if ($null -ne $prevCsc) { $env:CSC_IDENTITY_AUTO_DISCOVERY = $prevCsc }
    else { Remove-Item Env:CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue }
  }
}

$makeRoot = Join-Path (Get-Location) "out\make"
if (-not (Test-Path $makeRoot)) {
  throw "out/make not found. Run without -SkipMake or build first."
}

$assets = [System.Collections.Generic.List[string]]::new()
Get-ChildItem -Path $makeRoot -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
  $n = $_.Name
  if ($n -match '\.nupkg$' -or $n -eq 'RELEASES' -or $n -match 'Setup\.exe$' -or $n -match '^Navio.*\.zip$') {
    [void]$assets.Add($_.FullName)
  }
}
$distEb = Join-Path (Get-Location) "dist-eb"
if (Test-Path $distEb) {
  Get-ChildItem -Path $distEb -File -ErrorAction SilentlyContinue | ForEach-Object {
    $n = $_.Name
    if ($n -like 'Navio-Windows-Setup-*.exe' -or $n -like 'Navio-*-win.zip' -or $n -eq 'latest.yml' -or $n -match '\.blockmap$') {
      [void]$assets.Add($_.FullName)
    }
  }
}

$assets = $assets | Sort-Object -Unique
if ($assets.Count -eq 0) {
  throw "No release files found (expected out/make Squirrel, dist-eb Navio-Windows-Setup-*.exe, Navio-*-win.zip)."
}

Write-Host "`nUploading $($assets.Count) file(s) to $repo release $Tag`:" -ForegroundColor Cyan
$assets | ForEach-Object { Write-Host "  $_" }

$title = "Navio $ver"
$ghArgs = @(
  "release", "create", $Tag,
  "--repo", $repo,
  "--title", $title,
  "--generate-notes"
) + $assets

if ($VerifyTag) {
  $ghArgs += "--verify-tag"
} else {
  $ghArgs += "--target", $TargetBranch
}

& $gh @ghArgs
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nIf the tag already exists, retry with: -VerifyTag" -ForegroundColor Yellow
  Write-Host "If the version was already released, bump package.json version and run again." -ForegroundColor Yellow
  exit $LASTEXITCODE
}

Write-Host "`nDone. Open: https://github.com/$repo/releases/tag/$Tag" -ForegroundColor Green
