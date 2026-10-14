import assert from 'node:assert/strict';
import {
  startHost,
  stopHost,
  finishOwnHost,
  reservePort,
  assertListenerReleased,
} from '../unified-discovery-smoke/host.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { clientFor } from '../ordinary-deadline-http/client.mjs';

export { reservePort };

export async function prepareHost(options) {
  const host = await startHost({ ...options, ordinal: 1 });
  const startupClient = host.client;
  host.client = clientFor(startupClient.base, options.report);
  let ended = false;
  const release = async () => {
    try {
      await assertListenerReleased(options.port);
      options.report.listener = { port: options.port, host: '127.0.0.1', released: true };
    } catch (error) {
      options.report.listener = {
        port: options.port,
        host: '127.0.0.1',
        released: false,
        error_name: error.name,
        error_code: error.code,
      };
      throw error;
    }
  };
  const verifyExit = () => {
    assert.deepEqual(
      { code: host.child.exitCode, signal: host.child.signalCode },
      { code: 0, signal: null },
    );
    assert.equal(host.entry.forced_direct_child_termination, undefined);
    assert.equal(host.entry.graceful_shutdown, true);
  };
  return {
    ...host,
    ready: async () => {
      await host.ready();
      for (const id of startupClient.logIds) host.client.logIds.add(id);
      assert.deepEqual(await host.client.json('/api/v2/plugins'), []);
      assert.deepEqual(await host.client.json('/api/v2/jobs?limit=100'), []);
    },
    assertRunning: () => {
      assert.equal(host.child.exitCode, null);
      assert.equal(host.child.signalCode, null);
      assert.equal(host.child.pid, host.entry.pid);
    },
    shutdown: async () => {
      await stopHost(host);
      verifyExit();
      await release();
      ended = true;
    },
    finish: async () => {
      if (ended) return;
      let first;
      try {
        await finishOwnHost(host);
        verifyExit();
      } catch (error) {
        first = error;
      }
      try {
        await release();
      } catch (error) {
        first ??= error;
      }
      if (first) throw first;
      ended = true;
    },
    verifyIdentity: async () => {
      const after = await fileIdentity(options.binary);
      assert.equal(after.sha256, host.entry.binary.sha256);
      assert.equal(after.bytes, host.entry.binary.bytes);
      options.report.host_identity_after = after;
    },
  };
}
