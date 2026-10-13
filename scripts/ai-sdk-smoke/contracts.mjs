import assert from 'node:assert/strict';

export const pluginId = 'ai-sdk';
export const operation = 'plugin.ai-sdk.sdk.stream';
export const sdkVersion = '0.162.1';
export const profileName = 'codex_sdk_ts_0_162_1_node24';
export const deploymentCanary = 'DF_AI_SDK_DEPLOYMENT_CANARY_20261012';
export const hostCanary = 'DF_AI_SDK_HOST_CANARY_20261012';
export const prompt = '公开SDK验收提示词：中文🙂与换行\n只发起本次轮次，禁止自动重放。';
export const answer = '公开SDK最终回答🙂；凭据[已隐藏]。';
export const rawAnswer = '公开SDK最终回答🙂；凭据' + deploymentCanary + '。';
export const reasoning = '公开SDK推理摘要，凭据[已隐藏]。';
export const updated = '这是SDK完整正文快照：' + '中文🙂'.repeat(1300) + '；凭据[已隐藏]。';
export const privateMarkers = ['provider_reasoning_raw', 'provider_command_raw', 'provider_answer_raw',
  'DF_AI_SDK_PRIVATE_COMMAND', 'DF_AI_SDK_PRIVATE_TOOL_OUTPUT', deploymentCanary, hostCanary];

export function sourceContract(manifest) {
  assert.equal(manifest.id, pluginId);
  assert.equal(manifest.protocol_version, 4);
  assert.deepEqual(manifest.operations.map(entry => entry.name).sort(),
    ['assistant.run', 'runtime.status', 'sdk.single', 'sdk.turn', 'session.close', 'session.get']);
  assert.equal(manifest.sessions.protocol_version, 5);
  assert.equal(manifest.sessions.operations.length, 1);
  assert.equal(manifest.sessions.operations[0].name, 'sdk.stream');
  assert.deepEqual(manifest.sessions.operations[0].execution, { api_version: 1, total_timeout_ms: 600000 });
}

export function expectedResult(projectId, threadId, turns, text = answer) {
  return { provider: 'codex_sdk', sdk_version: sdkVersion, project_id: projectId,
    thread_id: threadId, text, turns: String(turns), resource_scope: 'sdk_worker_proxy_and_cli' };
}

export function expectedThread(fixture, threadId, turns, { closed = false, uncertain = false } = {}) {
  return { provider: 'codex_sdk', sdk_version: sdkVersion, profile: profileName,
    project_id: fixture.label, thread_id: threadId, turns: String(turns), closed, uncertain,
    resource_scope: 'sdk_worker_proxy_and_cli' };
}

export function golden(threadId, text = answer) {
  return [
    { format_version: 1, type: 'thread.started', thread_id: threadId },
    { format_version: 1, type: 'turn.started' },
    { format_version: 1, type: 'item.started', item: { id: 'item_1', type: 'reasoning', status: 'in_progress', text: reasoning } },
    { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'reasoning', status: 'completed', text: reasoning } },
    { format_version: 1, type: 'item.started', item: { id: 'item_2', type: 'command_execution', status: 'in_progress' } },
    { format_version: 1, type: 'item.completed', item: { id: 'item_2', type: 'command_execution', status: 'completed' } },
    { format_version: 1, type: 'item.started', item: { id: 'item_3', type: 'agent_message', status: 'in_progress', text: '第一段' } },
    { format_version: 1, type: 'item.updated', item: { id: 'item_3', type: 'agent_message', status: 'in_progress', text: updated } },
    { format_version: 1, type: 'item.completed', item: { id: 'item_3', type: 'agent_message', status: 'completed', text } },
    { format_version: 1, type: 'turn.completed' },
  ];
}

export function publicOnly(value) {
  const raw = JSON.stringify(value);
  for (const marker of privateMarkers) assert.ok(!raw.includes(marker), '公开SDK数据不得包含部署值、工具私有字段或原条目标识');
}
