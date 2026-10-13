'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const root = process.cwd();
  let callRoot;
  for (let ordinal = 1; ordinal <= 16; ordinal++) {
    const candidate = path.join(root, 'call-' + String(ordinal).padStart(2, '0'));
    try { fs.mkdirSync(candidate); callRoot = candidate; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!callRoot) throw new Error('夹具调用次数超限');
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8'));
  const record = { pid: process.pid, parent_pid: process.ppid, argv: process.argv.slice(1), cwd: root,
    deployment_present: process.env.DF_AI_DEPLOYMENT_CANARY === plan.canary,
    host_canary_present: Boolean(process.env.DF_AI_HOST_CANARY),
    host_api_key_present: Boolean(process.env.OPENAI_API_KEY) };
  const pending = path.join(callRoot, 'ready.json.tmp');
  fs.writeFileSync(pending, JSON.stringify(record), { flag: 'wx' });
  fs.renameSync(pending, path.join(callRoot, 'ready.json'));
  const readPrompt = async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    fs.writeFileSync(path.join(callRoot, 'prompt.bin'), bytes, { flag: 'wx' });
    fs.writeFileSync(path.join(callRoot, 'stdin-eof'), '1', { flag: 'wx' });
  };
  const gate = async name => {
    const deadline = Date.now() + 45000;
    while (!fs.existsSync(path.join(callRoot, name))) {
      if (Date.now() >= deadline) throw new Error('夹具门闩超时');
      await delay(10);
    }
  };
  await readPrompt();
  await gate('start');
  const write = async event => {
    const bytes = Buffer.from(JSON.stringify(event) + '\n');
    const chinese = bytes.indexOf(Buffer.from('中'));
    const boundary = chinese < 0 ? Math.min(7, bytes.length - 1) : chinese + 1;
    await new Promise((done, reject) => process.stdout.write(bytes.subarray(0, boundary), error => error ? reject(error) : done()));
    await delay(2);
    await new Promise((done, reject) => process.stdout.write(bytes.subarray(boundary), error => error ? reject(error) : done()));
  };
  const canary = plan.canary;
  await write({ type: 'thread.started', thread_id: plan.thread_id.toUpperCase(), secret: canary });
  await write({ type: 'turn.started', usage: { secret: canary } });
  await write({ type: 'unknown.provider.event', diagnostic: 'DF_AI_RAW_DIAGNOSTIC_CANARY' });
  await write({ type: 'item.started', item: { id: 'provider_reasoning_raw', type: 'reasoning', status: 'in_progress', text: '公开推理摘要，凭据' + canary + '。' } });
  await write({ type: 'item.completed', item: { id: 'provider_reasoning_raw', type: 'reasoning', status: 'completed', text: '公开推理摘要，凭据' + canary + '。' } });
  await write({ type: 'item.started', item: { id: 'provider_command_raw', type: 'command_execution', status: 'in_progress', command: 'DF_AI_RAW_COMMAND_CANARY' } });
  await write({ type: 'item.completed', item: { id: 'provider_command_raw', type: 'command_execution', status: 'completed', aggregated_output: 'DF_AI_RAW_TOOL_OUTPUT_CANARY' } });
  await write({ type: 'item.started', item: { id: 'provider_answer_raw', type: 'agent_message', status: 'in_progress', text: '第一段' } });
  process.stderr.write('DF_AI_RAW_DIAGNOSTIC_CANARY ' + canary + '\n');
  fs.writeFileSync(path.join(callRoot, 'incremental'), '1', { flag: 'wx' });
  await gate('continue');
  if (plan.mode === 'partial') { process.exitCode = 0; return; }
  await write({ type: 'item.updated', item: { id: 'provider_answer_raw', type: 'agent_message', status: 'in_progress', text: '这是完整正文快照：' + '中文🙂'.repeat(1300) + '；凭据' + canary + '。' } });
  await write({ type: 'item.completed', item: { id: 'provider_answer_raw', type: 'agent_message', status: 'completed', text: '公开最终回答🙂；凭据' + canary + '。' } });
  await write({ type: 'turn.completed', usage: { raw: canary } });
  fs.writeFileSync(path.join(callRoot, 'provider-completed'), '1', { flag: 'wx' });
  await gate('exit');
  if (plan.mode === 'late') await write({ type: 'error', message: 'DF_AI_RAW_DIAGNOSTIC_CANARY ' + canary });
  process.exitCode = plan.mode === 'nonzero' ? 7 : 0;
}

main().catch(() => { process.stderr.write('公开夹具内部失败\n'); process.exitCode = 91; });
