# 注册 Sift demo native messaging host（HKCU，当前用户，无需管理员）。
# 用法：powershell -File tools\scripts\register-host.ps1 -ExePath <Sift.exe 绝对路径>
# 对应 ADR-001 E-03；host manifest 的 allowed_origins 只含固定 demo Extension ID。
param(
  [Parameter(Mandatory = $true)]
  [string]$ExePath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ExePath)) {
  throw "ExePath 不存在: $ExePath"
}
$ExePath = (Resolve-Path $ExePath).Path

$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$makeManifest = Join-Path $repo 'tools\scripts\make-host-manifest.mjs'

$manifestDir = Join-Path $env:LOCALAPPDATA 'Sift\NativeMessagingHosts'
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
$manifestPath = Join-Path $manifestDir 'com.dj.sift.demo.json'

node $makeManifest --exe $ExePath --out $manifestPath
if ($LASTEXITCODE -ne 0) {
  throw 'make-host-manifest.mjs 失败'
}

$regKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dj.sift.demo'
New-Item -Path $regKey -Force | Out-Null
Set-Item -Path $regKey -Value $manifestPath

Write-Host "已注册: $regKey"
Write-Host "  -> $manifestPath"
Write-Host "卸载: powershell -File tools\scripts\unregister-host.ps1"
