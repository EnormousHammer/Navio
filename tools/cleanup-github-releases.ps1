#requires -Version 5.1
<#
.SYNOPSIS
  Delete GitHub releases and remote tags (e.g. bad v1.0.1 / v1.1.x drops).

.DESCRIPTION
  Requires: GitHub CLI logged in (`gh auth login`) or GH_TOKEN with repo scope.

.PARAMETER Repo
  owner/name. Default: EnormousHammer/Navio

.PARAMETER Tags
  Comma-separated tags to remove, e.g. "v1.0.1,v1.1.0,v1.1.1"

.PARAMETER SkipLocalGit
  Do not print commands to delete local tags.

.EXAMPLE
  .\tools\cleanup-github-releases.ps1 -Tags "v1.0.1,v1.1.0,v1.1.1"
#>
param(
  [string] $Repo = "EnormousHammer/Navio",
  [string] $Tags = "v1.0.1,v1.1.0,v1.1.1",
  [switch] $SkipLocalGit
)

$ErrorActionPreference = "Stop"

function Get-GhExe {
  $candidates = @(
    (Get-Command gh -ErrorAction SilentlyContinue)?.Source,
    "${env:ProgramFiles}\GitHub CLI\gh.exe",
    "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe"
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($candidates.Count -eq 0) { throw "Install GitHub CLI: winget install GitHub.cli" }
  return $candidates[0]
}

$gh = Get-GhExe
& $gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Run: gh auth login" -ForegroundColor Yellow
  exit 1
}

$tagList = $Tags.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
foreach ($tag in $tagList) {
  Write-Host "`n--- $tag ---" -ForegroundColor Cyan
  & $gh release delete $tag --repo $Repo --yes 2>$null
  if ($LASTEXITCODE -eq 0) { Write-Host "Deleted release $tag" -ForegroundColor Green }
  else { Write-Host "No release for $tag (or already gone)" -ForegroundColor DarkGray }

  & $gh api --method DELETE "repos/$Repo/git/refs/tags/$tag" 2>$null
  if ($LASTEXITCODE -eq 0) { Write-Host "Deleted remote tag $tag" -ForegroundColor Green }
  else { Write-Host "No remote tag $tag (or already gone)" -ForegroundColor DarkGray }
}

if (-not $SkipLocalGit) {
  Write-Host "`nTo drop the same tags locally (optional):" -ForegroundColor Yellow
  foreach ($tag in $tagList) {
    Write-Host "  git tag -d $tag 2>`$null; git push origin :refs/tags/$tag"
  }
}
