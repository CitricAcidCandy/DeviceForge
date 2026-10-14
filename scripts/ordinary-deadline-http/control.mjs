import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { elapsedMs, monotonicNs, waitFor } from './wait.mjs';

export const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const casePattern = /^[A-Za-z0-9_-]{1,80}$/;

export function within(parent, child) {
  const result = relative(resolve(parent), resolve(child));
  assert.ok(
    result && !result.startsWith('..') && !isAbsolute(result),
    '控制路径必须属于本次根目录',
  );
}

function marker(item, caseId, suffix) {
  assert.match(caseId, casePattern);
  const path = join(item.controlRoot, `${caseId}.${suffix}`);
  within(item.controlRoot, path);
  return path;
}

async function readBounded(path, maximum = 256 * 1024) {
  const metadata = await stat(path);
  assert.ok(metadata.isFile() && metadata.size <= maximum, '控制文件读取量必须有界');
  return readFile(path, 'utf8');
}

export function validateIdentity(item, entry, value) {
  assert.equal(value.run_id, item.runId);
  assert.equal(value.case_id, entry.case_id);
  assert.equal(value.plugin_id, item.pluginId);
  assert.equal(value.protocol_version, item.protocolVersion);
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  assert.match(value.request_id, uuid);
  const prefix = `plugin.${item.pluginId}.`;
  assert.ok(entry.operation.startsWith(prefix));
  assert.equal(value.request_operation, entry.operation.slice(prefix.length));
  if (entry.process) {
    assert.equal(value.pid, entry.process.pid);
    assert.equal(value.request_id, entry.process.request_id);
    assert.equal(value.ready_monotonic_ns, entry.process.ready_monotonic_ns);
  }
}

export async function events(item, entry, { complete: requireComplete = false } = {}) {
  try {
    const text = await readBounded(marker(item, entry.case_id, 'events.jsonl'));
    // 活跃写入时只读取完整行；退出后再要求尾行完整。
    if (requireComplete) assert.ok(text.endsWith('\n'), '实际 PID 退出后控制事件不得有残缺尾行');
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    const parsed = complete.split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(parsed.length <= 64, '单次夹具控制事件数量必须有界');
    let previous = 0n;
    for (const event of parsed) {
      validateIdentity(item, entry, event);
      assert.ok(
        [
          'ready',
          'cancel_received',
          'response_written',
          'cleaned',
          'stdin_eof',
          'process_exit',
        ].includes(event.event),
      );
      assert.match(event.monotonic_ns, /^\d+$/);
      assert.ok(BigInt(event.monotonic_ns) >= previous, '控制事件单调时钟不得回退');
      previous = BigInt(event.monotonic_ns);
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function ready(item, entry, timeoutMs) {
  const value = await waitFor(
    async () => {
      try {
        return JSON.parse(await readBounded(marker(item, entry.case_id, 'ready.json')));
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    Boolean,
    `${entry.case_id} 实际 ready`,
    timeoutMs,
  );
  validateIdentity(item, entry, value);
  assert.match(value.ready_monotonic_ns, /^\d+$/);
  entry.process = { ...value };
  entry.driver_ready_observed_ns = monotonicNs();
  entry.ready_observed_at = new Date().toISOString();
  return value;
}

export async function release(item, entry) {
  entry.driver_release_started_ns = monotonicNs();
  await writeFile(marker(item, entry.case_id, 'release'), '1', { encoding: 'utf8', flag: 'wx' });
  entry.driver_release_written_ns = monotonicNs();
  entry.driver_hold_ms = elapsedMs(entry.driver_ready_observed_ns, entry.driver_release_started_ns);
}

export async function diagnostic(item, entry) {
  try {
    const value = JSON.parse(await readBounded(marker(item, entry.case_id, 'diagnostic.json')));
    validateIdentity(item, entry, value);
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function processVisible(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export async function processExited(item, entry, timeoutMs = 2000) {
  const started = performance.now();
  await waitFor(
    () => processVisible(entry.process.pid),
    (visible) => !visible,
    `${entry.case_id} 本次直接 PID 退出`,
    timeoutMs,
  );
  entry.pid_exit = {
    pid: entry.process.pid,
    visible: false,
    observed_at: new Date().toISOString(),
    elapsed_ms: performance.now() - started,
    method: 'signal_0_existence_check',
    os_exit_code: null,
  };
  entry.events = await events(item, entry, { complete: true });
  return entry.events;
}
