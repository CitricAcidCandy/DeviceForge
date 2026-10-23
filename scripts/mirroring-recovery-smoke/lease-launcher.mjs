import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// 独立直接父进程与租约持有者一同退出，原生探针无需等待长期驱动退出。
const [binary, root] = process.argv.slice(2);
assert.ok(isAbsolute(binary) && isAbsolute(root) && existsSync(join(root, 'fixture-owner')));
const child = spawn(binary, ['--root', root], { windowsHide: true, stdio: 'ignore' });
child.once('error', () => { process.exitCode = 93; });
child.once('close', (code, signal) => {
  writeFileSync(join(root, 'launcher-exit.json'), JSON.stringify({ pid: process.pid,
    child_pid: child.pid, child_exit: { code, signal } }), { flag: 'wx' });
  process.exitCode = code === 0 && signal === null ? 0 : 94;
});
