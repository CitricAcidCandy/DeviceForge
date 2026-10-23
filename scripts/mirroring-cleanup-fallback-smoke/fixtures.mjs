import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareFixture, readIfExists } from '../mirroring-streaming-smoke/fixtures.mjs';
import { parseDfml } from '../mirroring-streaming-smoke/golden.mjs';
import { poll } from '../device-provider/client.mjs';

export const scenarios = [
  'success', 'list-once', 'remove-reply-lost', 'cleanup-once',
  'list-always', 'foreign-forward', 'shared-budget',
];
export const failedScenarios = new Set(['list-always', 'foreign-forward', 'shared-budget']);

export async function prepareCase(directory, binary, scenario, version, runId) {
  const device = 'cleanup-' + scenario;
  const nextDevice = 'retry-after-' + scenario;
  const fixture = await prepareFixture(directory, binary, { [device]: {}, [nextDevice]: {} });
  await writeFile(join(fixture.root, 'fixture-owner'), runId, { flag: 'wx' });
  for (const [id, mode] of [[device, scenario], [nextDevice, 'success']]) {
    await writeFile(join(fixture.plan(id), 'mode'), mode, { flag: 'wx' });
    await writeFile(join(fixture.plan(id), 'server-version'), version, { flag: 'wx' });
  }
  return { ...fixture, device, nextDevice };
}

export async function fixtureState(fixture, device) {
  const plan = fixture.plan(device);
  const names = [
    'expected-dir', 'remote-dir', 'remote-pid', 'remote-owner', 'remote-cleaned',
    'port', 'scid', 'forward-owned', 'forward-device', 'forward-scid',
    'forward-removed', 'foreign-original', 'epoch-1/media-sent',
  ];
  const state = {};
  for (const name of names) state[name] = (await readIfExists(join(plan, name)))?.toString('utf8') ?? null;
  for (const kind of ['cleanup', 'list', 'remove'])
    state[kind + '_attempts'] = (await readdir(plan)).filter((name) => name.startsWith(kind + '-attempt-')).length;
  return state;
}

export async function waitActualMedia(host, fixture, id, device) {
  await poll(async () => {
    const page = await host.client.json(`/api/v2/sessions/${id}/output?after=0&limit=100`);
    const bytes = Buffer.concat(page.chunks.filter((chunk) => chunk.stream === 'stdout')
      .map((chunk) => Buffer.from(chunk.bytes)));
    const parsed = parseDfml(bytes);
    if (page.session.status === 'finished') {
      const error = new Error('实际视频包之前会话已经终态');
      error.session = page.session;
      throw error;
    }
    return parsed.frames.some((frame) => frame.kind === 2);
  }, Boolean, '至少一个完整 DFML 视频包');
  await poll(() => readIfExists(join(fixture.plan(device), 'epoch-1/media-sent')),
    Boolean, '本次假设备媒体套接字实际发送');
}

export async function assertCaseState(fixture, scenario, tools) {
  const state = await fixtureState(fixture, fixture.device);
  assert.equal(state['remote-cleaned'], '1', '远端模拟资源必须有明确清理回执');
  for (const name of ['remote-dir', 'remote-pid', 'remote-owner']) assert.equal(state[name], null);
  const selected = tools.filter((entry) => entry.argv[1] === fixture.device);
  const lists = selected.filter((entry) => entry.category === 'list-forward');
  const removals = selected.filter((entry) => entry.category === 'remove-forward');
  assert.ok(state.cleanup_attempts >= 1 && state.cleanup_attempts <= 2, '远端目录最多两轮清理');
  assert.ok(state.remove_attempts <= 2, '最多两次独占端口删除');
  assert.ok(lists.length >= 1 && lists.length <= 4, '两轮查询及删除后确认必须有界');
  if (failedScenarios.has(scenario)) {
    assert.equal(state['forward-owned'], state.port, '未确认资源不得伪造已清理');
    assert.equal(state['forward-removed'], null);
    assert.equal(removals.length, 0, '查询失败或归属冲突时不得删除转发');
    assert.ok(lists.length <= 2, '失败查询最多两轮');
    if (scenario === 'foreign-forward') {
      assert.equal(state['forward-device'], 'foreign-device');
      assert.equal(state['forward-scid'], 'ffffffff');
      assert.equal(state['foreign-original'], `foreign-device tcp:${state.port} localabstract:scrcpy_ffffffff\n`);
    } else if (scenario === 'shared-budget') assert.equal(lists.length, 1, '原预算耗尽后不得启动第二轮');
    else assert.equal(lists.length, 2, '可重试失败在预算足够时执行第二轮');
  } else {
    for (const name of ['forward-owned', 'forward-device', 'forward-scid']) assert.equal(state[name], null);
    assert.equal(state['forward-removed'], '1');
    assert.equal(removals.length, 1, '确认已消失后不得盲目重删');
    if (scenario === 'list-once') {
      assert.equal(lists.length, 3, '首次查询失败、第二轮查询及删除后确认');
      assert.equal(lists[0].intended_exit_code, 1);
      assert.equal(lists[1].intended_exit_code, 0);
    }
    if (scenario === 'remove-reply-lost') {
      assert.equal(removals[0].intended_exit_code, 1, '实际删除后返回非零');
      assert.ok(lists.some((entry) => entry.name > removals[0].name), '丢失回执后须重新查询');
    }
    if (scenario === 'cleanup-once') assert.equal(state.cleanup_attempts, 2);
  }
  return state;
}
