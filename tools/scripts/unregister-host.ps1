# 注销 Sift demo native messaging host 并删除 host manifest 文件。
# 用法：powershell -File tools\scripts\unregister-host.ps1
$ErrorActionPreference = 'Stop'

$regKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dj.sift.demo'
if (Test-Path $regKey) {
  Remove-Item -Path $regKey
  Write-Host "已删除注册表键: $regKey"
} else {
  Write-Host "注册表键不存在（无需清理）: $regKey"
}

$manifestPath = Join-Path $env:LOCALAPPDATA 'Sift\NativeMessagingHosts\com.dj.sift.demo.json'
if (Test-Path $manifestPath) {
  Remove-Item -Path $manifestPath
  Write-Host "已删除: $manifestPath"
}
