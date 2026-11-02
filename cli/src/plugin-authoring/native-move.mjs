import { rename, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

function nativeFailureCode(cause) {
  if (!cause || typeof cause.stderr !== 'string' || cause.stderr.length > 8192) return null;
  const prefix = 'DEVICEFORGE_DIRECTORY_FAILED ';
  const lines = cause.stderr.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0].slice(prefix.length));
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Number.isInteger(value.hresult) && value.hresult >= -2147483648 && value.hresult <= 2147483647
      ? value.hresult : null;
  } catch { return null; }
}

/** 仅在Node已明确拒绝共享提交时使用同机原生调用，等待未知时绝不重复派发。 */
export async function movePluginDirectory(source, target, {
  rename: move = rename, execute: run = execute, platform = process.platform,
} = {}) {
  try { await move(source, target); return; }
  catch (error) {
    if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code)) throw error;
    const before = await lstat(source);
    if (!before.isDirectory() || before.isSymbolicLink()) throw error;
    try {
      // 复用已安装的PowerShell 7及用户现行执行策略，不回退旧Shell或修改策略。
      const result = await run('pwsh.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File',
        fileURLToPath(new URL('./windows-move.ps1', import.meta.url)), '-Source', source, '-Target', target,
      ], { windowsHide: true, timeout: 8_000, maxBuffer: 8192 });
      if (result.stdout.trim() !== 'DEVICEFORGE_DIRECTORY_COMMITTED') throw new Error('原生目录提交未返回确认');
      const after = await lstat(target);
      if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev)
        throw new Error('原生提交后目录范围不一致');
      // 调用方仍须按准备回执核对全部最终字节，不能只凭目录移动回执认领发布。
    } catch (cause) {
      // 原生等待失败需先核对目录，外层不能把它当成EPERM重新派发。
      const hresult = nativeFailureCode(cause);
      const detail = hresult === null ? '' : `（系统错误 0x${(hresult >>> 0).toString(16).padStart(8, '0').toUpperCase()}）`;
      throw Object.assign(new Error(`原生目录提交结果未确认${detail}，保留准备回执并查询实际状态`, { cause }),
        { code: 'DIRECTORY_COMMIT_UNCONFIRMED', ...(hresult === null ? {} : { nativeHResult: hresult }) });
    }
  }
}
