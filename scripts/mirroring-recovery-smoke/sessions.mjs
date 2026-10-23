import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { fixtureState, waitActualMedia } from './fixtures.mjs';
import { sessionSummary } from './evidence.mjs';
import { ledgerSnapshot } from './ledger.mjs';

export function sessionDriver(context) {
  const { host, fixture, report, observer } = context;
  return {
    async open(device = fixture.device) {
      context.stage = '打开并读取本次合成媒体';
      const priorServers = report.tools.filter((entry) => entry.category === 'server' && entry.argv[1] === device).length;
      const opened = await host.client.post('/api/v2/sessions', {
        operation: 'plugin.mirroring.open', input: {
          device_id: device, audio: false, control: false, reconnect_attempts: 0,
          max_size: 1024, max_fps: 30, video_bit_rate: 4000000,
        },
      }, { status: 202 });
      assert.equal(opened.generation, context.generation);
      const entry = { ...sessionSummary(opened), device, prior_servers: priorServers,
        log_id: report.requests.at(-1).log_id };
      report.sessions.push(entry);
      await waitActualMedia(host, fixture, opened.id, device);
      observer.assertHealthy();
      entry.actual_media_observed_at = new Date().toISOString();
      entry.before_cancel = await fixtureState(fixture, device);
      const ledger = await ledgerSnapshot(context);
      assert.ok(ledger.records.some((item) => item.device_id === device && item.remote_identity_recorded),
        '收到媒体前须完成本次资源台账及远端身份落盘');
      return entry;
    },
    async cancel(entry, cleanup) {
      context.stage = '取消并核对实际清理终态';
      entry.expected_cleanup = cleanup;
      await host.client.post(`/api/v2/sessions/${entry.id}/cancel`);
      const finished = await poll(() => host.client.json(`/api/v2/sessions/${entry.id}`),
        (item) => item.status === 'finished', '本次会话取消终态', 15000);
      entry.final = sessionSummary(finished);
      entry.after_cancel = await fixtureState(fixture, entry.device);
      assert.equal(finished.completion.process_exited, true);
      assert.equal(finished.completion.cleanup, cleanup);
      entry.server_exit = await observer.verifyServerExit(entry.device, entry.prior_servers);
      await ledgerSnapshot(context);
      return entry;
    },
    async openDenied(device = fixture.nextDevice) {
      const result = await host.client.call('/api/v2/sessions', {
        method: 'POST', input: { operation: 'plugin.mirroring.open', input: {
          device_id: device, audio: false, control: false, reconnect_attempts: 0,
        } },
      });
      assert.equal(result.status, 409, '未恢复风险时新会话必须被拦截');
      assert.ok(result.body.error && typeof result.body.error.code === 'string');
      return { status: result.status, code: result.body.error.code, log_id: result.logId };
    },
  };
}
