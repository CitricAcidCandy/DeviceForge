import assert from 'node:assert/strict';
import test from 'node:test';
import { runDebuggerAutomation } from '../src/app/debugger-automation/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { JsonValue } from '../src/plugin-sdk/index.ts';

const target = { plugin_id: 'example', generation: '7' };
const node = { id: 'node-a', generation: 1, revision: 1 };
type Execute = Parameters<typeof runDebuggerAutomation>[3];
type Fields = { [key: string]: JsonValue };

function fields(value: JsonValue | undefined): Fields {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), '结果必须为 JSON 对象');
  return value;
}
function reportSteps(value: JsonValue): Fields[] {
  const steps = fields(value).steps;
  assert.ok(Array.isArray(steps), '报告必须包含步骤');
  return steps.map(fields);
}
function step(id: string, tool: string, parameters: JsonValue = {}): Fields {
  return { id, tool, parameters };
}
function plan(steps: JsonValue[], confirmed = false, stopOnFailure = true): Fields {
  return { steps, confirmed, stop_on_failure: stopOnFailure };
}
function pending<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => { throw new Error('承诺尚未初始化'); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('完整预检拒绝非法步骤而不会提前执行前面的合法步骤', async () => {
  const invalidPlans: JsonValue[] = [
    plan([]),
    plan(Array.from({ length: 33 }, (_, index) => step(`步骤${index}`, 'inspect'))),
    plan([step('相同', 'inspect'), step('相同', 'data_catalog')]),
    plan([step('读取', 'inspect'), step('嵌套', 'automation_run')], true),
    plan([step('读取', 'inspect'), step('重载', 'reload')], true),
    { ...plan([step('读取', 'inspect')]), unsupported: true },
  ];
  for (const input of invalidPlans) {
    let executions = 0;
    await assert.rejects(runDebuggerAutomation(input, target, new AbortController().signal,
      async () => { executions++; return {}; }));
    assert.equal(executions, 0, '计划预检失败不能执行任何步骤');
  }
});

test('读操作无需变更授权，所有步骤使用同一精确目标代次', async () => {
  const targets: JsonValue[] = [];
  const tools: string[] = [];
  const result = await runDebuggerAutomation(plan([
    step('检查', 'inspect'), step('目录', 'data_catalog'), step('读取', 'data_read', { source_id: 'business' }),
  ]), target, new AbortController().signal, async (tool, selected) => {
    tools.push(tool); targets.push({ ...selected });
    return tool === 'data_read' ? { source_id: 'business', revision: 'r1', value: { count: 2 } } : {};
  });
  assert.deepEqual(tools, ['inspect', 'data_catalog', 'data_read']);
  assert.deepEqual(targets, [target, target, target]);
  assert.equal(fields(result).status, 'completed');
  assert.equal(fields(result).target_generation, '7');
  assert.ok(reportSteps(result).every((item) => item.status === 'succeeded'));
});

test('包含写入的计划必须提前授权，计划授权不隐式补充动作确认', async () => {
  let executions = 0;
  const write = step('保存', 'data_write', {
    source_id: 'business', expected_revision: 'r1', value: { count: 3 }, confirmed: true,
  });
  await assert.rejects(runDebuggerAutomation(plan([step('读取', 'inspect'), write]), target,
    new AbortController().signal, async () => { executions++; return {}; }));
  assert.equal(executions, 0);

  let dispatched: JsonValue = null;
  await assert.rejects(runDebuggerAutomation(plan([step('点击', 'ui_action', { action: { type: 'click', target: node } })], true), target,
    new AbortController().signal, async (_tool, _target, parameters) => {
      dispatched = parameters;
      throw new HostError('protocol', 'debugger_confirmation_required', '动作仍需本次明确确认');
    }));
  assert.equal(dispatched, null, '动作缺少确认时应在任何派发前拒绝');

  await runDebuggerAutomation(plan([step('点击', 'ui_action', { action: { type: 'click', target: node, confirmed: true } })], true), target,
    new AbortController().signal, async (_tool, _target, parameters) => {
      dispatched = parameters;
      return { status: 'dispatched', businessOutcome: 'unknown' };
    });
  assert.equal(fields(fields(dispatched).action).confirmed, true);
  assert.equal(fields(fields(dispatched).action).allowUnknownSideEffects, undefined);
});

test('界面已派发不冒充业务验证完成，普通业务value保持可读', async () => {
  const result = await runDebuggerAutomation(plan([
    step('填值', 'ui_action', { action: { type: 'fill', target: node, confirmed: true, value: '新名称' } }),
    step('回读', 'data_read', { source_id: 'business' }),
  ], true), target, new AbortController().signal, async (tool) => tool === 'ui_action'
    ? { status: 'dispatched', businessOutcome: 'unknown' }
    : { source_id: 'business', revision: 'r2', value: { name: '新名称', value: '普通业务值' } });
  assert.equal(fields(result).verified, false);
  const steps = reportSteps(result);
  assert.equal(steps[0]?.status, 'succeeded');
  assert.equal(fields(fields(steps[1]?.result).value).value, '普通业务值');
});

test('查询结果只投影节点引用，绑定不会修改调用者原计划', async () => {
  const action = step('点击', 'ui_action', { root_id: 'root-a', action: { type: 'click', confirmed: true } });
  action.bind = { target_from_step: '查询' };
  const input = plan([step('查询', 'ui_query', { root_id: 'root-a', query: { role: 'button', name: '保存' } }), action], true);
  const before = JSON.stringify(input);
  let received: JsonValue = null;
  const result = await runDebuggerAutomation(input, target, new AbortController().signal,
    async (tool, _target, parameters) => {
      if (tool === 'ui_query') return { nodes: [{ id: 'node-9', generation: 3, revision: 4,
        name: '保存', metadata: { internal: '不应进入动作' } }], complete: true, reason: null };
      received = parameters;
      return { status: 'dispatched', businessOutcome: 'unknown' };
    });
  assert.equal(fields(result).status, 'completed');
  assert.deepEqual(fields(fields(received).action).target, { id: 'node-9', generation: 3, revision: 4 });
  assert.equal(JSON.stringify(input), before, '结果绑定不能原地改写计划');
});

test('数据读取修订可显式绑定保存的CAS条件', async () => {
  const write = step('保存', 'data_write', { source_id: 'business', value: { count: 4 }, confirmed: true });
  write.bind = { revision_from_step: '读取' };
  let expected: JsonValue | undefined;
  const result = await runDebuggerAutomation(plan([
    step('读取', 'data_read', { source_id: 'business' }), write,
  ], true), target, new AbortController().signal, async (tool, _target, parameters) => {
    if (tool === 'data_read') return { source_id: 'business', revision: 'revision-actual', value: { count: 3 } };
    expected = fields(parameters).expected_revision;
    return { source_id: 'business', revision: 'revision-next', value: { count: 4 } };
  });
  assert.equal(expected, 'revision-actual');
  assert.equal(fields(result).status, 'completed');
});

test('前向和错误工具绑定在执行前被拒绝', async () => {
  const candidates: JsonValue[] = [
    plan([{ ...step('保存', 'data_write', { source_id: 'business', value: {}, confirmed: true }),
      bind: { revision_from_step: '未来' } }, step('未来', 'data_read', { source_id: 'business' })], true),
    plan([step('检查', 'inspect'), { ...step('保存', 'data_write', { source_id: 'business', value: {}, confirmed: true }),
      bind: { revision_from_step: '检查' } }], true),
  ];
  for (const candidate of candidates) {
    let executions = 0;
    await assert.rejects(runDebuggerAutomation(candidate, target, new AbortController().signal,
      async () => { executions++; return {}; }));
    assert.equal(executions, 0);
  }
});

test('零个或多个查询命中不能替Agent任选一个节点点击', async () => {
  for (const nodes of [[], [{ id: 'a', generation: 1, revision: 1 }, { id: 'b', generation: 1, revision: 1 }]]) {
    const tools: string[] = [];
    const click = { ...step('点击', 'ui_action', { action: { type: 'click', confirmed: true } }),
      bind: { target_from_step: '查询' } };
    const result = await runDebuggerAutomation(plan([step('查询', 'ui_query', { query: {} }), click], true), target,
      new AbortController().signal, async (tool) => { tools.push(tool); return { nodes, complete: true, reason: null }; });
    assert.deepEqual(tools, ['ui_query']);
    assert.equal(reportSteps(result)[1]?.status, 'failed');
  }
});

test('断言失败属于失败步骤，默认停止并保留未执行步骤', async () => {
  const tools: string[] = [];
  const result = await runDebuggerAutomation(plan([
    step('断言', 'ui_assert', { assertion: { condition: 'exists', query: { name: '保存成功' } } }),
    step('后续读取', 'inspect'),
  ]), target, new AbortController().signal, async (tool) => {
    tools.push(tool); return { status: 'failed', matched: 0, reason: '未找到保存提示' };
  });
  assert.deepEqual(tools, ['ui_assert']);
  assert.equal(fields(result).status, 'failed');
  assert.deepEqual(reportSteps(result).map((item) => item.status), ['failed', 'skipped']);
});

test('可继续的明确失败只继续计划中的下一步，不重试原步骤', async () => {
  const tools: string[] = [];
  const result = await runDebuggerAutomation(plan([step('检查', 'inspect'), step('目录', 'data_catalog')], false, false),
    target, new AbortController().signal, async (tool) => {
      tools.push(tool);
      if (tool === 'inspect') throw new HostError('protocol', 'debugger_capability_unavailable', '缺少检查入口');
      return { sources: [] };
    });
  assert.deepEqual(tools, ['inspect', 'data_catalog']);
  assert.deepEqual(reportSteps(result).map((item) => item.status), ['failed', 'succeeded']);
  assert.equal(fields(result).status, 'failed');
});

test('无法判定即使允许继续也停止后续写入', async () => {
  const tools: string[] = [];
  const result = await runDebuggerAutomation(plan([
    step('等待', 'ui_action', { action: { type: 'wait', assertion: { query: { name: '已保存' }, condition: 'exists' } } }),
    step('保存', 'data_write', { source_id: 'business', expected_revision: 'r1', value: {}, confirmed: true }),
  ], true, false), target, new AbortController().signal, async (tool) => {
    tools.push(tool); return { status: 'indeterminate', reason: '视图内容不完整', businessOutcome: 'unknown' };
  });
  assert.deepEqual(tools, ['ui_action']);
  assert.equal(fields(result).status, 'indeterminate');
  assert.equal(reportSteps(result)[1]?.status, 'skipped');
});

test('不完整查询不能证明唯一，绑定拒绝跨挂载根点击', async () => {
  const candidates = [{ complete: false, root: 'root-a' }, { complete: true, root: 'root-b' }];
  for (const { complete, root } of candidates) {
    const tools: string[] = [];
    const click = { ...step('点击', 'ui_action', { root_id: root, action: { type: 'click', confirmed: true } }),
      bind: { target_from_step: '查询' } };
    const result = await runDebuggerAutomation(plan([
      step('查询', 'ui_query', { root_id: 'root-a', query: { name: '保存' } }), click,
    ], true), target, new AbortController().signal, async (tool) => {
      tools.push(tool); return { nodes: [{ id: 'a', generation: 1, revision: 2 }], complete, reason: null };
    });
    assert.deepEqual(tools, ['ui_query']);
    assert.equal(reportSteps(result)[1]?.status, 'failed');
  }
});

test('节点绑定继承查询的挂载根，报告裁剪不丢失小引用', async () => {
  const click = { ...step('点击', 'ui_action', { action: { type: 'click', confirmed: true } }),
    bind: { target_from_step: '查询' } };
  let actual: JsonValue = null;
  const result = await runDebuggerAutomation(plan([
    step('查询', 'ui_query', { root_id: 'root-a', query: { name: '保存' } }), click,
  ], true), target, new AbortController().signal, async (tool, _target, parameters) => {
    if (tool === 'ui_query') return { nodes: [{ id: 'node-a', generation: 2, revision: 3,
      metadata: { detail: '长'.repeat(20000) } }], complete: true, reason: null };
    actual = parameters;
    return { status: 'dispatched', businessOutcome: 'unknown' };
  });
  assert.equal(fields(actual).root_id, 'root-a');
  assert.deepEqual(fields(fields(actual).action).target, { id: 'node-a', generation: 2, revision: 3 });
  assert.equal(fields(reportSteps(result)[0]?.result_metadata).included, false);
});

test('只有变更后的明确界面断言可形成验证证据，后续变更撤销已验证结论', async () => {
  const click = step('点击', 'ui_action', { action: { type: 'click', target: node, confirmed: true } });
  const assertion = step('验证', 'ui_assert', { assertion: { condition: 'exists', query: { name: '已保存' } } });
  const execute: Execute = async (tool) => tool === 'ui_assert'
    ? { status: 'passed', matched: 1, reason: '已找到提示' }
    : { status: 'dispatched', businessOutcome: 'unknown' };
  const verified = await runDebuggerAutomation(plan([click, assertion], true), target, new AbortController().signal, execute);
  assert.equal(fields(verified).verified, true);
  const unverified = await runDebuggerAutomation(plan([assertion, click], true), target, new AbortController().signal, execute);
  assert.equal(fields(unverified).verified, false);
});

test('数据修改或公开调用有真实回执也不冒充界面断言覆盖业务结果', async () => {
  for (const tool of ['data_write', 'invoke']) {
    const parameters: JsonValue = tool === 'data_write'
      ? { source_id: 'business', expected_revision: 'r1', value: {}, confirmed: true }
      : { kind: 'service', id: 'example.echo', version: '1', input: {}, confirmed: true, allow_unknown_side_effects: true };
    const result = await runDebuggerAutomation(plan([
      step('变更', tool, parameters), step('验证', 'ui_assert', { assertion: { condition: 'exists', query: {} } }),
    ], true), target, new AbortController().signal, async (current) => current === 'ui_assert'
      ? { status: 'passed', matched: 1, reason: '提示存在' }
      : { source_id: 'business', revision: 'r2', value: { count: 1 } });
    assert.equal(fields(result).verified, false);
  }
});

test('写入等待到期保留未知结果，不重放且后续步骤不执行', async () => {
  const release = pending<JsonValue>();
  const tools: string[] = [];
  const result = await runDebuggerAutomation(plan([
    step('保存', 'data_write', { source_id: 'business', expected_revision: 'r1', value: {}, confirmed: true }),
    step('后续', 'inspect'),
  ], true, false), target, new AbortController().signal, async (tool) => {
    tools.push(tool); return release.promise;
  }, { totalMs: 100, stepMs: 10 });
  assert.equal(fields(result).status, 'indeterminate');
  assert.deepEqual(tools, ['data_write']);
  assert.deepEqual(reportSteps(result).map((item) => item.status), ['indeterminate', 'skipped']);
  release.resolve({ source_id: 'business', revision: 'r2', value: {} });
  await Promise.resolve();
  assert.deepEqual(tools, ['data_write']);
});

test('调用方取消在途读取后返回部分记录，不等永不结束的回调', async () => {
  const controller = new AbortController();
  const started = pending<void>();
  const tools: string[] = [];
  const running = runDebuggerAutomation(plan([step('读取', 'data_read', { source_id: 'business' }), step('目录', 'data_catalog')]),
    target, controller.signal, async (tool) => {
      tools.push(tool); started.resolve();
      return new Promise<JsonValue>(() => {});
    }, { totalMs: 100, stepMs: 80 });
  await started.promise;
  controller.abort();
  const result = await running;
  assert.equal(fields(result).status, 'cancelled');
  assert.deepEqual(tools, ['data_read']);
  assert.deepEqual(reportSteps(result).map((item) => item.status), ['cancelled', 'skipped']);
});

test('总预算在各步骤之间共享，后续调用不能重新取得整份预算', async () => {
  const tools: string[] = [];
  const result = await runDebuggerAutomation(plan([
    step('读取一', 'inspect'), step('读取二', 'data_catalog'), step('读取三', 'data_read', { source_id: 'business' }),
  ]), target, new AbortController().signal, async (tool) => {
    tools.push(tool);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    return {};
  }, { totalMs: 25, stepMs: 20 });
  assert.ok(tools.length >= 1 && tools.length < 3, '共享总期限内不能把每步期限重新累计');
  assert.notEqual(fields(result).status, 'completed');
  assert.equal(reportSteps(result)[2]?.status, 'skipped');
});

test('大步骤结果仅保留大小说明且整体报告有界', async () => {
  const result = await runDebuggerAutomation(plan([step('读取', 'data_read', { source_id: 'business' })]), target,
    new AbortController().signal, async () => ({ source_id: 'business', revision: 'r1', value: '文'.repeat(20000) }));
  const item = reportSteps(result)[0];
  const metadata = fields(item?.result_metadata);
  assert.equal(metadata.included, false);
  assert.ok(typeof metadata.bytes === 'number' && metadata.bytes > 16384);
  assert.equal(item?.result, null);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 768 * 1024);
});

