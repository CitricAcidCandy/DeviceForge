import assert from 'node:assert/strict';
import { observations } from './fixtures.mjs';

const toolsOf = (entry) => entry.tools ?? (entry.tool ? [entry.tool] : []);

export async function verifyInventory(fixture, report) {
  assert.equal(report.application_matrix.length, 25, 'HD-MATRIX-APPLICATIONS');
  assert.equal(report.application_matrix.filter(item => item.automatic).length, 7, 'HD-MATRIX-AUTO-START');
  assert.equal(report.application_lock_jobs.length, 4, 'HD-MATRIX-APPLICATION-LOCK');
  assert.equal(report.application_cancel_jobs.length, 4, 'HD-MATRIX-APPLICATION-CANCEL');
  assert.equal(report.application_failure_jobs.length, 3, 'HD-MATRIX-APPLICATION-FAILURES');
  assert.equal(report.application_detail_matrix.length, 6, 'HD-MATRIX-DETAILS');
  assert.equal(report.application_detail_failure_jobs.length, 9, 'HD-MATRIX-DETAIL-FAILURES');
  assert.equal(report.application_detail_resource_jobs.length, 2, 'HD-MATRIX-DETAIL-RESOURCES');
  assert.ok(report.reloaded_detail_job);
  assert.ok(report.application_unload_job && report.reloaded_application_job);
  assert.equal(report.network_matrix.length, 18, 'HD-MATRIX-NETWORK');
  assert.equal(report.network_semantic_jobs.length, 24, 'HD-MATRIX-NETWORK-SEMANTIC');
  assert.equal(report.network_failure_jobs.length, 12, 'HD-MATRIX-NETWORK-FAILURES');
  assert.equal(report.network_lock_jobs.length, 7, 'HD-MATRIX-NETWORK-LOCKS');
  assert.equal(report.network_cancel_jobs.length, 2, 'HD-MATRIX-NETWORK-CANCEL');
  assert.equal(report.network_schema_requests, 128, 'HD-MATRIX-NETWORK-SCHEMA');
  assert.ok(report.network_unload_job && report.reloaded_network_job);
  assert.equal(new Set(Object.values(report.generations)).size, 4, 'HD-MATRIX-FOUR-GENERATIONS');
  const groups = [
    { name: '应用三动作与新代自动启动', ids: report.application_matrix.map(item => item.job_id), expected_jobs: 25, expected_tools: 32 },
    { name: '应用同设备写锁与不同设备并行', ids: report.application_lock_jobs, expected_jobs: 4, expected_tools: 4 },
    { name: '应用取消含自动详情阶段', ids: report.application_cancel_jobs, expected_jobs: 4, expected_tools: 4 },
    { name: '应用在途卸载', ids: [report.application_unload_job], expected_jobs: 1, expected_tools: 1 },
    { name: '应用工具结果精确失败', ids: report.application_failure_jobs, expected_jobs: 3, expected_tools: 3 },
    { name: '应用详情完整成功矩阵', ids: report.application_detail_matrix.map(item => item.job_id), expected_jobs: 6, expected_tools: 6 },
    { name: '应用详情解析精确失败', ids: report.application_detail_failure_jobs, expected_jobs: 9, expected_tools: 9 },
    { name: '应用详情同设备读取资源', ids: report.application_detail_resource_jobs, expected_jobs: 2, expected_tools: 2 },
    { name: '应用详情换代重载', ids: [report.reloaded_detail_job], expected_jobs: 1, expected_tools: 1 },
    { name: '无发现网络三入口双协议成功', ids: report.network_matrix.map(item => item.job_id), expected_jobs: 18, expected_tools: 18 },
    { name: '网络语义地址资格失败', ids: report.network_semantic_jobs, expected_jobs: 24, expected_tools: 0 },
    { name: '网络工具结果精确失败', ids: report.network_failure_jobs, expected_jobs: 12, expected_tools: 12 },
    { name: '提供者与设备双向屏障', ids: report.network_lock_jobs, expected_jobs: 7, expected_tools: 7 },
    { name: '连接与断开在途取消', ids: report.network_cancel_jobs, expected_jobs: 2, expected_tools: 2 },
    { name: '提供者连接在途卸载', ids: [report.network_unload_job], expected_jobs: 1, expected_tools: 1 },
    { name: '新代无发现目录断开', ids: [report.reloaded_network_job], expected_jobs: 1, expected_tools: 1 },
  ];
  const owned = groups.flatMap(group => group.ids);
  assert.equal(new Set(owned).size, owned.length, 'HD-MATRIX-UNIQUE-GROUP-JOBS');
  groups.push({ name: '原四核心贡献完整矩阵', ids: report.jobs.filter(entry => !owned.includes(entry.job_id)).map(entry => entry.job_id), expected_jobs: 28, expected_tools: 27 });
  report.inventory = [];
  for (const group of groups) {
    const jobs = report.jobs.filter(entry => group.ids.includes(entry.job_id));
    assert.equal(jobs.length, group.expected_jobs, 'HD-GROUP-JOBS:' + group.name);
    const tools = jobs.flatMap(toolsOf); assert.equal(tools.length, group.expected_tools, 'HD-GROUP-TOOLS:' + group.name);
    report.inventory.push({ ...group, actual_jobs: jobs.length, actual_tools: tools.length });
  }
  const mapped = report.jobs.flatMap(toolsOf), observed = await observations(fixture);
  assert.equal(new Set(mapped.map(item => item.directory)).size, mapped.length, 'HD-UNIQUE-TOOL-CALLS');
  assert.deepEqual(mapped.map(item => item.directory).sort(), observed.map(item => item.directory).sort(), 'HD-ALL-TOOL-CALLS-ACCOUNTED');
  assert.equal(new Set(report.jobs.map(entry => entry.job_id)).size, report.jobs.length, 'HD-UNIQUE-JOBS');
  assert.equal(report.jobs.length, groups.reduce((total, group) => total + group.expected_jobs, 0));
  report.total_jobs = report.jobs.length; report.total_tool_calls = mapped.length;
  assert.equal(report.total_jobs, 148, 'HD-MATRIX-TOTAL-JOBS'); assert.equal(report.total_tool_calls, 130, 'HD-MATRIX-TOTAL-TOOLS');
  report.job_status_inventory = Object.fromEntries(['succeeded', 'failed', 'cancelled'].map(status => [status, report.jobs.filter(entry => entry.history.status === status).length]));
  assert.deepEqual(report.job_status_inventory, { succeeded: 87, failed: 50, cancelled: 11 }, 'HD-MATRIX-JOB-STATUSES');
  report.checks.push({ name: '逐矩阵Job与实际HDC库存完整且唯一，自动启动分别计两个工具调用', passed: true,
    jobs: report.total_jobs, tools: report.total_tool_calls });
}
