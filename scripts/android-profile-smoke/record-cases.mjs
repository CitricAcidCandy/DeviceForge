import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { deviceId } from './probe-route.mjs';
import { packageName } from './protocol.mjs';
import { setMode } from './fixtures.mjs';
import { consume } from './record-results.mjs';

const operation = 'plugin.android-device.profile.record';
async function submit(host, report, scenario, transport) {
  const input = {
    device_id: deviceId,
    input: {
      package: packageName,
      duration_ms: 1000,
      interval_ms: 1000,
      capture_frames: scenario.capture_frames ?? false,
    },
  };
  const submitted =
    transport === 'mcp'
      ? await host.client.tool(operation, input)
      : await host.client.post('/api/v2/jobs', { operation, input }, { status: 202 });
  const entry = {
    case_id: scenario.id,
    job_id: submitted.id,
    operation,
    transport,
    submit_log_id: report.last_request.log_id,
    expected_end_code: scenario.kind === 'failed' ? 'cleanup_failed' : undefined,
    expected_status: ['cancel', 'unload'].includes(scenario.kind)
      ? 'cancelled'
      : scenario.kind === 'failed'
        ? 'failed'
        : 'succeeded',
    plugin_call_required: true,
  };
  report.jobs.push(entry);
  return entry;
}
async function waitJob(host, observer, entry) {
  const job = await poll(
    async () => {
      observer.assertHealthy();
      return host.client.job(entry.job_id);
    },
    (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status),
    'Root录制公开共享Job',
    30000,
  );
  assert.equal(job.status, entry.expected_status, 'PROFILE-RECORD-EXPECTED-JOB');
  assert.deepEqual(
    await host.client.tool('deviceforge.get_job', { id: job.id }),
    job,
    'PROFILE-RECORD-HTTP-MCP-HISTORY',
  );
  return job;
}
export async function recordBusiness(host, fixture, observer, loaded, report, directory, frontend) {
  await host.client.post('/api/v2/device-providers/android-device/refresh', {
    generation: loaded.generation,
  });
  assert.ok((await host.client.tools()).includes(operation), 'PROFILE-RECORD-DYNAMIC-LOADED');
  const downloads = join(directory, 'downloads');
  await mkdir(downloads);
  for (const [index, scenario] of fixture.cases
    .filter((value) => value.kind === 'record')
    .entries()) {
    await setMode(fixture, scenario.id);
    const baseline = report.tools.length;
    const entry = await submit(host, report, scenario, index % 2 ? 'mcp' : 'http');
    const job = await waitJob(host, observer, entry);
    assert.equal(job.error, null);
    const tools = report.tools.slice(baseline);
    assert.ok(
      tools.length > 0 && tools.every((value) => value.mode === scenario.id),
      'PROFILE-RECORD-TOOL-MODE',
    );
    const cleanup = tools.filter((value) => value.category === 'remote-cleanup');
    assert.equal(
      cleanup.length,
      scenario.expected.stack_status === 'captured' ? 1 : 0,
      'PROFILE-RECORD-CLEANUP-COUNT',
    );
    if (scenario.capture_frames) await mediaClean(fixture, observer, report, baseline, scenario);
    Object.assign(entry, {
      history: job,
      tools: tools.map((value) => value.name),
      source_generation: loaded.generation,
    });
    await consume(host, downloads, report, scenario, job.result, frontend);
    report.history.push(job);
    report.checks.push({
      name: scenario.id + '真实指标/官方报告晚表和原下载SHA/前端归档消费',
      passed: true,
    });
  }
  for (const scenario of fixture.cases.filter((value) => value.kind === 'failed')) {
    await setMode(fixture, scenario.id);
    const baseline = report.tools.length;
    const entry = await submit(host, report, scenario, 'http');
    const job = await waitJob(host, observer, entry);
    assert.equal(job.result, null);
    assert.ok(job.error);
    await mediaClean(fixture, observer, report, baseline, scenario);
    Object.assign(entry, {
      history: job,
      tools: report.tools.slice(baseline).map((value) => value.name),
    });
    report.history.push(job);
    report.checks.push({ name: scenario.id + '公开Job清理失败且未删除别人的转发', passed: true });
  }
  if (!fixture.cases.some((value) => value.kind === 'cancel')) {
    if (fixture.cases.some((value) => value.kind === 'failed')) {
      await host.client.post('/api/v2/plugins/android-device/unload', undefined, {
        status: 409,
        code: 'cleanup_failed',
      });
      report.checks.push({
        name: '未确认媒体转发清理保留cleanup_failed隔离，普通卸载返回409',
        passed: true,
      });
    } else
      assert.equal(
        (await host.client.post('/api/v2/plugins/android-device/unload')).state,
        'unloaded',
      );
    for (const previous of report.history) {
      assert.deepEqual(
        await host.client.job(previous.id),
        previous,
        'PROFILE-FALLBACK-STABLE-HTTP-HISTORY',
      );
      assert.deepEqual(
        await host.client.tool('deviceforge.get_job', { id: previous.id }),
        previous,
        'PROFILE-FALLBACK-STABLE-MCP-HISTORY',
      );
    }
    const archiveStates = (report.profiles ?? []).map((profile) => ({
      case_id: profile.case_id,
      root_access: profile.result.root_access,
      stack_status: profile.result.stack_status,
      frame_status: profile.result.frame_status,
      frame_count: profile.result.frame_count,
      metric_missing: profile.index.samples[0].metrics.metric_missing ?? null,
    }));
    report.checks.push({
      name: '录制归档的指标、调用栈和画面实际状态与HTTP/MCP卸载历史一致',
      archive_states: archiveStates,
      passed: true,
    });
    return;
  }
  for (const scenario of fixture.cases.filter((value) =>
    ['cancel', 'unload'].includes(value.kind),
  )) {
    await setMode(fixture, scenario.id);
    const baseline = report.tools.length;
    observer.holdNext(scenario.hold_category);
    const entry = await submit(host, report, scenario, 'mcp');
    const held = await poll(
      () => {
        observer.assertHealthy();
        return report.tools.slice(baseline).find((value) => value.held);
      },
      Boolean,
      '原远端阶段在途ADB句柄',
      20000,
    );
    if (scenario.kind === 'cancel')
      await host.client.post('/api/v2/jobs/' + entry.job_id + '/cancel');
    else {
      assert.equal(
        (await host.client.tool('deviceforge.unload_plugin', { id: 'android-device' })).state,
        'unloaded',
      );
      assert.ok(!(await host.client.tools()).includes(operation), 'PROFILE-RECORD-UNLOADED-MCP');
    }
    const job = await waitJob(host, observer, entry);
    assert.equal(job.result, null, 'PROFILE-CANCEL-NO-PARTIAL-ARTIFACTS');
    // 取消Job终态可先于远端cleanup收口；等待实际固定清理回执，不按端点终态猜资源完成。
    await poll(
      async () => {
        observer.assertHealthy();
        const cleanups = report.tools
          .slice(baseline)
          .filter((value) => value.category === 'remote-cleanup');
        if (cleanups.length !== 1) return false;
        try {
          const receipt = await readFile(join(cleanups[0].directory, 'stdout.bin'));
          // 固定成功回执只接受LF或完整CRLF，不trim或忽略额外内容。
          return (
            (receipt.equals(Buffer.from('clean\n')) || receipt.equals(Buffer.from('clean\r\n'))) &&
            (await readFile(join(cleanups[0].directory, 'completed'), 'utf8')) === '1'
          );
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      },
      Boolean,
      '远端固定清理实际回执',
      5000,
    );
    const tools = report.tools.slice(baseline);
    assert.equal(
      tools.filter((value) => value.category === 'remote-cleanup').length,
      1,
      'PROFILE-CANCEL-REMOTE-CLEANUP',
    );
    if (scenario.capture_frames) await mediaClean(fixture, observer, report, baseline, scenario);
    Object.assign(entry, {
      history: job,
      tools: tools.map((value) => value.name),
      held_tool: held.name,
      source_generation: loaded.generation,
    });
    report.history.push(job);
    report.checks.push({
      name: scenario.id + '在途取消/卸载、远端固定身份清理与无半产物',
      passed: true,
    });
  }
  const reloaded = await host.client.post('/api/v2/plugins/android-device/load');
  assert.notEqual(reloaded.generation, loaded.generation);
  assert.ok((await host.client.tools()).includes(operation), 'PROFILE-RECORD-NEW-GENERATION-MCP');
  await host.client.post('/api/v2/device-providers/android-device/refresh', {
    generation: reloaded.generation,
  });
  const scenario = fixture.cases.find((value) => value.kind === 'reloaded');
  await setMode(fixture, scenario.id);
  const baseline = report.tools.length;
  const entry = await submit(host, report, scenario, 'http'),
    job = await waitJob(host, observer, entry);
  assert.equal(job.error, null);
  if (scenario.capture_frames) await mediaClean(fixture, observer, report, baseline, scenario);
  Object.assign(entry, { history: job, source_generation: reloaded.generation });
  await consume(host, downloads, report, scenario, job.result, frontend);
  report.history.push(job);
  assert.equal((await host.client.post('/api/v2/plugins/android-device/unload')).state, 'unloaded');
  for (const previous of report.history) {
    assert.deepEqual(
      await host.client.job(previous.id),
      previous,
      'PROFILE-RECORD-STABLE-HTTP-HISTORY',
    );
    assert.deepEqual(
      await host.client.tool('deviceforge.get_job', { id: previous.id }),
      previous,
      'PROFILE-RECORD-STABLE-MCP-HISTORY',
    );
  }
  report.lifecycle = { old_generation: loaded.generation, new_generation: reloaded.generation };
  report.checks.push({ name: '新代Root录制产物与旧Job/原下载历史不改写', passed: true });
}

async function mediaClean(fixture, observer, report, baseline, scenario) {
  const wanted = 2;
  const cleanupCount = scenario.foreign_forward ? 2 : 1;
  await poll(
    async () => {
      observer.assertHealthy();
      const tools = report.tools.slice(baseline);
      const cleanups = tools.filter((value) => value.category === 'media-cleanup');
      const lists = tools.filter((value) => value.category === 'media-forward-list');
      if (cleanups.length !== cleanupCount || lists.length !== wanted) return false;
      try {
        for (const cleanup of cleanups)
          assert.deepEqual(
            await readFile(join(cleanup.directory, 'stdout.bin')),
            Buffer.from('DFPC_VIDEO_CLEAN\n'),
            'PROFILE-MEDIA-ALL-CLEANUP-RECEIPTS',
          );
        return (await readFile(join(lists.at(-1).directory, 'completed'), 'utf8')) === '1';
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    Boolean,
    '媒体固定所有权清理原回执',
    5000,
  );
  const tools = report.tools.slice(baseline),
    removed = tools.filter((value) => value.category === 'media-forward-remove');
  assert.equal(
    removed.length,
    scenario.foreign_forward ? 0 : 1,
    'PROFILE-MEDIA-FORWARD-OWNED-REMOVE',
  );
  const server = tools.find((value) => value.category === 'media-server');
  assert.ok(server, 'PROFILE-MEDIA-ORIGINAL-SERVER');
  const bytes = await readFile(join(fixture.root, 'inputs', scenario.id, 'media.bin'));
  assert.deepEqual(
    await readFile(join(server.directory, 'media.sent.bin')),
    bytes,
    'PROFILE-MEDIA-ORIGINAL-TCP-BYTES',
  );
  report.media_checks ??= [];
  report.media_checks.push({
    case_id: scenario.id,
    server_call: server.name,
    cleanup_calls: tools
      .filter((value) => value.category.startsWith('media-'))
      .map((value) => value.name),
    foreign_forward_preserved: scenario.foreign_forward,
  });
}
