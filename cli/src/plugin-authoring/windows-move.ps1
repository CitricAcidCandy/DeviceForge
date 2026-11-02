param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Target
)
$ErrorActionPreference = 'Stop'
try {
  # 参数逐项传入，不拼接执行文本；严格限定同父目录的独占暂存。
  $sourcePath = [System.IO.Path]::GetFullPath($Source)
  $targetPath = [System.IO.Path]::GetFullPath($Target)
  $parentPath = [System.IO.Path]::GetDirectoryName($sourcePath)
  if ($sourcePath -ne $Source -or $targetPath -ne $Target -or
      $parentPath -ne [System.IO.Path]::GetDirectoryName($targetPath) -or
      [System.IO.Path]::GetFileName($sourcePath) -notmatch '^\.deviceforge-pack-[A-Za-z0-9]{6}$') {
    throw '目录提交范围无效'
  }
  $sourceItem = Get-Item -LiteralPath $sourcePath -Force
  $parentItem = Get-Item -LiteralPath $parentPath -Force
  if (-not $sourceItem.PSIsContainer -or
      ($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      ($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      (Test-Path -LiteralPath $targetPath)) {
    throw '暂存类型或目标冲突'
  }
  # 原子目录重命名不会将源嵌入并发出现的目标，也不复制合并或覆盖。
  [System.IO.Directory]::Move($sourcePath, $targetPath)
  [Console]::Out.WriteLine('DEVICEFORGE_DIRECTORY_COMMITTED')
} catch {
  # 只返回系统错误码；自由文本可能携带部署路径，不能放进公开诊断。
  $failure = $_.Exception.GetBaseException()
  $diagnostic = @{ hresult = $failure.HResult } | ConvertTo-Json -Compress
  [Console]::Error.WriteLine('DEVICEFORGE_DIRECTORY_FAILED ' + $diagnostic)
  exit 1
}
