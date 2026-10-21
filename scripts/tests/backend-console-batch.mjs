import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureServer, stopServer } from '../backend-console/server.mjs';
import { processSnapshot } from '../backend-console/identities.mjs';
import { freePort, healthy, ownedDirectory, project } from './backend-console-fixture.mjs';

async function temporaryDeployment(directory) {
  const scripts = join(directory, 'scripts');
  await mkdir(scripts);
  await cp(join(project, 'scripts', 'backend-console'), join(scripts, 'backend-console'), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await copyFile(
    join(project, 'scripts', 'backend-console.mjs'),
    join(scripts, 'backend-console.mjs'),
  );
  const bat = join(directory, '停止后端.bat');
  const original = await readFile(join(project, '停止后端.bat'));
  await copyFile(join(project, '停止后端.bat'), bat);
  assert.deepEqual(await readFile(bat), original, '测试必须执行原字节批处理');
  assert.match(original.toString('utf8'), /^pause\s*$/m, '原批处理必须包含 pause');
  const deployment = join(scripts, 'backend-console', 'deployment.mjs');
  const source = await readFile(deployment, 'utf8');
  assert.equal([...source.matchAll(/\bport:\s*7031\b/g)].length, 1);
  const port = await freePort();
  await writeFile(
    deployment,
    source.replace(/\b(port:\s*)7031\b/, (_match, prefix) => `${prefix}${port}`),
    'utf8',
  );
  const { defaultDeployment } = await import(pathToFileURL(deployment).href);
  const config = defaultDeployment(directory);
  assert.equal(config.port, port);
  for (const target of [
    config.directory,
    config.pluginDirectory,
    config.browserPluginDirectory,
    config.dataDirectory,
    config.logDirectory,
  ])
    await mkdir(target, { recursive: true });
  await copyFile(join(project, 'backend', 'target', 'debug', 'apk-server.exe'), config.binary);
  return { bat, config };
}

async function stopWithBatch(bat, directory) {
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${bat}""`], {
    cwd: directory,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (bytes) => stdout.push(bytes));
  child.stderr.on('data', (bytes) => stderr.push(bytes));
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE' && error.code !== 'EOF') child.emit('error', error);
  });
  const timeout = setTimeout(() => child.kill(), 45000);
  try {
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end('\r\n');
    const result = await finished;
    return {
      ...result,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
  } finally {
    clearTimeout(timeout);
    child.stdin.destroy();
  }
}

export function registerBatchTests() {
  test(
    '原字节停止后端.bat 经实际 CMD 执行含 pause 回车，停止临时真实后端并释放进程及端口',
    { timeout: 120000, skip: process.platform !== 'win32' },
    async (context) => {
      await ownedDirectory(async (directory) => {
        const { bat, config } = await temporaryDeployment(directory);
        let server;
        try {
          server = await ensureServer(config, { background: true });
          await healthy(config.port);
          const result = await stopWithBatch(bat, directory);
          assert.equal(result.signal, null);
          assert.equal(result.code, 0, result.stderr || result.stdout);
          assert.match(result.stdout, /后端已停止/);
          assert.doesNotMatch(result.stdout + result.stderr, /�|EncodedCommand|Command failed/);
          const after = await processSnapshot(config.port, server.pid);
          assert.deepEqual(after.listeners, []);
          assert.equal(after.target, null);
          await freePort(config.port);
          context.diagnostic(
            '原批处理字节一致；包含 pause；stdin 提供 CRLF；实际 CMD 返回 0；中文输出完整；临时真实后端 PID 与监听均已释放。',
          );
        } finally {
          if (server) await stopServer(config, server);
          await freePort(config.port);
        }
      });
    },
  );
}
