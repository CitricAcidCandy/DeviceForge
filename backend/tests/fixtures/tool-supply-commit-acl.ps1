# 仅操纵调用者新建的隔离目录；探针不启动宿主、不编译 Rust、不修改全局权限。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('probe', 'arm')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$Transaction = '',
    [string]$PluginExecutable = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$taskRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
if (-not [IO.Directory]::Exists($taskRoot)) { throw '隔离根目录必须已存在' }

# MoveFileExW 的标志与 Windows std::fs::rename 相同，直接保存 Win32 错误码。
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class ToolSupplyCommitNative {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool MoveFileExW(string oldPath, string newPath, uint flags);
    public static int RenameCode(string oldPath, string newPath) {
        return MoveFileExW(oldPath, newPath, 1) ? 0 : Marshal.GetLastWin32Error();
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct LockState { public UIntPtr a; public UIntPtr b; public uint low; public uint high; public IntPtr h; }
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool LockFileEx(SafeFileHandle h, uint flags, uint reserved, uint low, uint high, ref LockState state);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool UnlockFileEx(SafeFileHandle h, uint reserved, uint low, uint high, ref LockState state);
    public static int[] ProbeLock(string path) {
        using(var file = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete)) {
            var state = new LockState();
            if(!LockFileEx(file.SafeFileHandle, 3, 0, uint.MaxValue, uint.MaxValue, ref state))
                return new int[] { Marshal.GetLastWin32Error(), -1 };
            var released = UnlockFileEx(file.SafeFileHandle, 0, uint.MaxValue, uint.MaxValue, ref state);
            return new int[] { 0, released ? 0 : Marshal.GetLastWin32Error() };
        }
    }
    public static string ReadCommand() {
        var line = Task.Run(() => Console.ReadLine());
        return line.Wait(60000) ? line.Result : null;
    }
}
public sealed class ToolSupplyCommitChange {
    public int sequence;
    public string kind;
    public string path;
    public string old_path;
}
public sealed class ToolSupplyCommitWatch : IDisposable {
    private readonly FileSystemWatcher watcher;
    private readonly List<ToolSupplyCommitChange> events = new List<ToolSupplyCommitChange>();
    private readonly string root;
    public int errors;
    public int dropped;
    private void Record(string kind, string path, string oldPath) {
        lock(events) {
            if(events.Count >= 512) { dropped++; return; }
            events.Add(new ToolSupplyCommitChange { sequence = events.Count + 1, kind = kind,
                path = path.Substring(root.Length).Replace('\\', '/'),
                old_path = oldPath == null ? null : oldPath.Substring(root.Length).Replace('\\', '/') });
        }
    }
    public ToolSupplyCommitWatch(string directory) {
        root = Path.GetFullPath(directory).TrimEnd('\\') + "\\";
        watcher = new FileSystemWatcher(directory);
        watcher.IncludeSubdirectories = true;
        watcher.NotifyFilter = NotifyFilters.DirectoryName | NotifyFilters.FileName;
        watcher.InternalBufferSize = 65536;
        watcher.Created += (s,e) => Record("created",e.FullPath,null);
        watcher.Deleted += (s,e) => Record("deleted",e.FullPath,null);
        watcher.Renamed += (s,e) => Record("renamed",e.FullPath,e.OldFullPath);
        watcher.Error += (s,e) => { lock(events) { errors++; } };
        watcher.EnableRaisingEvents = true;
    }
    public ToolSupplyCommitChange[] Snapshot() { lock(events) { return events.ToArray(); } }
    public void Dispose() { watcher.Dispose(); }
}
'@

$taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$taskRights = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
$taskInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$taskRule = [Security.AccessControl.FileSystemAccessRule]::new($taskSid, $taskRights, $taskInheritance,
    [Security.AccessControl.PropagationFlags]::InheritOnly, [Security.AccessControl.AccessControlType]::Deny)

