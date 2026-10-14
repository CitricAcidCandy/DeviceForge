import assert from 'node:assert/strict';
import {
  startHost,
  stopHost,
  finishOwnHost,
  reservePort,
  assertListenerReleased,
} from '../unified-discovery-smoke/host.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { clientFor } from './client.mjs';

export { reservePort, assertListenerReleased };

// 复用已有空目录宿主与关闭实现，不构建、不添加新生产参数。
export async function prepareHost({ root, binary, directory, report, port }) {
  const host = await startHost({ root, binary, directory, report, port, ordinal: 1 });
  const startupClient = host.client;
  host.client = clientFor(startupClient.base, report);
  return {
    ...host,
    ready: async () => {
      await host.ready();
      for (const id of startupClient.logIds) host.client.logIds.add(id);
      assert.deepEqual(await host.client.json('/api/v2/plugins'), []);
      assert.deepEqual(await host.client.json('/api/v2/plugin-packages/server'), []);
      assert.deepEqual(await host.client.json('/api/v2/jobs?limit=100'), []);
      report.default_without_token = true;
      report.host_start_count = 1;
    },
    assertRunning: () => {
      assert.equal(host.child.pid, host.entry.pid);
      assert.equal(host.child.exitCode, null, '本次宿主不得在长任务期间退出或重启');
      assert.equal(host.child.signalCode, null);
    },
    shutdown: async () => {
      const before = report.requests.length;
      try {
        await stopHost(host);
      } finally {
        report.shutdown_attempts ??= [];
        report.shutdown_attempts.push(
          ...report.requests
            .slice(before)
            .filter((request) => request.path === '/api/v2/system/shutdown'),
        );
      }
      await assertListenerReleased(port);
      report.listener_released = { port, host: '127.0.0.1', released: true };
    },
    finish: async () => {
      const before = report.requests.length;
      try {
        await finishOwnHost(host);
      } finally {
        report.shutdown_attempts ??= [];
        report.shutdown_attempts.push(
          ...report.requests
            .slice(before)
            .filter((request) => request.path === '/api/v2/system/shutdown'),
        );
      }
      await assertListenerReleased(port);
      report.listener_released = { port, host: '127.0.0.1', released: true };
    },
    verifyIdentity: async () => {
      const final = await fileIdentity(binary);
      assert.equal(final.sha256, host.entry.binary.sha256, '验收前后真实宿主字节必须相同');
      report.host_identity_after = final;
    },
  };
}
