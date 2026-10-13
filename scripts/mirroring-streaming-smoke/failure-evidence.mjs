import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { finishProbe, startProbe } from '../harmony-screenshot-smoke/fixtures.mjs';
import { decodeArgv, readIfExists } from './fixtures.mjs';

// 失败资源场景仍以实际OS句柄确认退出，远端状态保留于独立模拟文件。
export function observeFailureTools(fixture, probeBinary, pluginBinary, report, scenario) {
  const observed = new Map(); let stop = false, failure;
  const worker = (async () => {
    while (!stop) {
      const names = (await readdir(fixture.root)).filter(name => /^call-\d{3}$/.test(name)).sort();
      for (const name of names) {
        if (observed.has(name)) continue;
        const directory = join(fixture.root, name);
        if (!await readIfExists(join(directory, 'ready'))) continue;
        const pid = Number(await readFile(join(directory, 'pid'), 'utf8'));
        const category = await readFile(join(directory, 'category'), 'utf8');
        const probe = await startProbe(probeBinary, pid, join(directory, 'process'), pluginBinary);
        const entry = { name, directory, pid, category, argv: decodeArgv(await readFile(join(directory, 'argv.bin'))), probe_ready: probe.ready };
        report.tools.push(entry); observed.set(name, { probe, entry });
        await writeFile(join(directory, 'release'), '1', { flag: 'wx' });
      }
      await delay(10);
    }
  })().catch(error => { failure = error; });
  return {
    stop: async () => { stop = true; await worker; },
    finish: async () => {
      stop = true; await worker; if (failure) throw failure;
      const names = (await readdir(fixture.root)).filter(name => /^call-\d{3}$/.test(name)).sort();
      assert.deepEqual([...observed.keys()].sort(), names);
      for (const { probe, entry } of observed.values()) {
        entry.process = await finishProbe(probe);
        assert.equal(entry.process.exit.target.state, 'exited');
        assert.equal(entry.process.exit.parent.state, 'exited');
        assert.equal(entry.process.exit.parent.exit_code, 0);
        if (entry.category !== 'server') assert.equal(entry.process.exit.target.exit_code,
          scenario === 'missing-pid' && entry.category === 'cleanup' ? 9 : 0);
      }
    },
  };
}

export async function failureLogs(directory, host, report) {
  const root = join(directory, 'data/logs'); const found = new Set(); let starts = 0, ends = 0, stops = 0, records = 0;
  for (const name of (await readdir(root)).filter(name => name.endsWith('.jsonl'))) {
    for (const line of (await readFile(join(root, name), 'utf8')).split('\n').filter(Boolean)) {
      const record = JSON.parse(line); records++;
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
          if (key === 'log_id' && host.client.logIds.has(item)) found.add(item);
          else if (item && typeof item === 'object') visit(item);
        }
      };
      visit(record.fields); visit(record.span); visit(record.spans);
      if (record.fields?.message === '宿主运行已结束') stops++;
      if (record.fields?.session_id !== report.opened[0].id) continue;
      if (record.fields.message === '交互会话已准入') starts++;
      if (record.fields.message === '交互会话已结束') { ends++; assert.equal(record.fields.cleanup, 'Some(Failed)'); }
    }
  }
  assert.equal(starts, 1); assert.equal(ends, 1); assert.ok(stops > 0);
  assert.deepEqual([...found].sort(), [...host.client.logIds].sort());
  report.logging = { records, starts, ends, normal_stops: stops, response_ids: [...found].sort() };
}
