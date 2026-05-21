# Build/Increment Script for Blaze The Maze
# Usage: 
#   .\build.ps1 -Type patch  (For code changes, increments z)
#   .\build.ps1 -Type minor  (For builds, increments y)

param (
    [ValidateSet("patch", "minor")]
    [string]$Type = "patch"
)

$versionFile = "version.json"
$htmlFile = "index.html"

if (-not (Test-Path $versionFile)) {
    Write-Error "version.json not found."
    exit 1
}

$version = Get-Content $versionFile | ConvertFrom-Json

if ($Type -eq "patch") {
    $version.patch++
} else {
    $version.minor++
    # Reset patch on minor increment as per conventional versioning
    $version.patch = 0
}

$version | ConvertTo-Json | Set-Content $versionFile
$newVersionString = "v$($version.major).$($version.minor).$($version.patch)"

$htmlContent = Get-Content $htmlFile
$newHtmlContent = $htmlContent -replace 'id="version-number">v\d+\.\d+\.\d+', ('id="version-number">' + $newVersionString)
$newHtmlContent | Set-Content $htmlFile

Write-Host "Version updated to $newVersionString"
