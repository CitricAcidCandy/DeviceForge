import assert from 'node:assert/strict';

export const pluginId = 'ai-assistant';
export const operation = 'plugin.ai-assistant.cli.stream';
export const deploymentCanary = 'DF_AI_PUBLIC_DEPLOYMENT_CANARY_20261012';
export const hostCanary = 'DF_AI_PUBLIC_HOST_CANARY_20261012';
export const prompt = '公开夹具提示词：中文、换行\n第二行，禁止自动重放。';
export const reasoning = '公开推理摘要，凭据[已隐藏]。';
export const updated = '这是完整正文快照：' + '中文🙂'.repeat(1300) + '；凭据[已隐藏]。';
export const answer = '公开最终回答🙂；凭据[已隐藏]。';
export const privateMarkers = [
  'provider_reasoning_raw',
  'provider_command_raw',
  'provider_answer_raw',
  'DF_AI_RAW_COMMAND_CANARY',
  'DF_AI_RAW_TOOL_OUTPUT_CANARY',
  'DF_AI_RAW_DIAGNOSTIC_CANARY',
  deploymentCanary,
  hostCanary,
];

export function sourceContract(manifest) {
  assert.equal(manifest.id, pluginId);
  assert.equal(manifest.protocol_version, 4);
  assert.deepEqual(manifest.operations.map((entry) => entry.name).sort(), [
    'cli.single',
    'cli.turn',
    'runtime.status',
    'session.close',
    'session.get',
  ]);
  assert.equal(manifest.sessions.protocol_version, 5);
  assert.equal(manifest.sessions.operations.length, 1);
  const definition = manifest.sessions.operations[0];
  assert.equal(definition.name, 'cli.stream');
  assert.deepEqual(definition.execution, { api_version: 1, total_timeout_ms: 600000 });
  assert.equal(definition.input_schema.additionalProperties, false);
  assert.deepEqual(definition.input_schema.required, ['project_id', 'prompt']);
  assert.deepEqual(Object.keys(definition.input_schema.properties).sort(), [
    'project_id',
    'prompt',
    'thread_id',
  ]);
  assert.equal(definition.input_schema.properties.thread_id.type, 'string');
}

export function golden(threadId) {
  return [
    { format_version: 1, type: 'thread.started', thread_id: threadId },
    { format_version: 1, type: 'turn.started' },
    {
      format_version: 1,
      type: 'item.started',
      item: { id: 'item_1', type: 'reasoning', status: 'in_progress', text: reasoning },
    },
    {
      format_version: 1,
      type: 'item.completed',
      item: { id: 'item_1', type: 'reasoning', status: 'completed', text: reasoning },
    },
    {
      format_version: 1,
      type: 'item.started',
      item: { id: 'item_2', type: 'command_execution', status: 'in_progress' },
    },
    {
      format_version: 1,
      type: 'item.completed',
      item: { id: 'item_2', type: 'command_execution', status: 'completed' },
    },
    {
      format_version: 1,
      type: 'item.started',
      item: { id: 'item_3', type: 'agent_message', status: 'in_progress', text: '第一段' },
    },
    {
      format_version: 1,
      type: 'item.updated',
      item: { id: 'item_3', type: 'agent_message', status: 'in_progress', text: updated },
    },
    {
      format_version: 1,
      type: 'item.completed',
      item: { id: 'item_3', type: 'agent_message', status: 'completed', text: answer },
    },
    { format_version: 1, type: 'turn.completed' },
  ];
}

export function expectedResult(projectId, threadId, turns) {
  return {
    project_id: projectId,
    thread_id: threadId,
    text: answer,
    turns: String(turns),
    stream_format_version: 1,
    provider: 'codex_cli',
    resource_scope: 'direct_process',
  };
}

export function publicOnly(value) {
  const raw = JSON.stringify(value);
  for (const marker of privateMarkers)
    assert.ok(!raw.includes(marker), '业务数据不得包含原诊断、部署值或条目原标识');
}
