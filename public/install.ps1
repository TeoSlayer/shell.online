[CmdletBinding()]
param(
  [string]$InstallDir = $env:SHELL_ONLINE_INSTALL_DIR,
  [string]$BaseUrl = $(if ($env:SHELL_ONLINE_BASE_URL) { $env:SHELL_ONLINE_BASE_URL } else { "https://shell.online" })
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  Write-Error "shell.online: $Message"
  exit 1
}

$nativeArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$architecture = switch ($nativeArchitecture.ToUpperInvariant()) {
  "AMD64" { "amd64" }
  "X86" { "386" }
  "ARM64" { "arm64" }
  default { Fail "unsupported Windows architecture: $nativeArchitecture (supported: x86, x64, ARM64)" }
}

if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\shell.online"
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$artifact = "shell-windows-$architecture.exe"
$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("shell-online-" + [guid]::NewGuid().ToString("N"))
$binaryPath = Join-Path $temporaryDirectory "shell.exe"
$manifestPath = Join-Path $temporaryDirectory "SHA256SUMS"

try {
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/downloads/$artifact" -OutFile $binaryPath
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/downloads/SHA256SUMS" -OutFile $manifestPath
  $manifest = Get-Content -Raw $manifestPath
  $match = [regex]::Match($manifest, "(?m)^([a-f0-9]{64})  " + [regex]::Escape($artifact) + "$")
  if (-not $match.Success) { Fail "release manifest has no valid checksum for $artifact" }
  $expected = $match.Groups[1].Value
  $actual = (Get-FileHash -Algorithm SHA256 $binaryPath).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { Fail "downloaded binary failed checksum verification" }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $target = Join-Path $InstallDir "shell.exe"
  Copy-Item -Force $binaryPath $target
  Write-Host "Installed shell to $target"
  Write-Host "Verified SHA-256: $actual"

  $pathEntries = $env:Path -split ";" | ForEach-Object { $_.TrimEnd("\") }
  if ($pathEntries -notcontains $InstallDir.TrimEnd("\")) {
    Write-Host ""
    Write-Host "$InstallDir is not on PATH yet."
    Write-Host "For this PowerShell window:"
    Write-Host "  `$env:Path = `"$InstallDir;`$env:Path`""
    Write-Host "To keep it for future windows:"
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"$InstallDir;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
  }
  & $target --version
  Write-Host ""
  Write-Host "Next:"
  Write-Host "  shell <your-command>   Run it in the background and print its browser link"
  Write-Host "  shell help             See the guided start, share, and stop flow"
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $temporaryDirectory
}
