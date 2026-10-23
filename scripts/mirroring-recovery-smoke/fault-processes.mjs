import assert from 'node:assert/strict';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { finishProbe, startProbe } from '../harmony-screenshot-smoke/fixtures.mjs';
import { poll } from '../device-provider/client.mjs';
import { readIfExists } from './fixtures.mjs';

export const isFaultCallName = (name) => /^call-[a-f0-9-]{36}\.ready\.json$/.test(name);

export function observeFaultWorkers(root, probeBinary, hostBinary, report) {
  const observed = new Map();
  let stopping = false, failure;
  const worker = (async () => {
    while (!stopping) {
      for (const name of (await readdir(root)).filter(isFaultCallName)) {
        if (observed.has(name)) continue;
        const base = join(root, name.slice(0, -'.ready.json'.length));
        const identity = JSON.parse(await readFile(join(root, name), 'utf8'));
        const probe = await startProbe(probeBinary, identity.pid, base + '.process', hostBinary);
        const entry = { pid: identity.pid, command: '本轮 Node 协议故障夹具',
          protocol_version: identity.protocol_version, operation: identity.operation,
          probe_pid: probe.child.pid, probe_ready: probe.ready, base };
        observed.set(name, { probe, entry });
        (report.fault_workers ??= []).push(entry);
        assert.equal(resolve(await realpath(probe.ready.target.exe)).toLowerCase(), resolve(await realpath(process.execPath)).toLowerCase());
        assert.equal(probe.ready.target.pid, identity.pid);
        assert.equal(probe.ready.target.state, 'running');
        await writeFile(base + '.release', '1', { flag: 'wx' });
      }
      await delay(5);
    }
  })().catch((error) => { failure = error; });
  return {
    assertHealthy() { if (failure) throw failure; },
    async verifyLatestExit(operation) {
      if (failure) throw failure;
      const current = [...observed.values()].filter(({ entry }) => entry.operation === operation).at(-1);
      assert.ok(current, '必须观察到本次真实故障进程');
      const state = await poll(async () => {
        const final = await readIfExists(current.probe.evidence + '.exit.json');
        if (final) return JSON.parse(final.toString('utf8'));
        // 探针会继续等待宿主退出；目标的原始句柄状态由观测请求单独记录。
        if (current.probe.child.exitCode !== null) throw new Error('探针已退出但缺少终态证据');
        return null;
      }, Boolean, '故障进程原始句柄退出', 1000).catch(async (error) => {
        if (current.probe.child.exitCode !== null) throw error;
        const { observeProbe } = await import('../harmony-screenshot-smoke/fixtures.mjs');
        return observeProbe(current.probe);
      });
      current.entry.after_request = state;
      assert.equal(state.target.state, 'exited', '请求返回后本次原进程必须已退出');
      return state;
    },
    async finish() {
      stopping = true; await worker;
      const errors = failure ? [failure] : [];
      await Promise.all([...observed.values()].map(async ({ probe, entry }) => {
        try {
          entry.process = await Promise.race([finishProbe(probe), delay(7000).then(() => {
            throw new Error('故障夹具原进程句柄未退出');
          })]);
          entry.response_written = (await readIfExists(entry.base + '.response-written'))?.toString('utf8') ?? null;
          assert.equal(entry.process.exit.target.state, 'exited');
          assert.equal(entry.process.exit.parent.state, 'exited');
          assert.equal(entry.process.exit.parent.exit_code, 0);
        } catch (error) { errors.push(error); }
      }));
      const actual = (await readdir(root)).filter(isFaultCallName).sort();
      try { assert.deepEqual([...observed.keys()].sort(), actual, '每个故障进程必须持有原始句柄'); }
      catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, '故障夹具进程回收失败');
    },
    async stop() { stopping = true; await worker; },
  };
}
