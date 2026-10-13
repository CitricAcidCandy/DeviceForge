import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { finishPendingProbes, finishProbe, startProbe } from '../harmony-screenshot-smoke/fixtures.mjs';
import { decodeArgv, readIfExists } from '../mirroring-streaming-smoke/fixtures.mjs';
export { finishPendingProbes };

// 每个直接工具先门闩，取得当次工具与父插件OS句柄后放行，不查历史PID。
export function observeTools(fixture, probeBinary, pluginBinary, report) {
  const observed = new Map(), ordinals = new Map(); let stopped = false, failure, holdCategory = null;
  const worker = (async () => {
    while (!stopped) {
      const names = (await readdir(fixture.root)).filter(name => /^call-\d{3}$/.test(name)).sort();
      assert.ok(names.length <= 256);
      for (const name of names) {
        if (observed.has(name)) continue;
        const directory = join(fixture.root, name);
        if (!await readIfExists(join(directory, 'ready'))) continue;
        const pid = Number(await readFile(join(directory, 'pid'), 'utf8'));
        const category = await readFile(join(directory, 'category'), 'utf8');
        const argv = decodeArgv(await readFile(join(directory, 'argv.bin')));
        const mode = await readFile(join(directory, 'mode'), 'utf8');
        const scenario = fixture.cases.find(value => value.id === mode); assert.ok(scenario, 'PROFILE-OS-KNOWN-MODE');
        const matches = [...fixture.shared, ...scenario.commands].filter(spec => JSON.stringify(spec.argv) === JSON.stringify(argv));
        assert.equal(matches.length, 1, 'PROFILE-OS-FROZEN-ARGV'); assert.equal(matches[0].category, category, 'PROFILE-OS-CATEGORY');
        const key = mode + ':' + JSON.stringify(argv), ordinal = ordinals.get(key) ?? 0; ordinals.set(key, ordinal + 1);
        const planned = matches[0].outputs[Math.min(ordinal, matches[0].outputs.length - 1)];
        const declared = Number(await readFile(join(directory, 'exit_code'), 'utf8'));
        assert.equal(declared, planned.exit, 'PROFILE-OS-PLANNED-EXIT');
        const probe = await startProbe(probeBinary, pid, join(directory, 'process'), pluginBinary);
        const held = category === holdCategory;
        if (held) holdCategory = null;
        const entry = { name, directory, pid, category, argv, mode, ordinal, planned_exit: planned.exit, held, probe_ready: probe.ready };
        observed.set(name, { probe, entry }); report.tools.push(entry);
        if (!held) await writeFile(join(directory, 'release'), '1', { flag: 'wx' });
      }
      await delay(10);
    }
  })().catch(error => { failure = error; });
  return {
    holdNext(category) { assert.equal(holdCategory, null); holdCategory = category; },
    assertHealthy() { if (failure) throw failure; },
    async finish() {
      stopped = true; await worker; if (failure) throw failure;
      const names = (await readdir(fixture.root)).filter(name => /^call-\d{3}$/.test(name)).sort();
      assert.deepEqual([...observed.keys()].sort(), names);
      for (const { probe, entry } of observed.values()) {
        entry.process = await finishProbe(probe);
        assert.equal(entry.process.exit.test_kill, false);
        assert.equal(entry.process.exit.target.state, 'exited');
        assert.equal(entry.process.exit.parent.state, 'exited'); assert.equal(entry.process.exit.parent.exit_code, 0);
        if (!entry.held) assert.equal(entry.process.exit.target.exit_code, entry.planned_exit, 'PROFILE-OS-EXPECTED-TOOL-EXIT');
      }
    },
    async stop() { stopped = true; await worker; },
  };
}
