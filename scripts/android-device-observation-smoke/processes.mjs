import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  finishPendingProbes,
  finishProbe,
  startProbe,
} from '../harmony-screenshot-smoke/fixtures.mjs';
import { decodeArgv, readIfExists } from '../mirroring-streaming-smoke/fixtures.mjs';
export { finishPendingProbes };

// 每个直接工具先门闩，取得当次工具与父插件OS句柄后放行，不查历史PID。
export function observeTools(fixture, probeBinary, pluginBinary, report) {
  const observed = new Map();
  let stopped = false,
    failure,
    holdCategory = null;
  const worker = (async () => {
    while (!stopped) {
      const names = (await readdir(fixture.root))
        .filter((name) => /^call-\d{3}$/.test(name))
        .sort();
      assert.ok(names.length <= 256);
      for (const name of names) {
        if (observed.has(name)) continue;
        const directory = join(fixture.root, name);
        if (!(await readIfExists(join(directory, 'ready')))) continue;
        const pid = Number(await readFile(join(directory, 'pid'), 'utf8'));
        const category = await readFile(join(directory, 'category'), 'utf8');
        const argv = decodeArgv(await readFile(join(directory, 'argv.bin')));
        const probe = await startProbe(probeBinary, pid, join(directory, 'process'), pluginBinary);
        const held = category === holdCategory;
        if (held) holdCategory = null;
        const entry = { name, directory, pid, category, argv, held, probe_ready: probe.ready };
        observed.set(name, { probe, entry });
        report.tools.push(entry);
        if (!held) await writeFile(join(directory, 'release'), '1', { flag: 'wx' });
      }
      await delay(10);
    }
  })().catch((error) => {
    failure = error;
  });
  return {
    holdNext(category) {
      assert.equal(holdCategory, null);
      holdCategory = category;
    },
    assertHealthy() {
      if (failure) throw failure;
    },
    async finish() {
      stopped = true;
      await worker;
      if (failure) throw failure;
      const names = (await readdir(fixture.root))
        .filter((name) => /^call-\d{3}$/.test(name))
        .sort();
      assert.deepEqual([...observed.keys()].sort(), names);
      for (const { probe, entry } of observed.values()) {
        entry.process = await finishProbe(probe);
        assert.equal(entry.process.exit.test_kill, false);
        assert.equal(entry.process.exit.target.state, 'exited');
        assert.equal(entry.process.exit.parent.state, 'exited');
        assert.equal(entry.process.exit.parent.exit_code, 0);
        if (!entry.held) assert.equal(entry.process.exit.target.exit_code, 0);
      }
    },
    async stop() {
      stopped = true;
      await worker;
    },
  };
}
