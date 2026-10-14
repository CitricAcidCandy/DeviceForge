import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { csvHeaders, csvRows, mainHeaders, mainRows, pageHeaders, pageRows } from './fixtures.mjs';
const operation = (name) => 'plugin.spreadsheet.' + name;
export async function recorded(host, report, submitted, submitLogId, status = 'succeeded') {
  const job = await poll(
    () => host.client.job(submitted.id),
    (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status),
    '表格任务终态',
    35000,
  );
  report.jobs.push({
    id: job.id,
    operation: job.operation,
    expected_status: status,
    submit_log_id: submitLogId,
  });
  assert.equal(job.status, status, 'SS-JOB-EXPECTED-TERMINAL');
  assert.deepEqual(await host.client.tool('deviceforge.get_job', { id: job.id }), job);
  if (status === 'failed') {
    assert.equal(job.result, null);
    assert.ok(typeof job.error === 'string' && job.error.length > 0);
  }
  return job;
}
async function submit(host, report, name, input, transport = 'http', status = 'succeeded') {
  const submitted =
    transport === 'mcp'
      ? await host.client.tool(operation(name), input)
      : await host.client.post(
          '/api/v2/jobs',
          { operation: operation(name), input },
          { status: 202 },
        );
  const logId = report.last_request.log_id;
  const job = await recorded(host, report, submitted, logId, status);
  return { job, logId, value: status === 'succeeded' ? job.result.result : undefined };
}
function inspection(metadata, sheets, format) {
  return {
    format_version: 1,
    artifact_id: metadata.id,
    source_filename: metadata.filename,
    format,
    sheets: sheets.map((name, index) => ({ name, index })),
  };
}
function page(base, sheetName, headers, rows, offset = 0, limit = 100) {
  return {
    ...base,
    sheet_name: sheetName,
    headers,
    rows: rows.slice(offset, offset + limit),
    total_rows: rows.length,
    offset,
    limit,
  };
}
async function rejection(host, name, input, transport) {
  if (transport === 'http') {
    const reply = await host.client.call('/api/v2/jobs', {
      method: 'POST',
      body: JSON.stringify({ operation: operation(name), input }),
    });
    assert.equal(reply.status, 400);
    assert.ok(reply.body.error?.code);
    return;
  }
  const reply = await host.client.call('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: host.client.base,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 901,
      method: 'tools/call',
      params: { name: operation(name), arguments: input },
    }),
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.id, 901);
  assert.equal(reply.body.result.isError, true);
  assert.ok(reply.body.result.structuredContent?.code);
  assert.equal(reply.body.result._meta['deviceforge/log_id'], reply.logId);
}
export async function business(host, report, frontend, artifacts, loaded) {
  const signal = () => AbortSignal.timeout(35000);
  assert.deepEqual(
    (await frontend.refreshOperations(signal())).data.map((value) => value.id).sort(),
    [operation('inspect'), operation('read')],
  );
  const xlsx = artifacts['中文多表.XLSX'],
    base = inspection(xlsx, ['中文数据', '分页', '空表'], 'xlsx');
  const inspected = await frontend.inspect({ artifact_id: xlsx.id }, signal());
  assert.deepEqual(inspected.data, base);
  await recorded(host, report, inspected.job, inspected.submitLogId);
  const read = await frontend.read({ artifact_id: xlsx.id }, signal());
  const expected = page(base, '中文数据', mainHeaders, mainRows);
  assert.deepEqual(read.data, expected);
  await recorded(host, report, read.job, read.submitLogId);
  report.checks.push({
    name: '实际前端inspect/read、多工作表中文与表头预留冲突、0/false/null和空行过滤',
    passed: true,
  });
  const mcpInspect = await submit(host, report, 'inspect', { artifact_id: xlsx.id }, 'mcp');
  assert.deepEqual(mcpInspect.value, base);
  const mcpRead = await submit(host, report, 'read', { artifact_id: xlsx.id }, 'mcp');
  assert.deepEqual(mcpRead.value, read.data);
  for (const [sheet, transport] of [
    ['分页', 'http'],
    [1, 'mcp'],
  ]) {
    const result = await submit(
      host,
      report,
      'read',
      { artifact_id: xlsx.id, sheet, offset: 1, limit: 2 },
      transport,
    );
    assert.deepEqual(result.value, page(base, '分页', pageHeaders, pageRows, 1, 2));
  }
  assert.deepEqual(
    (
      await submit(host, report, 'read', {
        artifact_id: xlsx.id,
        sheet: '分页',
        offset: 10000,
        limit: 500,
      })
    ).value,
    page(base, '分页', pageHeaders, pageRows, 10000, 500),
  );
  assert.deepEqual(
    (await submit(host, report, 'read', { artifact_id: xlsx.id, sheet: '空表' }, 'mcp')).value,
    page(base, '空表', [], []),
  );
  report.checks.push({
    name: 'HTTP/MCP同原文Job、明确表名与索引、准确分页/越界空页和空工作表',
    passed: true,
  });
  const csv = artifacts['引号与空行.CSV'],
    csvBase = inspection(csv, ['CSV'], 'csv');
  assert.deepEqual(
    (await submit(host, report, 'inspect', { artifact_id: csv.id }, 'mcp')).value,
    csvBase,
  );
  assert.deepEqual(
    (await submit(host, report, 'read', { artifact_id: csv.id, sheet: 'CSV' })).value,
    page(csvBase, 'CSV', csvHeaders, csvRows),
  );
  report.checks.push({
    name: '真实UTF8 BOM CSV中文/转义引号/逗号/换行、空字段null、0/false字符串及空行',
    passed: true,
  });
  for (const sheet of ['不存在', ' 分页 ', 3])
    await submit(host, report, 'read', { artifact_id: xlsx.id, sheet }, 'http', 'failed');
  const beforeInvalid = (await host.client.json('/api/v2/jobs?limit=100')).length;
  const invalid = [
    { sheet: null },
    { sheet: '' },
    { sheet: -1 },
    { offset: -1 },
    { offset: 10001 },
    { limit: 0 },
    { limit: 501 },
    { limit: 1.5 },
  ];
  for (const [index, input] of invalid.entries())
    await rejection(host, 'read', { artifact_id: xlsx.id, ...input }, index % 2 ? 'mcp' : 'http');
  assert.equal((await host.client.json('/api/v2/jobs?limit=100')).length, beforeInvalid);
  report.checks.push({
    name: '精确sheet无fallback，HTTP/MCP非法参数拒绝且无新增Job',
    passed: true,
  });
  for (const name of [
    '损坏工作表.xlsx',
    '坐标膨胀.xlsx',
    '单元格超限.csv',
    '表头超限.csv',
    '行数超限.csv',
    '输出超限.csv',
  ]) {
    const input = {
      artifact_id: artifacts[name].id,
      ...(name === '输出超限.csv' ? { limit: 500 } : {}),
    };
    await submit(host, report, 'read', input, name.endsWith('.xlsx') ? 'mcp' : 'http', 'failed');
  }
  report.checks.push({
    name: '损坏工作表/坐标膨胀与cell/header/row/JSON输出限额真实Job失败',
    passed: true,
  });
  const unloaded = await host.client.tool('deviceforge.unload_plugin', { id: 'spreadsheet' });
  assert.equal(unloaded.state, 'unloaded');
  assert.ok(!(await host.client.tools()).some((value) => value.startsWith('plugin.spreadsheet.')));
  assert.deepEqual((await frontend.refreshOperations(signal())).data, []);
  assert.throws(
    () => frontend.read({ artifact_id: xlsx.id }, signal()),
    (error) => typeof error.code === 'string',
  );
  const beforeHistory = (await host.client.json('/api/v2/jobs?limit=100')).length;
  const ticket = {
    id: mcpRead.job.id,
    operation: mcpRead.job.operation,
    submitLogId: mcpRead.logId,
  };
  const resumed = await frontend.resumeRead(ticket, { artifact_id: xlsx.id }, signal());
  assert.deepEqual(resumed.data, expected);
  assert.equal(resumed.submitLogId, mcpRead.logId);
  assert.equal((await host.client.json('/api/v2/jobs?limit=100')).length, beforeHistory);
  assert.deepEqual(
    await host.client.tool('deviceforge.get_job', { id: mcpRead.job.id }),
    mcpRead.job,
  );
  const reloaded = await host.client.post('/api/v2/plugins/spreadsheet/load');
  assert.equal(reloaded.state, 'loaded');
  assert.notEqual(reloaded.generation, loaded.generation);
  await frontend.refreshOperations(signal());
  const newPage = await frontend.read(
    { artifact_id: xlsx.id, sheet: 1, offset: 4, limit: 1 },
    signal(),
  );
  assert.deepEqual(newPage.data, page(base, '分页', pageHeaders, pageRows, 4, 1));
  await recorded(host, report, newPage.job, newPage.submitLogId);
  assert.equal((await host.client.post('/api/v2/plugins/spreadsheet/unload')).state, 'unloaded');
  assert.deepEqual(await host.client.job(mcpRead.job.id), mcpRead.job);
  report.lifecycle = {
    first_generation: loaded.generation,
    next_generation: reloaded.generation,
    history_job: mcpRead.job.id,
  };
  report.checks.push({
    name: '卸载动态目录撤销、实际前端原票据恢复历史无重发、新代可用与旧历史不改写',
    passed: true,
  });
}
