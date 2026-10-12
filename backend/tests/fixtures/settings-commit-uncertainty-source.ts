// 合成旧配置服务：先提交内存状态，再断开或保留响应；只记录摘要和事件次序。
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { hash, object, poll, portReleased } from './six-business-support.ts';

export type CommitMode = 'disconnect' | 'hold';
export type CommitEvidence = {
  scenario: string;
  ordinal: number;
  committed: boolean;
  commit_sequence: number;
  input_bytes: number;
  input_sha256: string;
  state_sha256: string;
  response_withheld: boolean;
  disconnect_initiated_by_source: boolean;
  response_closed: boolean;
  close_sequence: number | null;
  cancellation_sequence: number | null;
};

export async function commitSource() {
  let sequence = 0;
  let state: unknown = null;
  let plan: { scenario: string; mode: CommitMode; expected: unknown } | undefined;
  let held: ServerResponse | undefined;
  const writes: CommitEvidence[] = [];
  const reads: { scenario: string; state_sha256: string; sequence: number }[] = [];
  const faults: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.ok(plan, '夹具尚未配置情景');
      if (request.url === '/get_config/deviceInfo' && request.method === 'GET') {
        reads.push({ scenario: plan.scenario, state_sha256: hash(JSON.stringify(state)), sequence: ++sequence });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 200, data: { success: true, data: state } }));
        return;
      }
      assert.equal(request.url, '/update_config/deviceInfo', '夹具拒绝其他路径');
      assert.equal(request.method, 'POST', '夹具拒绝其他方法');
      const parts: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length; assert.ok(size <= 4096, '合成请求超限'); parts.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(parts);
      const next: unknown = JSON.parse(bytes.toString('utf8'));
      assert.deepEqual(next, plan.expected, '夹具只接受预先登记的合成配置');
      // 提交与发布门闩在同一回调内有明确次序，响应不会在门闩后自行放行。
      state = next;
      const evidence: CommitEvidence = {
        scenario: plan.scenario, ordinal: writes.filter((write) => write.scenario === plan!.scenario).length + 1,
        committed: true, commit_sequence: ++sequence, input_bytes: size, input_sha256: hash(bytes),
        state_sha256: hash(JSON.stringify(state)), response_withheld: true,
        disconnect_initiated_by_source: plan.mode === 'disconnect', response_closed: false, close_sequence: null,
        cancellation_sequence: null,
      };
      response.once('close', () => {
        evidence.response_closed = true; evidence.close_sequence = ++sequence;
        if (held === response) held = undefined;
      });
      writes.push(evidence);
      if (plan.mode === 'disconnect') response.destroy();
      else held = response;
    })().catch(() => { faults.push('合成服务请求资格或处理失败'); response.destroy(); });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base, writes, reads, faults,
    arm(scenario: string, mode: CommitMode, expected: unknown) {
      assert.equal(held, undefined, '上一情景仍有在途响应');
      assert.equal(writes.some((write) => write.scenario === scenario), false, '情景身份必须独立');
      plan = { scenario, mode, expected }; state = null;
    },
    async committed(scenario: string) {
      return poll(async () => writes.find((write) => write.scenario === scenario),
        (write) => write?.committed === true, '合成远端写入完成门闩').then((write) => {
          assert.ok(write); return { ...write };
        });
    },
    async closed(scenario: string) {
      await poll(async () => writes.find((write) => write.scenario === scenario)?.response_closed === true,
        Boolean, '远端在途响应连接关闭');
    },
    markCancellation(scenario: string) {
      const evidence = writes.find((write) => write.scenario === scenario);
      assert.ok(evidence?.committed, '取消前必须有实际提交');
      assert.equal(evidence.response_closed, false, '取消前响应连接必须仍在途');
      assert.equal(evidence.disconnect_initiated_by_source, false);
      evidence.cancellation_sequence = ++sequence; return evidence.cancellation_sequence;
    },
    async readBack() {
      const response = await fetch(`${base}/get_config/deviceInfo`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); const envelope = object(await response.json());
      assert.equal(envelope.status, 200); const data = object(envelope.data); assert.equal(data.success, true);
      return data.data;
    },
    snapshot(scenario: string) {
      return { writes: writes.filter((write) => write.scenario === scenario).map((write) => ({ ...write })),
        reads: reads.filter((read) => read.scenario === scenario).map((read) => ({ ...read })) };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
      return { port_released: await portReleased(address.port), faults: faults.length };
    },
  };
}
export type CommitSource = Awaited<ReturnType<typeof commitSource>>;
