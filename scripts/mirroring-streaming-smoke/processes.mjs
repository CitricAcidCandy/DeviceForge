import assert from 'node:assert/strict';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  finishPendingProbes,
  finishProbe,
  startProbe,
} from '../harmony-screenshot-smoke/fixtures.mjs';
import { decodeArgv, readIfExists } from './fixtures.mjs';
import { poll } from '../device-provider/client.mjs';

export { finishPendingProbes };

// 短命令在独立门闩停留，取得真实 OS 句柄后才继续；不以历史 PID 判断退出。
export function observeTools(fixture, probeBinary, pluginBinary, report) {
  const observed = new Map();
  let stopping = false,
    firstFailure;
  const worker = (async () => {
    while (!stopping) {
      const names = (await readdir(fixture.root))
        .filter((name) => /^call-\d{3}$/.test(name))
        .sort();
      for (const name of names) {
        if (observed.has(name)) continue;
        const directory = join(fixture.root, name);
        if (!(await readIfExists(join(directory, 'ready')))) continue;
        const pid = Number(await readFile(join(directory, 'pid'), 'utf8'));
        const category = await readFile(join(directory, 'category'), 'utf8');
        const argv = decodeArgv(await readFile(join(directory, 'argv.bin')));
        const probe = await startProbe(probeBinary, pid, join(directory, 'process'), pluginBinary);
        const entry = { name, directory, pid, category, argv, probe_ready: probe.ready };
        report.tools.push(entry);
        observed.set(name, { probe, entry });
        await writeFile(join(directory, 'release'), '1', { flag: 'wx' });
      }
      await delay(10);
    }
  })().catch((error) => {
    firstFailure = error;
  });
  return {
    assertHealthy: () => {
      if (firstFailure) throw firstFailure;
    },
    verifyServerExit: async (device) => {
      const servers = [...observed.values()].filter(
        ({ entry }) => entry.category === 'server' && entry.argv[1] === device,
      );
      assert.ok(servers.length > 0, '清理后的每个server须有原始OS句柄');
      const evidence = [];
      for (const { probe, entry } of servers) {
        const exited = await readIfExists(probe.evidence + '.exit.json');
        if (exited) entry.after_cleanup = JSON.parse(exited.toString());
        else {
          const pending = probe.evidence + '.request.tmp';
          await writeFile(pending, '1', { flag: 'wx' });
          await rename(pending, probe.evidence + '.request');
          entry.after_cleanup = await poll(
            async () => {
              const bytes =
                (await readIfExists(probe.evidence + '.observed.json')) ??
                (await readIfExists(probe.evidence + '.exit.json'));
              return bytes ? JSON.parse(bytes.toString()) : null;
            },
            Boolean,
            '取消或卸载后原句柄OS状态',
          );
        }
        assert.equal(entry.after_cleanup.test_kill, false);
        assert.equal(
          entry.after_cleanup.target.state,
          'exited',
          'server终止后操作系统释放其socket句柄',
        );
        evidence.push({ name: entry.name, pid: entry.pid, observed: entry.after_cleanup });
      }
      return evidence;
    },
    finish: async () => {
      stopping = true;
      await worker;
      if (firstFailure) throw firstFailure;
      const names = (await readdir(fixture.root))
        .filter((name) => /^call-\d{3}$/.test(name))
        .sort();
      assert.deepEqual([...observed.keys()].sort(), names, '每个实际 ADB 调用必须取得独立 OS 句柄');
      for (const { probe, entry } of observed.values()) {
        entry.process = await finishProbe(probe);
        assert.equal(entry.process.exit.target.state, 'exited');
        assert.equal(entry.process.exit.parent.state, 'exited');
        assert.equal(entry.process.exit.parent.exit_code, 0);
        if (entry.category !== 'server') assert.equal(entry.process.exit.target.exit_code, 0);
      }
    },
    stop: async () => {
      stopping = true;
      await worker;
    },
  };
}
