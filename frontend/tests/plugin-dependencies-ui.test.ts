import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, StrictMode } from 'react';
import { createApiClient } from '../src/services/api/index.ts';
import type { DependencyTarget } from '../src/features/plugin-dependencies/index.ts';
import { dependenciesView, dependency, dependencyEvent, dependencyJob } from './plugin-dependencies-fixtures.ts';
import { deferred, failure, requestUrl, success } from './fixtures.ts';
import { dependencyDom, settled } from './plugin-dependencies-dom.ts';

test('真实依赖面板：空态、必需/可选补装、日志复制、canonical、严格模式和关闭取消', async (t) => {
  const dom = await dependencyDom();
  const { PluginDependencies } = await import('../src/pages/marketplace/components/PluginDependencies/index.tsx');
  try {
    await t.test('空依赖显示明确提示，重新检测走当前修订并复查视图', async () => {
      const posts: unknown[] = [];
      let syncs = 0;
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (input, init) => {
        if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return success(dependencyJob()); }
        if (requestUrl(input).pathname.endsWith('/events')) return success([]);
        if (requestUrl(input).pathname.includes('/jobs/')) return success(dependencyJob());
        return success(dependenciesView({ dependencies: [], ready: true }));
      } });
      await act(async () => { dom.root.render(createElement(PluginDependencies, { client, target: { kind: 'release', id: 'example' }, name: '无依赖插件', onClose() {},
        onUpdated: async (signal) => { assert.equal(signal.aborted, false); ++syncs; } })); });
      await settled(() => dom.document.body.textContent?.includes('此插件没有声明依赖') ?? false, '空态没有展示');
      assert.match(dom.document.body.textContent ?? '', /无需另点依赖安装/);
      assert.equal(dom.button('安装全部缺失必需').disabled, true);
      await act(async () => { dom.button('重新检测').click(); });
      await settled(() => !dom.button('重新检测').disabled, '检测没有结束');
      assert.deepEqual(posts, [{ expected_revision: 'revision-1' }]);
      await settled(() => syncs === 1, '检测后未同步宿主已恢复的安装状态');
      await act(async () => { dom.root.render(null); });
    });

    await t.test('依赖成功后安装同步失败单独可见，不重复依赖写入；关闭撤销安装同步等待', async () => {
      let writes = 0, syncs = 0;
      let syncSignal: AbortSignal | null = null;
      const held = deferred<void>();
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (input, init) => {
        const path = requestUrl(input).pathname;
        if (init?.method === 'POST') { ++writes; return success(dependencyJob()); }
        if (path.endsWith('/events')) return success([]);
        if (path.includes('/jobs/')) return success(dependencyJob());
        return success(dependenciesView({ dependencies: [], ready: true }));
      } });
      const signals: AbortSignal[] = [];
      await act(async () => { dom.root.render(createElement(PluginDependencies, { client,
        target: { kind: 'release', id: 'example' }, name: '同步恢复', onClose() {},
        onUpdated: async (signal) => {
          if (++syncs === 1) throw new Error('目录暂不可读');
          signals.push(signal);
          await held.promise;
        },
      })); });
      await settled(() => !dom.button('重新检测').disabled, '未读取依赖视图');
      await act(async () => { dom.button('重新检测').click(); });
      await settled(() => dom.document.body.textContent?.includes('安装状态同步失败') ?? false, '同步失败未单独报告');
      assert.equal(writes, 1);
      assert.match(dom.document.body.textContent ?? '', /必需依赖已就绪/);
      await act(async () => { dom.button('重新检测').click(); });
      await settled(() => signals.length === 1, '未开始再次同步');
      syncSignal = signals[0] ?? null;
      assert.equal(syncSignal?.aborted, false);
      await act(async () => { dom.root.render(null); });
      assert.equal(syncSignal?.aborted, true);
      await act(async () => { held.resolve(); });
      assert.equal(writes, 2);
    });

    await t.test('可选项只逐项安装，bulk 仅必需，来源和版本可见，失败日志可复制且重试不抹错', async () => {
      const posts: unknown[] = [];
      let failed = true, reads = 0;
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (input, init) => {
        if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return failed ? failure('install_failed') : success(dependencyJob()); }
        if (requestUrl(input).pathname.endsWith('/events')) return success([]);
        if (requestUrl(input).pathname.includes('/jobs/')) return success(dependencyJob());
        return success(dependenciesView({ revision: `r${++reads}`, dependencies: [dependency(), dependency({ id: 'extra', name: '可选工具', required: false,
          status: 'incompatible', source: 'shared', version: '0.9.0', message: '版本过旧' })] }));
      } });
      let copied = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value: string) { copied = value; } } });
      await act(async () => { dom.root.render(createElement(PluginDependencies, { client, target: { kind: 'release', id: 'example' }, name: '依赖示例', onClose() {} })); });
      await settled(() => !dom.button('安装全部缺失必需（1）').disabled, '依赖清单未载入');
      assert.match(dom.document.body.textContent ?? '', /共享工具/);
      assert.match(dom.document.body.textContent ?? '', /0.9.0/);
      await act(async () => { dom.button('安装可选依赖 可选工具').click(); });
      await settled(() => dom.document.body.textContent?.includes('日志 ID：log-error') ?? false, '缺少失败日志 ID');
      await act(async () => { dom.button('复制日志 ID').click(); });
      assert.equal(copied, 'log-error');
      failed = false;
      await act(async () => { dom.button('安装全部缺失必需（1）').click(); });
      await settled(() => !dom.button('重新检测').disabled, '补救安装没有结束');
      assert.deepEqual(posts, [{ expected_revision: 'r1', dependency_ids: ['extra'] }, { expected_revision: 'r2', dependency_ids: ['adb'] }]);
      assert.match(dom.document.body.textContent ?? '', /log-error/);
      await act(async () => { dom.root.render(null); });
    });

    await t.test('browser 组件归并 release 后按 canonical 目标提交；界面不声称管理浏览器电脑', async () => {
      const paths: string[] = [];
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (input, init) => {
        paths.push(requestUrl(input).pathname);
        if (requestUrl(input).pathname.endsWith('/events')) return success([]);
        if (init?.method === 'POST' || requestUrl(input).pathname.includes('/jobs/')) return success(dependencyJob());
        return success(dependenciesView());
      } });
      await act(async () => { dom.root.render(createElement(PluginDependencies, { client, target: { kind: 'browser', id: 'owned' }, name: '浏览器组件', onClose() {} })); });
      await settled(() => !dom.button('重新检测').disabled, 'canonical 没有就绪');
      assert.match(dom.document.body.textContent ?? '', /完整发布统一管理：release \/ example/);
      assert.match(dom.document.body.textContent ?? '', /不操作当前浏览器电脑或已连接设备/);
      await act(async () => { dom.button('重新检测').click(); });
      await settled(() => paths.includes('/api/v2/plugin-dependencies/release/example/scan'), '未按 canonical target 提交');
      await settled(() => !dom.button('重新检测').disabled, 'canonical 检测未结束');
      await act(async () => { dom.root.render(null); });
    });

    await t.test('公开任务事件展示真实阶段和字节进度，任务标识不代替可复制的当前日志 ID', async () => {
      const late = deferred<Response>();
      let polls = 0;
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (input, init) => {
        const path = requestUrl(input).pathname;
        if (init?.method === 'POST') return success(dependencyJob({ status: 'queued' }), 'submit-log');
        if (path.endsWith('/events')) return success([dependencyEvent()], 'event-log');
        if (path.includes('/jobs/')) return ++polls === 1
          ? success(dependencyJob({ status: 'running' }), 'progress-job-log') : late.promise;
        return success(dependenciesView(), 'view-log');
      } });
      let copied = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value: string) { copied = value; } } });
      await act(async () => { dom.root.render(createElement(PluginDependencies, { client,
        target: { kind: 'release', id: 'example' }, name: '真实依赖进度', onClose() {} })); });
      await settled(() => !dom.button('安装全部缺失必需（1）').disabled, '依赖清单未载入');
      await act(async () => { dom.button('安装全部缺失必需（1）').click(); });
      await settled(() => dom.document.body.textContent?.includes('下载依赖 · adb') ?? false, '缺少真实任务阶段');
      const progress = dom.document.querySelector('progress');
      assert.equal(progress?.getAttribute('value'), '25');
      assert.equal(progress?.getAttribute('max'), '100');
      assert.match(dom.document.body.textContent ?? '', /25 \/ 100 字节/);
      assert.match(dom.document.body.textContent ?? '', /dependency-task/);
      await act(async () => { dom.button('复制当前日志 ID').click(); });
      assert.equal(copied, 'progress-job-log');
      await act(async () => { dom.root.render(null); late.resolve(success(dependencyJob())); });
    });

    await t.test('严格模式重新挂载及目标切换取消旧 GET，关闭取消 POST 并拒绝迟到交付', async () => {
      const late = deferred<Response>(), posted = deferred<void>();
      const requests: { path: string; signal: AbortSignal | null }[] = [];
      let posts = 0;
      const client = createApiClient({ baseUrl: 'http://localhost', transport: async (input, init) => {
        const path = requestUrl(input).pathname;
        requests.push({ path, signal: init?.signal ?? null });
        if (path.includes('/server/old')) return late.promise;
        if (init?.method === 'POST') { ++posts; posted.resolve(); return late.promise; }
        return success(dependenciesView({ target: { kind: 'server', id: 'new' } }));
      } });
      async function render(target: DependencyTarget | null) {
        await act(async () => { dom.root.render(createElement(StrictMode, null, createElement(PluginDependencies, { client, target, name: '严格模式', onClose() {} }))); });
      }
      await render({ kind: 'server', id: 'old' });
      await render({ kind: 'server', id: 'new' });
      assert.ok(requests.filter((item) => item.path.includes('/server/old')).every((item) => item.signal?.aborted));
      await settled(() => !dom.button('重新检测').disabled, '重挂载后无法读取');
      await act(async () => { dom.button('重新检测').click(); });
      await posted.promise;
      assert.ok(dom.document.querySelector('progress[aria-label="依赖操作进度"]'));
      await render(null);
      assert.equal(requests.at(-1)?.signal?.aborted, true);
      await act(async () => { late.resolve(success(dependencyJob())); });
      assert.equal(dom.document.querySelector('[role="dialog"]'), null);
      assert.equal(posts, 1);
    });
  } finally { await dom.close(); }
});
