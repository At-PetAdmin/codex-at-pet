$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
& node (Join-Path $PSScriptRoot 'validate.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Package validation failed' }
$distPath = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $distPath -Force | Out-Null
$zipPath = Join-Path $distPath ('codex-at-pet-' + $package.version + '.zip')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($zipPath, [IO.FileMode]::Create)
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    $files = @('plugin.json', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.codex-plugin/plugin.json', '.claude-plugin/marketplace.json')
    $files += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'hooks'), (Join-Path $projectRoot 'scripts') -File -Recurse | ForEach-Object { $_.FullName.Substring($projectRoot.Length + 1) }
    foreach ($relative in $files) {
        $sourcePath = Join-Path $projectRoot $relative
        $entryPath = 'codex-at-pet/' + $relative.Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $sourcePath, $entryPath) | Out-Null
    }
} finally {
    $archive.Dispose()
    $stream.Dispose()
}
Write-Output $zipPath