function Assert-Local([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($taskRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '路径超出本轮隔离目录' }
    # 每一级均须普通目录，避免对重解析点指向的其他目录设置 ACL。
    $walk = $full
    while ($walk.Length -ge $taskRoot.Length) {
        if (Test-Path -LiteralPath $walk) {
            if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '拒绝重解析点' }
        }
        if ($walk -eq $taskRoot) { break }
        $walk = [IO.Path]::GetDirectoryName($walk)
    }
    return $full
}
function Get-Digest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-AclEvidence([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
        $_.IdentityReference -eq $taskSid -and $_.AccessControlType -eq 'Deny' -and ($_.FileSystemRights -band $taskRights)
    } | ForEach-Object { @{ inherited = $_.IsInherited; rights = [int]$_.FileSystemRights;
        inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags } })
    $sddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    return @{ relative = $Path.Substring($taskRoot.Length + 1).Replace('\', '/'); deny = $rules;
        dacl_sha256 = Get-Digest $sddl; access_aces_sha256 = Get-Digest (Normalize-Dacl $sddl) }
}
function Normalize-Dacl([string]$Sddl) {
    # Set-Acl/同卷移动会设置 AI 自动继承完成标志；保留全部 ACE 和保护位，仅分开核验此标志。
    return $Sddl -replace '^D:(P?)AI', 'D:$1'
}
function Move-Checked([string]$From, [string]$To, [string]$Label) {
    $code = [ToolSupplyCommitNative]::RenameCode($From, $To)
    return @{ label = $Label; succeeded = ($code -eq 0); win32_code = $code }
}
function Emit($Value) { [Console]::WriteLine(($Value | ConvertTo-Json -Depth 12 -Compress)) }
function Get-LockEvidence {
    $lockPath = Assert-Local ([IO.Path]::Combine($watchRoot, '.locks', [IO.Path]::GetFileName($tx) + '.lock'))
    $codes = [ToolSupplyCommitNative]::ProbeLock($lockPath)
    return @{ acquired = ($codes[0] -eq 0); win32_code = $codes[0]; released = ($codes[1] -eq 0); unlock_win32_code = $codes[1] }
}

