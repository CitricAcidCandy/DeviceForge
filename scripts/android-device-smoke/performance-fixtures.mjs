import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { finishedTool, observations, otherId } from './fixtures.mjs';

export const sampleCapability = 'performance.sample';
export const samplePid = 2468;
export const sampleArgv = (packageName, deviceId = otherId) => [
  ['-s', deviceId, 'shell', '-T', 'pidof', '-s', packageName],
  ['-s', deviceId, 'shell', '-T', 'cat', '/proc/2468/stat'],
  ['-s', deviceId, 'shell', '-T', 'dumpsys', 'meminfo', '-s', '2468'],
  ['-s', deviceId, 'shell', '-T', 'cat', '/proc/2468/stat'],
  ['-s', deviceId, 'shell', '-T', 'cat', '/proc/stat'],
];

export function sampleGroups(items) {
  const groups = new Map();
  for (const item of items.filter((item) => item.ready.tool_kind === 'performance')) {
    const key = item.ready.plugin_pid + ':' + item.ready.sample_tick;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map((group) =>
    group.sort((left, right) => left.ready.performance_step - right.ready.performance_step),
  );
}

export async function finishSample(
  group,
  { packageName, deviceId = otherId, partial = false } = {},
) {
  assert.ok(group.length >= 1 && group.length <= 5);
  if (!partial) assert.equal(group.length, 5, 'AD-PERF-FIVE-TOOLS');
  const expected = sampleArgv(packageName, deviceId),
    first = group[0].ready;
  const tools = [];
  for (const [index, item] of group.entries()) {
    assert.equal(item.ready.plugin_pid, first.plugin_pid);
    assert.equal(item.ready.sample_tick, first.sample_tick);
    assert.equal(item.ready.sample_package, packageName);
    assert.equal(item.ready.performance_step, index + 1);
    assert.deepEqual(item.ready.argv, expected[index], 'AD-PERF-FIXED-ARGV');
    let cancelled = false;
    try {
      await readFile(join(item.directory, 'completed.json'));
    } catch (error) {
      assert.equal(error.code, 'ENOENT');
      cancelled = true;
    }
    tools.push(await finishedTool(item, { cancelled }));
  }
  if (!partial) assert.ok(tools.every((tool) => tool.completed?.code === 0));
  return {
    parent_plugin_pid: first.plugin_pid,
    package: packageName,
    sample_tick: first.sample_tick,
    complete: group.length === 5 && tools.every((tool) => tool.completed?.code === 0),
    tools,
    boundary: '同父插件PID的五笔实际工具与退出意图；不证明真实设备指标或派生树',
  };
}

export function rawSample(value, group) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'captured_at',
      'logical_cpus',
      'pid',
      'process_start_ticks',
      'process_ticks',
      'pss_kib',
      'rss_kib',
      'system_ticks',
    ].sort(),
  );
  assert.ok(
    Number.isSafeInteger(value.captured_at) &&
      value.captured_at >= group.sample_tick &&
      value.captured_at <= Date.now() + 5000,
  );
  assert.deepEqual(
    { ...value, captured_at: 0 },
    {
      captured_at: 0,
      pid: samplePid,
      process_start_ticks: 900,
      process_ticks: group.sample_tick * 10,
      system_ticks: group.sample_tick * 100,
      logical_cpus: 2,
      pss_kib: 2048,
      rss_kib: 4096,
    },
  );
}

export async function waitSamples(fixture, packageName, minimum = 1) {
  return poll(
    async () => {
      const groups = sampleGroups(
        (await observations(fixture)).filter((item) => item.ready.sample_package === packageName),
      );
      const complete = [];
      for (const group of groups.filter((items) => items.length === 5)) {
        try {
          await readFile(join(group[4].directory, 'completed.json'));
          complete.push(group);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const latest = groups.at(-1)?.[0].ready.sample_tick;
      return {
        complete,
        following_started:
          complete.length >= minimum && latest > complete[minimum - 1][0].ready.sample_tick,
      };
    },
    (observed) => observed.following_started,
    '性能目标五笔样本后的下一轮真实启动',
    15000,
  ).then((observed) => observed.complete);
}
