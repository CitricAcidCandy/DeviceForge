import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeArgv, readIfExists } from '../mirroring-streaming-smoke/fixtures.mjs';
import { finishProbe, startProbe } from '../harmony-screenshot-smoke/fixtures.mjs';
import { poll } from '../device-provider/client.mjs';

const callNames = async (fixture) => (await readdir(fixture.root)).filter((name) => /^call-\d{3}$/.test(name)).sort();
const numberFile = async (path) => {
  const bytes = await readIfExists(path);
  return bytes ? Number(bytes.toString('utf8')) : null;
};
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();

// 短命令先由原生探针持有真实 OS 句柄，才释放门闩；PID 记录本身不作为退出证据。
export function observeTools(fixture, probeBinary, pluginBinary, report) {
  const observed = new Map();
  let stopping = false, failure;
  const worker = (async () => {
    while (!stopping) {
      for (const name of await callNames(fixture)) {
        if (observed.has(name)) continue;
        const directory = join(fixture.root, name);
        if (!(await readIfExists(join(directory, 'ready')))) continue;
        const pid = Number(await readFile(join(directory, 'pid'), 'utf8'));
        const category = await readFile(join(directory, 'category'), 'utf8');
        const argv = decodeArgv(await readFile(join(directory, 'argv.bin')));
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        const probe = await startProbe(probeBinary, pid, join(directory, 'process'), pluginBinary);
        const entry = {
          name, directory, pid, category, argv,
          started_unix_ms: await numberFile(join(directory, 'started-unix-ms')),
          probe_pid: probe.child.pid, probe_ready: probe.ready,
        };
        observed.set(name, { probe, entry });
        report.tools.push(entry);
        assert.ok(samePath(probe.ready.target.exe, fixture.adb), '只接管本轮假 ADB，拒绝真实工具');
        assert.equal(probe.ready.target.pid, pid);
        assert.equal(probe.ready.target.state, 'running');
        assert.equal(probe.ready.parent.state, 'running');
        assert.equal(category === 'rejected', false, '全局及未知命令不允许被夹具接受');
        await writeFile(join(directory, 'release'), '1', { flag: 'wx' });
        entry.gate_released_at = new Date().toISOString();
      }
      await delay(5);
    }
  })().catch((error) => { failure = error; });
  return {
    assertHealthy() { if (failure) throw failure; },
    async verifyServerExit(device, priorServers = 0) {
      const current = [...observed.values()].filter(({ entry }) => entry.category === 'server' && entry.argv[1] === device).slice(priorServers);
      assert.equal(current.length, 1, '每个无重连会话只有一个直接媒体进程');
      const evidence = [];
      for (const { probe, entry } of current) {
        const final = await poll(() => readIfExists(probe.evidence + '.exit.json'), Boolean,
          '已结束会话的原进程探针终态', 3000);
        const state = JSON.parse(final.toString('utf8'));
        entry.after_cancel = state;
        assert.equal(state.test_kill, false);
        assert.equal(state.target.state, 'exited', '取消终态前本次媒体直接进程应已退出');
        evidence.push({ pid: entry.pid, probe_pid: entry.probe_pid, state });
      }
      return evidence;
    },
    async finish() {
      stopping = true;
      await worker;
      const errors = failure ? [failure] : [];
      try {
        assert.deepEqual([...observed.keys()].sort(), await callNames(fixture), '每个实际调用均须有原始 OS 句柄证据');
      } catch (error) { errors.push(error); }
      // 即使某一个探针断言失败，其他自有探针仍逐一收尾。
      await Promise.all([...observed.values()].map(async ({ probe, entry }) => {
        try {
          entry.process = await Promise.race([
            finishProbe(probe),
            delay(8000).then(() => { throw new Error('本轮 OS 探针退出超时'); }),
          ]);
          entry.action_started_unix_ms = await numberFile(join(entry.directory, 'action-started-unix-ms'));
          entry.completed_unix_ms = await numberFile(join(entry.directory, 'completed-unix-ms'));
          entry.intended_exit_code = await numberFile(join(entry.directory, 'intended-exit-code'));
          entry.injection = (await readIfExists(join(entry.directory, 'injection')))?.toString('utf8') ?? null;
          entry.delay_ms = await numberFile(join(entry.directory, 'delay-ms'));
          assert.equal(entry.process.exit.target.state, 'exited');
          assert.equal(entry.process.exit.parent.state, 'exited');
          assert.equal(entry.process.exit.parent.exit_code, 0, '独立插件必须正常退出');
          assert.equal(await readIfExists(join(entry.directory, 'failure')), null, '夹具不得放宽不匹配合同');
          assert.equal(await readIfExists(join(entry.directory, 'fixture-stop')), null, '兜底自退不属于正常回收通过');
          if (entry.intended_exit_code !== null)
            assert.equal(entry.process.exit.target.exit_code, entry.intended_exit_code, '工具实际退出码应与本次故障注入一致');
          assert.deepEqual(entry.argv.slice(0, 1), ['-s']);
          assert.ok(!entry.argv.some((item) => /kill-server|--remove-all|pkill|killall/.test(item)), '禁止全局命令');
        } catch (error) { errors.push(error); }
      }));
      if (errors.length) throw new AggregateError(errors, '独占进程回收或合同核验失败');
    },
    async stop() { stopping = true; await worker; },
  };
}
