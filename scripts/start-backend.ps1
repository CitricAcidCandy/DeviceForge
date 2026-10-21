[CmdletBinding()]
param([switch]$Help, [switch]$Stop, [switch]$Status, [switch]$NoFollow)

# 保留 UTF-8 BOM，供 Windows PowerShell 5.1 读取；业务逻辑由公共控制台入口负责。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $modeCount = @($Help, $Stop, $Status, $NoFollow | Where-Object { $_ }).Count
    if ($modeCount -gt 1) { throw '帮助、停止、状态和后台启动不能同时指定。' }
    $backendNode = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $backendEntry = Join-Path $PSScriptRoot 'backend-console.mjs'
    $backendArguments = @()
    if ($Help) { $backendArguments = @('--help') }
    elseif ($Stop) { $backendArguments = @('--stop') }
    elseif ($Status) { $backendArguments = @('--status') }
    elseif ($NoFollow) { $backendArguments = @('--background') }
    & $backendNode.Source $backendEntry @backendArguments
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine('后端入口失败：' + $_.Exception.Message)
    exit 1
}
