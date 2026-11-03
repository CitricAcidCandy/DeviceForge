import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginInstallations } from '../src/features/plugin-installations/index.ts';
import type { PluginInstallation } from '../src/features/plugin-installations/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { deferred, signal } from './fixtures.ts';
import { installationFixture, release, result } from './plugin-installations-fixture.ts';

const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });
function installation(id: string, componentCount = 1): PluginInstallation {
  const original = release(true);
  return { ...original, id, components: Array.from({ length: componentCount }, (_, index) => ({
    id: `${id}.browser.${index}`, kind: 'browser', version: original.version, revision: original.revision,
    entryPath: 'dist/index.js',
    entryUrl: `/api/v2/plugin-installations/browser/${id}.browser.${index}/revisions/${original.revision}/assets/dist/index.js`,
  })) };
}

test('统一安装恢复的慢首项不挡后续界面，同时在途最多四项且单包组件保持顺序', async () => {
  const values = Array.from({ length: 7 }, (_, index) => installation(`release-${index}`, index === 0 ? 2 : 1));
  const gates = values.map(() => deferred<void>());
  const fixture = installationFixture();
  const entered: string[] = [];
  let inFlight = 0, maximum = 0, completed = false;
  const model = createPluginInstallations({ ...fixture.gateway, list: async () => result(values) }, {
    enable: async (value, component) => {
      const index = values.findIndex((entry) => entry.id === value.id);
      const gate = gates[index]; assert.ok(gate);
      entered.push(component.id); maximum = Math.max(maximum, ++inFlight);
      try { await gate.promise; } finally { inFlight--; }
    },
    disable: fixture.browser.disable,
  });
  const waiting = model.restore(signal());
  void waiting.then(() => { completed = true; }, () => { completed = true; });
  try {
    await turn();
    assert.deepEqual(entered, values.slice(0, 4).map((value) => `${value.id}.browser.0`),
      '慢首项不能让其他安装包连激活都无法开始');
    assert.equal(maximum, 4);
    assert.equal(entered.includes('release-0.browser.1'), false, '单包第二组件不能越过第一组件');
    gates[1]?.resolve(); await turn();
    assert.equal(entered.includes('release-4.browser.0'), true, '空出名额后继续后项，不等整批最慢项');
    gates[2]?.resolve(); gates[3]?.resolve(); gates[4]?.resolve(); await turn();
    gates[5]?.resolve(); gates[6]?.resolve(); await turn();
    assert.equal(completed, false);
    assert.equal(model.clientSnapshot().find((value) => value.id === 'release-6')?.phase, 'enabled');
    gates[0]?.resolve(); await waiting;
    assert.ok(entered.indexOf('release-0.browser.1') > entered.indexOf('release-0.browser.0'));
    assert.equal(maximum, 4);
    assert.equal(model.clientSnapshot().filter((value) => value.phase === 'enabled').length, 7);
    assert.deepEqual(fixture.events, [], '恢复只读取目录并装载浏览器，不提交服务器安装或启用任务');
  } finally {
    for (const gate of gates) gate.resolve();
    await waiting.catch(() => undefined); model.dispose();
  }
});

test('并行恢复的失败只清理所属安装已启动组件，保留其他成功和原错误日志', async () => {
  const first = installation('failed-release', 2), second = installation('healthy-release');
  const fixture = installationFixture();
  const failure = new ApiError('http', 'activation_failed', '第二组件本次激活失败', 503, 'restore-failure-log');
  const barrier = deferred<void>();
  const events: string[] = [];
  const model = createPluginInstallations({ ...fixture.gateway, list: async () => result([first, second]) }, {
    enable: async (value, component) => {
      events.push(`enable:${component.id}`);
      if (value.id === second.id) { barrier.resolve(); return; }
      if (component.id.endsWith('.1')) { await barrier.promise; throw failure; }
    },
    disable: async (component) => { events.push(`disable:${component.id}`); },
  });
  const waiting = model.restore(signal());
  void waiting.catch(() => undefined);
  try {
    await turn();
    assert.equal(model.clientSnapshot().find((value) => value.id === second.id)?.phase, 'enabled',
      '另一安装包不必等待失败组件收敛才可用');
    await assert.rejects(waiting, (error: unknown) => error instanceof AggregateError && error.errors[0] === failure);
    assert.deepEqual(events.filter((entry) => entry.startsWith('disable:')), ['disable:failed-release.browser.0']);
    assert.equal(model.clientSnapshot().find((value) => value.id === first.id)?.logId, 'restore-failure-log');
    assert.equal(model.clientSnapshot().find((value) => value.id === second.id)?.phase, 'enabled');
  } finally { barrier.resolve(); await waiting.catch(() => undefined); model.dispose(); }
});

