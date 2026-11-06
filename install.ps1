# RAMen installer for Windows 10 and 11 (x64). In PowerShell:
#
#   irm https://getramenai.com/install.ps1 | iex
#
# Installs ramen.exe and its llama-server into %LOCALAPPDATA%\Programs\RAMen and adds it to your user PATH.
# To remove RAMen: delete that folder (your saved chats are in %USERPROFILE%\.context-engine).
# $env:RAMEN_PKG = 'C:\path\or\https-url.zip' installs a specific package.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'     # the progress bar makes downloads in Windows PowerShell very slow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'MatthewLeibel/ramen-releases'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\RAMen'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'RAMen needs 64-bit Windows.' }

$gpu = $false
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) { try { & $smi.Source -L *> $null; if ($LASTEXITCODE -eq 0) { $gpu = $true } } catch { } }
$pkg = if ($gpu) { 'ramen-windows-x64-cuda' } else { 'ramen-windows-x64-cpu' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ramen-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp 'pkg.zip'
    $src = if ($env:RAMEN_PKG) { $env:RAMEN_PKG } else { "https://github.com/$repo/releases/latest/download/$pkg.zip" }
    Write-Host "Downloading RAMen ($pkg)" -ForegroundColor Cyan
    if (Test-Path $src) {
        Copy-Item $src $zip
        $sumFile = "$src.sha256"
        $want = if (Test-Path $sumFile) { (Get-Content $sumFile -Raw).Trim().Split()[0] } else { '' }
    } else {
        try { Invoke-WebRequest -Uri $src -OutFile $zip -UseBasicParsing }
        catch {
            if ($pkg -ne 'ramen-windows-x64-cuda') { throw }
            # the NVIDIA build is not published yet: install the CPU build now, the installer upgrades it later
            Write-Host 'The NVIDIA build is not out yet; installing the standard build for now. Run this installer again later to upgrade.' -ForegroundColor Yellow
            $pkg = 'ramen-windows-x64-cpu'
            $src = "https://github.com/$repo/releases/latest/download/$pkg.zip"
            Invoke-WebRequest -Uri $src -OutFile $zip -UseBasicParsing
        }
        $want = (Invoke-WebRequest -Uri "$src.sha256" -UseBasicParsing).Content
        if ($want -is [byte[]]) { $want = [Text.Encoding]::ASCII.GetString($want) }
        $want = $want.Trim().Split()[0]
    }
    if ($want) {
        $have = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
        if ($have -ne $want.ToLower()) { throw 'The download is damaged (checksum mismatch). Please run the installer again.' }
    }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $new = Join-Path $tmp 'ramen'
    if (-not (Test-Path (Join-Path $new 'bin\ramen.exe'))) { throw 'The package is incomplete.' }

    $old = Join-Path $dest 'bin\ramen.exe'
    if (Test-Path $old) { try { & $old stop *> $null } catch { } }   # an update: stop the old one first
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    if (Test-Path (Join-Path $dest 'bin')) { Remove-Item (Join-Path $dest 'bin') -Recurse -Force }
    Copy-Item (Join-Path $new '*') $dest -Recurse -Force

    $bin = Join-Path $dest 'bin'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if (-not (($userPath -split ';') -contains $bin)) {
        [Environment]::SetEnvironmentVariable('Path', ($bin + ';' + $userPath).TrimEnd(';'), 'User')
    }
    if (-not (($env:Path -split ';') -contains $bin)) { $env:Path = $bin + ';' + $env:Path }

    $ver = (& (Join-Path $bin 'ramen.exe') version) -replace '^RAMen ', ''
    Write-Host ''
    Write-Host "RAMen $ver is installed in $dest" -ForegroundColor Green
    Write-Host ''
    Write-Host 'By using RAMen you agree to its license: https://getramenai.com/terms.html'
    Write-Host ''
    Write-Host 'Start it with one command (in a new terminal window if this one does not find it):'
    Write-Host '  ramen start'
    Write-Host ''
    Write-Host 'It picks a model that fits this computer, downloads it and runs in the background.'
    Write-Host 'Connect an app with:  ramen connect cline   (or continue, aider, opencode, openwebui, env)'
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
