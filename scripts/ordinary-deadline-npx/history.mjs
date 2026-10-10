import assert from 'node:assert/strict';
import { sharedJob, jobEvents } from '../ordinary-deadline-http/client.mjs';

// 保存完整基线只用于内存比较；报告不复制任意历史输入或结果。
export async function captureBaseline(client, report) {
  const snapshot = await client.json('/api/v2/jobs?limit=100');
  assert.ok(Array.isArray(snapshot) && snapshot.length <= 91, '基线需为本批8Job留下完整列表空间');
  assert.equal(new Set(snapshot.map((entry) => entry.id)).size, snapshot.length);
  report.baseline = { captured_at: new Date().toISOString(), count: snapshot.length,
    job_ids: snapshot.map((entry) => entry.id), limit: 100 };
  return new Map(snapshot.map((entry) => [entry.id, entry]));
}

export async function verifyAddedHistory(host, baseline, report) {
  assert.equal(report.jobs.length, 8);
  const newIds = new Set(report.jobs.map((entry) => entry.job_id));
  assert.equal(newIds.size, 8);
  assert.ok([...newIds].every((id) => !baseline.has(id)));
  const history = await host.client.json('/api/v2/jobs?limit=100');
  assert.equal(history.length, baseline.size + 8, '只核对基线后的新增8Job，不能要求整库总8Job');
  const additions = history.filter((job) => !baseline.has(job.id));
  assert.deepEqual(additions.map((job) => job.id).sort(), [...newIds].sort());
  for (const [id, original] of baseline) {
    assert.deepEqual(history.find((job) => job.id === id), original, '本批执行不得修改已有历史Job');
  }
  for (const entry of report.jobs) {
    const current = await sharedJob(host.client, entry);
    assert.equal(current.status, entry.expected_status);
    assert.deepEqual(current, additions.find((job) => job.id === entry.job_id));
    assert.deepEqual(await jobEvents(host.client, entry), entry.job_events);
  }
  report.history = { baseline_count: baseline.size, added_count: additions.length,
    added_job_ids: [...newIds], baseline_unchanged: true, http_mcp_same_jobs: true,
    terminal_events_per_new_job: 1 };
}