for (const ending of ['cancel', 'dispose']) {
  test(`恢复${ending === 'cancel' ? '取消' : '销毁'}后不领取新包，忽略取消的晚到组件不发布成功`, async () => {
    const values = Array.from({ length: 6 }, (_, index) => installation(`release-${index}`));
    const gates = values.map(() => deferred<void>());
    const fixture = installationFixture();
    const controller = new AbortController();
    const entered: string[] = [];
    const model = createPluginInstallations({ ...fixture.gateway, list: async () => result(values) }, {
      enable: async (value) => {
        entered.push(value.id);
        const gate = gates[values.findIndex((entry) => entry.id === value.id)]; assert.ok(gate);
        await gate.promise;
      },
      disable: fixture.browser.disable,
    });
    const waiting = model.restore(controller.signal);
    void waiting.catch(() => undefined);
    try {
      await turn();
      assert.deepEqual(entered, values.slice(0, 4).map((value) => value.id));
      if (ending === 'cancel') controller.abort(); else model.dispose();
      await assert.rejects(waiting, (reason: unknown) => reason instanceof ApiError && reason.kind === 'cancelled');
      const expected = values.slice(0, 4).map((value) => value.id);
      if (ending === 'cancel') {
        const next = values[4]; assert.ok(next);
        gates[4]?.resolve();
        await model.retryBrowser(next.id, next.revision, signal());
        assert.equal(model.clientSnapshot().find((value) => value.id === next.id)?.phase, 'enabled',
          '显式新操作不必等待取消恢复的旧组件');
        expected.push(next.id);
      }
      const beforeLate = model.clientSnapshot();
      for (const gate of gates) gate.resolve();
      await turn();
      assert.deepEqual(entered, expected, '撤销后只有显式新调用可以开始剩余安装包');
      assert.deepEqual(model.clientSnapshot(), beforeLate, '晚到成功不得改写已取消或已销毁状态');
      assert.equal(fixture.events.some((event) => /install|enable-server|disable-server/.test(event)), false);
    } finally {
      for (const gate of gates) gate.resolve();
      await waiting.catch(() => undefined); model.dispose();
    }
  });
}

test('不同安装包倒序失败仍按原目录顺序交付错误，不覆盖各自日志', async () => {
  const values = [installation('first-release'), installation('second-release')];
  const firstGate = deferred<void>();
  const first = new ApiError('http', 'first_failed', '首包本次失败', 500, 'first-log');
  const second = new ApiError('http', 'second_failed', '次包本次失败', 500, 'second-log');
  const fixture = installationFixture();
  const model = createPluginInstallations({ ...fixture.gateway, list: async () => result(values) }, {
    enable: async (value) => {
      if (value.id === values[0]?.id) { await firstGate.promise; throw first; }
      throw second;
    },
    disable: fixture.browser.disable,
  });
  const waiting = model.restore(signal());
  void waiting.catch(() => undefined);
  try {
    await turn();
    assert.equal(model.clientSnapshot().find((value) => value.id === values[1]?.id)?.logId, 'second-log');
    firstGate.resolve();
    await assert.rejects(waiting, (reason: unknown) => reason instanceof AggregateError &&
      reason.errors.length === 2 && reason.errors[0] === first && reason.errors[1] === second);
    assert.equal(model.clientSnapshot().find((value) => value.id === values[0]?.id)?.logId, 'first-log');
  } finally { firstGate.resolve(); await waiting.catch(() => undefined); model.dispose(); }
});