$savedAcl = $null
$tx = ''
$restored = $false
$watch = $null
try {
    if ($Mode -eq 'probe') {
        $base = Assert-Local ([IO.Path]::Combine($taskRoot, 'ntfs-probe'))
        if (Test-Path -LiteralPath $base) { throw '探针目录必须全新' }
        [void][IO.Directory]::CreateDirectory($base)
        $tx = Assert-Local ([IO.Path]::Combine($base, '.transactions', 'synthetic-module'))
        $target = Assert-Local ([IO.Path]::Combine($base, 'synthetic-module'))
        [void][IO.Directory]::CreateDirectory($tx)
        [void][IO.Directory]::CreateDirectory($target)
        [IO.File]::WriteAllText([IO.Path]::Combine($target, 'entry.txt'), 'synthetic-v1', [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText([IO.Path]::Combine($target, '.tool-supply-state.json'), '{"version":"1.0.0"}', [Text.UTF8Encoding]::new($false))
    } else {
        $tx = Assert-Local $Transaction
        if (-not [IO.Directory]::Exists($tx)) { throw '事务目录尚未创建' }
        if ([IO.Directory]::Exists([IO.Path]::Combine($tx, 'content')) -or [IO.Directory]::Exists([IO.Path]::Combine($tx, 'backup'))) { throw '设置 ACL 时尚不可解压或备份' }
    }
    $savedAcl = Get-Acl -LiteralPath $tx
    $originalSddl = $savedAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $changed = Get-Acl -LiteralPath $tx
    [void]$changed.AddAccessRule($taskRule)
    Set-Acl -LiteralPath $tx -AclObject $changed
    if ($Mode -eq 'probe') {
        $payload = Assert-Local ([IO.Path]::Combine($tx, 'content', 'bundle'))
        [void][IO.Directory]::CreateDirectory($payload)
        [IO.File]::WriteAllText([IO.Path]::Combine($payload, 'entry.txt'), 'synthetic-v2', [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText([IO.Path]::Combine($payload, '.tool-supply-state.json'), '{"version":"2.0.0"}', [Text.UTF8Encoding]::new($false))
        $backup = Assert-Local ([IO.Path]::Combine($tx, 'backup'))
        $watch = [ToolSupplyCommitWatch]::new($base)
        $oldAcl = Get-AclEvidence $target
        $inherited = Get-AclEvidence $payload
        $steps = @()
        $steps += Move-Checked $target $backup '旧 target 到本轮 backup'
        $backupAcl = if ([IO.Directory]::Exists($backup)) { Get-AclEvidence $backup } else { $null }
        $steps += Move-Checked $payload $target '新 payload 提交到 target'
        if ([IO.Directory]::Exists($backup) -and -not [IO.Directory]::Exists($target)) {
            $steps += Move-Checked $backup $target '本轮 backup 恢复到 target'
        }
        $oldBytesRestored = [IO.Directory]::Exists($target) -and
            [IO.File]::ReadAllText([IO.Path]::Combine($target, 'entry.txt')) -eq 'synthetic-v1' -and
            [IO.File]::ReadAllText([IO.Path]::Combine($target, '.tool-supply-state.json')) -eq '{"version":"1.0.0"}'
        $deleteBlocked = $false
        try { [IO.Directory]::Delete($tx, $true) } catch { $deleteBlocked = $true }
        Set-Acl -LiteralPath $tx -AclObject $savedAcl
        $restored = $true
        $restoredEvidence = Get-AclEvidence $payload
        $releasedSddl = (Get-Acl -LiteralPath $tx).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
        $aclRestored = (Normalize-Dacl $releasedSddl) -eq (Normalize-Dacl $originalSddl)
        $restoredTargetAcl = Get-AclEvidence $target
        [Threading.Thread]::Sleep(200)
        $postReleaseDelete = $false
        if ($aclRestored -and $restoredEvidence.deny.Count -eq 0) {
            [void](Assert-Local $tx)
            [IO.Directory]::Delete($tx, $true)
            $postReleaseDelete = -not [IO.Directory]::Exists($tx)
        }
        $passed = $steps.Count -eq 3 -and $steps[0].succeeded -and (-not $steps[1].succeeded) -and
            $steps[1].win32_code -eq 5 -and $steps[2].succeeded -and $oldBytesRestored -and $deleteBlocked -and
            $oldAcl.access_aces_sha256 -eq $restoredTargetAcl.access_aces_sha256 -and $backupAcl.deny.Count -eq 0 -and
            $inherited.deny.Count -gt 0 -and $restoredEvidence.deny.Count -eq 0 -and $aclRestored -and $postReleaseDelete -and
            $watch.errors -eq 0 -and $watch.dropped -eq 0
        Emit @{ mode = 'probe'; passed = $passed; pid = $PID; steps = $steps; inherited = $inherited;
            old_acl = $oldAcl; backup_acl = $backupAcl; old_bytes_restored = $oldBytesRestored;
            cleanup_delete_blocked = $deleteBlocked; acl_restored = $aclRestored; released_acl = $restoredEvidence;
            restored_target_acl = $restoredTargetAcl; post_release_transaction_removed = $postReleaseDelete;
            dacl_exact_restored = ($releasedSddl -eq $originalSddl); events = @($watch.Snapshot()); watch_errors = $watch.errors; watch_dropped = $watch.dropped }
        if (-not $passed) { exit 2 }
    } else {
        $watchRoot = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($tx))
        [void](Assert-Local $watchRoot)
        $watch = [ToolSupplyCommitWatch]::new($watchRoot)
        $plugin = Assert-Local $PluginExecutable
        $pluginPids = @([Diagnostics.Process]::GetProcessesByName([IO.Path]::GetFileNameWithoutExtension($plugin)) | ForEach-Object {
            try { if ([IO.Path]::GetFullPath($_.MainModule.FileName) -eq $plugin) { $_.Id } } finally { $_.Dispose() }
        })
        if ($pluginPids.Count -ne 1) { throw '下载门闩必须对应本轮唯一插件进程' }
        Emit @{ mode = 'arm'; armed = $true; watch_ready = $true; pid = $PID; plugin_pid = $pluginPids[0];
            transaction_acl = Get-AclEvidence $tx; module_lock = Get-LockEvidence }
        # stdin EOF 同样释放本轮 ACL，防止驱动异常退出遗留测试权限。
        while (($command = [ToolSupplyCommitNative]::ReadCommand()) -eq 'snapshot') {
            [Threading.Thread]::Sleep(100)
            $child = [IO.Path]::Combine($tx, 'content', 'bundle')
            Emit @{ snapshot = $true; pid = $PID; events = @($watch.Snapshot()); watch_errors = $watch.errors;
                watch_dropped = $watch.dropped; module_lock = Get-LockEvidence;
                payload_acl = $(if ([IO.Directory]::Exists($child)) { Get-AclEvidence $child } else { $null }) }
        }
        Set-Acl -LiteralPath $tx -AclObject $savedAcl
        $restored = $true
        $releasedSddl = (Get-Acl -LiteralPath $tx).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
        $child = [IO.Path]::Combine($tx, 'content', 'bundle')
        Emit @{ released = $true; pid = $PID; acl_restored = ((Normalize-Dacl $releasedSddl) -eq (Normalize-Dacl $originalSddl));
            dacl_exact_restored = ($releasedSddl -eq $originalSddl);
            payload_acl = $(if ([IO.Directory]::Exists($child)) { Get-AclEvidence $child } else { $null }) }
        if ($null -ne $command -and $command -ne 'release') { exit 3 }
    }
} finally {
    try { if ($null -ne $watch) { $watch.Dispose() } }
    finally {
        if ($null -ne $savedAcl -and -not $restored -and [IO.Directory]::Exists($tx)) {
            Set-Acl -LiteralPath $tx -AclObject $savedAcl
        }
    }
}
