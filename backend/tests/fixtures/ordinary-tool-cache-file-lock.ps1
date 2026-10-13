param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Snapshot
)
$ErrorActionPreference = 'Stop'
$rootPath = [IO.Path]::GetFullPath($Root)
$snapshotPath = [IO.Path]::GetFullPath($Snapshot)
if (-not $snapshotPath.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw '文件门闩只允许操作本轮目录'
}
$item = Get-Item -LiteralPath $snapshotPath
if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw '文件门闩只允许普通快照文件'
}
$stream = $null
try {
    $stream = [IO.FileStream]::new($snapshotPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    [Console]::Out.WriteLine('{"locked":true}')
    [Console]::Out.Flush()
    $command = [Console]::In.ReadLine()
    if ($command -ne 'release') { throw '文件门闩释放指令无效' }
} finally {
    if ($null -ne $stream) { $stream.Dispose() }
}
[Console]::Out.WriteLine('{"released":true}')
[Console]::Out.Flush()