test('数据和界面工具的后半段格式错误均在任何派发前拒绝', async () => {
  const invalidSteps: JsonValue[] = [
    { ...step('空绑定', 'inspect'), bind: {} },
    step('错误目录', 'data_catalog', { source_id: '不支持筛选' }),
    step('缺少来源', 'data_read', {}),
    step('缺少修订', 'data_write', { source_id: 'business', value: {}, confirmed: true }),
    step('缺少数据', 'data_write', { source_id: 'business', expected_revision: 'r1', confirmed: true }),
    step('缺少查询', 'ui_query', {}),
    step('缺少节点', 'ui_action', { action: { type: 'click', confirmed: true } }),
    step('非法断言', 'ui_assert', { assertion: { condition: '随意条件', query: {} } }),
    step('缺少版本', 'invoke', { kind: 'service', id: 'example.echo', input: {}, confirmed: true, allow_unknown_side_effects: true }),
  ];
  for (const invalid of invalidSteps) {
    let executions = 0;
    await assert.rejects(runDebuggerAutomation(plan([step('合法前置', 'inspect'), invalid], true), target,
      new AbortController().signal, async () => { executions++; return {}; }));
    assert.equal(executions, 0, '后半段格式失败不能留下已执行前半段');
  }
});

test('修订绑定拒绝读取另一个数据源的修订', async () => {
  const write = { ...step('保存', 'data_write', { source_id: 'source-b', value: {}, confirmed: true }),
    bind: { revision_from_step: '读取' } };
  let writes = 0;
  try {
    const result = await runDebuggerAutomation(plan([
      step('读取', 'data_read', { source_id: 'source-a' }), write,
    ], true), target, new AbortController().signal, async (tool) => {
      if (tool === 'data_write') writes++;
      return { source_id: 'source-a', revision: 'r1', value: {} };
    });
    assert.equal(reportSteps(result)[1]?.status, 'failed');
  } catch (error) {
    assert.ok(error instanceof HostError && error.code === 'debugger_invalid_parameters');
  }
  assert.equal(writes, 0);
});

