import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { processSnapshot, sameBinary } from '../backend-console/identities.mjs';
import { stopServer } from '../backend-console/server.mjs';
import {
  encoded,
  freePort,
  ownedDirectory,
  record,
  testConfiguration,
} from './backend-console-fixture.mjs';

export function registerIdentityTests() {
  test(
    '系统查询工具缺失时给出中文错误，不回显编码命令或底层执行参数',
    { timeout: 30000, skip: process.platform !== 'win32' },
    async () => {
      await ownedDirectory(async (directory) => {
        const execute = promisify(execFile);
        const source = `
const { processSnapshot, terminateIdentity } = await import(process.env.DEVICEFORGE_TEST_IDENTITIES);
const failures = [];
for (const run of [
  () => processSnapshot(Number(process.env.DEVICEFORGE_TEST_PORT)),
  () => terminateIdentity({ pid: process.pid, binary: process.execPath, startTime: 'fixture' }),
]) {
  try { await run(); failures.push(null); }
  catch (error) { failures.push(error.message); }
}
console.log(JSON.stringify(failures));
`;
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'),
        );
        const result = await execute(process.execPath, ['--input-type=module', '-e', source], {
          cwd: directory,
          env: {
            ...env,
            PATH: '',
            DEVICEFORGE_TEST_IDENTITIES: new URL(
              '../backend-console/identities.mjs',
              import.meta.url,
            ).href,
            DEVICEFORGE_TEST_PORT: String(await freePort()),
          },
          windowsHide: true,
          timeout: 20000,
          encoding: 'utf8',
          maxBuffer: 4096,
        });
        const failures = JSON.parse(result.stdout.trim());
        assert.equal(failures.length, 2);
        assert.match(failures[0], /^无法查询后端进程状态/);
        assert.match(failures[1], /^无法核对并停止后端进程/);
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /EncodedCommand|Command failed|GetProcessById|powershell\.exe|netstat\.exe|ENOENT|WMI|CIM/,
        );
        assert.equal(result.stderr, '');
      });
    },
  );

  test(
    '真实进程查询在空端口返回空快照，监听后识别当前进程，关闭后恢复空结果',
    { timeout: 45000, skip: process.platform !== 'win32' },
    async () => {
      const port = await freePort();
      const before = await processSnapshot(port);
      assert.deepEqual(before.listeners, []);
      assert.equal(before.target, null);
      assert.deepEqual(before.children, []);
      assert.deepEqual(before.listeningPorts, []);
      const listener = createServer();
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', resolve);
      });
      try {
        const current = await processSnapshot(port, process.pid);
        assert.equal(current.listeners.length, 1);
        assert.equal(current.listeners[0].pid, process.pid);
        assert.ok(sameBinary(current.listeners[0].binary, process.execPath));
        assert.equal(current.target.pid, process.pid);
        assert.equal(current.target.startTime, current.listeners[0].startTime);
        assert.ok(current.listeningPorts.includes(port));
      } finally {
        await new Promise((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
      }
      const after = await processSnapshot(port);
      assert.deepEqual(after.listeners, []);
      assert.equal(after.target, null);
      await freePort(port);
    },
  );

  test(
    '显式同身份残留在无监听且有成功结束日志时可收尾，不遗留测试子进程',
    { timeout: 60000, skip: process.platform !== 'win32' },
    async () => {
      await ownedDirectory(async (directory) => {
        const config = await testConfiguration(directory);
        config.binary = process.execPath;
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          cwd: directory,
          windowsHide: true,
          stdio: 'ignore',
        });
        let spawnError;
        child.on('error', (error) => {
          spawnError = error;
        });
        const ended = new Promise((resolve) => child.once('close', resolve));
        try {
          const before = await processSnapshot(config.port, child.pid);
          if (spawnError) throw spawnError;
          assert.ok(before.target, '私有残留进程必须有完整身份');
          assert.deepEqual(before.listeners, []);
          const timestamp = new Date().toISOString();
          await writeFile(
            join(config.logDirectory, 'deviceforge.2026-10-20.jsonl'),
            encoded({ ...record('宿主运行已结束', { success: true }), timestamp }),
          );
          const result = await stopServer(config, before.target);
          assert.equal(result.stopped, true);
          assert.equal(result.forced, true);
          assert.equal(result.pid, child.pid);
          await ended;
          const after = await processSnapshot(config.port, child.pid);
          assert.equal(after.target, null);
          assert.deepEqual(after.listeners, []);
          await freePort(config.port);
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          await ended;
          await freePort(config.port);
        }
      });
    },
  );
}
