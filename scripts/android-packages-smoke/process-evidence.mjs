import assert from 'node:assert/strict';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { exited } from '../device-provider/fixtures.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { sha256 } from './samples.mjs';

function within(root, path) {
  const part = relative(resolve(root), resolve(path));
  assert.ok(part && !part.startsWith('..') && !isAbsolute(part), '本次证据路径须在独占目录内');
}

export async function observations(deployment) {
  const entries = await readdir(deployment.observations, { withFileTypes: true });
  assert.ok(entries.length <= 4, '本次只有两个清单工具；多余观察不得忽略');
  const found = [];
  for (const entry of entries) {
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    const directory = join(deployment.observations, entry.name);
    let ready;
    try {
      ready = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    assert.equal(ready.event, 'ready');
    assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
    assert.ok(
      Number.isSafeInteger(ready.plugin_pid) &&
        ready.plugin_pid > 0 &&
        ready.pid !== ready.plugin_pid,
    );
    within(deployment.scratch, ready.private_root);
    within(ready.private_root, ready.input_path);
    assert.equal(resolve(ready.private_root), resolve(join(ready.input_path, '..')));
    assert.deepEqual(ready.argv, ['manifest', 'print', ready.input_path]);
    const inputBytes = await readFile(join(directory, 'input.bin'));
    found.push({
      directory,
      ready,
      input_sha256: sha256(inputBytes),
      input_size: inputBytes.length,
    });
  }
  return found;
}

export async function readyProcesses(deployment, entries, report) {
  const observed = await poll(
    () => observations(deployment),
    (all) => all.length === 2,
    '两个不同私有目录的清单工具 ready',
    12000,
  );
  assert.equal(new Set(observed.map((item) => item.ready.pid)).size, 2);
  assert.equal(new Set(observed.map((item) => item.ready.plugin_pid)).size, 2);
  assert.equal(new Set(observed.map((item) => item.ready.private_root)).size, 2);
  for (const entry of entries) {
    const matching = observed.filter(
      (item) => item.input_sha256 === entry.source.sha256 && item.input_size === entry.source.size,
    );
    assert.equal(matching.length, 1, '实际工具副本按本次唯一上传字节关联一个 Job');
    const item = matching[0];
    assert.equal(
      await realpath(item.ready.plugin_executable),
      await realpath(deployment.copiedPlugin),
    );
    assert.equal(exited(item.ready.pid), false);
    assert.equal(exited(item.ready.plugin_pid), false);
    entry.tool = {
      ...item,
      ready_observed_at: new Date().toISOString(),
      direct_tool_running_at_ready: true,
      direct_plugin_running_at_ready: true,
      parent_executable_identity: await fileIdentity(item.ready.plugin_executable),
    };
    assert.equal(
      entry.tool.parent_executable_identity.sha256,
      report.deployment.identities[0].sha256,
    );
  }
  return observed;
}

export async function releaseProcesses(entries) {
  await Promise.all(
    entries.map((entry) => writeFile(join(entry.tool.directory, 'release'), '1', 'utf8')),
  );
}

export async function verifyProcesses(deployment, entries) {
  for (const entry of entries) {
    const { ready, directory } = entry.tool;
    await poll(
      async () => ({ tool: exited(ready.pid), plugin: exited(ready.plugin_pid) }),
      (state) => state.tool && state.plugin,
      '本次工具与父插件真实 PID 退出',
      5000,
    );
    const completed = JSON.parse(await readFile(join(directory, 'completed.json'), 'utf8'));
    for (const key of ['pid', 'plugin_pid', 'plugin_executable', 'private_root', 'input_path']) {
      assert.equal(completed[key], ready[key]);
    }
    assert.equal(completed.event, 'response_written_exit_intent');
    assert.equal(completed.code, 0);
    assert.ok(BigInt(completed.monotonic_ns) >= BigInt(ready.monotonic_ns));
    entry.tool.completed = completed;
    entry.tool.direct_tool_pid_gone = true;
    entry.tool.direct_plugin_pid_gone = true;
    entry.tool.pid_scope = 'ready时观察真实父进程路径，退出时ESRCH；不提供OS退出码或进程树保证';
    entry.tool.private_directory_removed = false;
    try {
      await readdir(ready.private_root);
      assert.fail('成功返回后私有任务目录仍存在');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entry.tool.private_directory_removed = true;
    }
  }
  assert.deepEqual(
    await readdir(deployment.scratch),
    [],
    '两个工具及无工具提取结束后 scratch 必须为空',
  );
  assert.equal((await observations(deployment)).length, 2, '两个 extract Job 不能启动额外工具');
}

// 失败只收集本次已观察的 PID，不扫描或杀未知进程，不凭退出意图声明实际退出。
export async function collectProcesses(deployment, report) {
  if (!deployment) return;
  const found = await observations(deployment);
  report.observed_processes = found.map((item) => ({
    ...item,
    direct_tool_pid_gone: exited(item.ready.pid),
    direct_plugin_pid_gone: exited(item.ready.plugin_pid),
  }));
  if (!report.failure_stage) {
    assert.equal(found.length, 2);
    assert.ok(
      report.observed_processes.every(
        (item) => item.direct_tool_pid_gone && item.direct_plugin_pid_gone,
      ),
    );
  }
}