test('自动调试报告保留普通数据字段并过滤已知凭据字段', async () => {
  const secret = '应被过滤的凭据';
  const result = await runDebuggerAutomation(plan([step('读取', 'data_read', { source_id: 'business' })]), target,
    new AbortController().signal, async () => ({ source_id: 'business', revision: 'r1',
      value: { value: '业务数值', api_key: secret }, token: secret }));
  assert.equal(fields(fields(reportSteps(result)[0]?.result).value).value, '业务数值');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('单步读取期限到达后记无法判定并停止后续步骤', async () => {
  const tools: string[] = [];
  const result = await runDebuggerAutomation(plan([
    step('读取', 'data_read', { source_id: 'business' }), step('后续', 'inspect'),
  ], false, false), target, new AbortController().signal, async (tool) => {
    tools.push(tool);
    return new Promise<JsonValue>(() => {});
  }, { totalMs: 100, stepMs: 10 });
  assert.equal(fields(result).status, 'indeterminate');
  assert.deepEqual(tools, ['data_read']);
  assert.deepEqual(reportSteps(result).map((item) => item.status), ['indeterminate', 'skipped']);
});

test('日志关联在大结果被裁剪后仍保留真实日志ID', async () => {
  const result = await runDebuggerAutomation(plan([step('读取', 'data_read', { source_id: 'business' })]), target,
    new AbortController().signal, async () => ({ source_id: 'business', revision: 'r1',
      logId: 'actual-log-from-source', value: '长结果'.repeat(10000) }));
  const item = reportSteps(result)[0];
  assert.equal(fields(item?.result_metadata).included, false);
  assert.equal(item?.result, null);
  assert.equal(item?.log_id, 'actual-log-from-source');
});

test('日志关联保留受控HostError的日志ID并不伪造任务关联', async () => {
  const result = await runDebuggerAutomation(plan([step('读取', 'inspect')]), target,
    new AbortController().signal, async () => {
      throw new HostError('protocol', 'debugger_capability_unavailable', '缺少调试能力', 'actual-error-log');
    });
  const item = reportSteps(result)[0];
  assert.equal(item?.status, 'failed');
  assert.equal(item?.log_id, 'actual-error-log');
  assert.equal(fields(item?.error).code, 'debugger_capability_unavailable');
  assert.equal(item?.job_id, undefined);
});

test('统计字段token_count和tokenCount保持可读，密码与API密钥仍脱敏', async () => {
  const secret = '统计回归中的私密凭据';
  const result = await runDebuggerAutomation(plan([step('读取统计', 'data_read', { source_id: 'metrics' })]), target,
    new AbortController().signal, async () => ({ source_id: 'metrics', revision: 'r1', value: {
      token_count: 123, tokenCount: 456, password: secret, api_secret: secret, api_key: secret,
    } }));
  const values = fields(fields(reportSteps(result)[0]?.result).value);
  assert.equal(values.token_count, 123);
  assert.equal(values.tokenCount, 456);
  assert.equal(values.password, '[已脱敏]');
  assert.equal(values.api_secret, '[已脱敏]');
  assert.equal(values.api_key, '[已脱敏]');
  assert.equal(JSON.stringify(result).includes(secret), false);
});
