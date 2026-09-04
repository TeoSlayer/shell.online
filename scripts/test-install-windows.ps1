$ErrorActionPreference = "Stop"

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("shell-online-windows-installer-" + [guid]::NewGuid().ToString("N"))
$downloads = Join-Path $root "downloads"
$install = Join-Path $root "install"
$server = $null

try {
  New-Item -ItemType Directory -Path $downloads | Out-Null
  $artifact = "shell-windows-amd64.exe"
  $binary = Join-Path $downloads $artifact
  go build -buildvcs=false -trimpath -ldflags="-X main.version=installer-test" -o $binary ./cmd/shell
  $digest = (Get-FileHash -Algorithm SHA256 $binary).Hash.ToLowerInvariant()
  Set-Content -NoNewline -Path (Join-Path $downloads "SHA256SUMS") -Value "$digest  $artifact`n"

  $server = Start-Process python -ArgumentList "-m", "http.server", "18787", "--bind", "127.0.0.1", "--directory", $root -PassThru -WindowStyle Hidden
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:18787/downloads/SHA256SUMS" | Out-Null
      break
    } catch {
      if ([DateTime]::UtcNow -ge $deadline) { throw }
      Start-Sleep -Milliseconds 100
    }
  } while ($true)

  & "$PSScriptRoot/../public/install.ps1" -BaseUrl "http://127.0.0.1:18787" -InstallDir $install
  $installed = Join-Path $install "shell.exe"
  if (-not (Test-Path $installed)) { throw "Windows installer did not write shell.exe" }
  if ((& $installed --version) -ne "shell installer-test") { throw "Installed Windows binary has the wrong version" }
  Write-Host "Windows installer integration scenario passed."
} finally {
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $root
}
