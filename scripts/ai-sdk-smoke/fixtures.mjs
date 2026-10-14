import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { rawAnswer, prompt } from './contracts.mjs';
import { startFamily, finishFamily } from './processes.mjs';
import { startProbe, finishProbe } from '../harmony-screenshot-smoke/fixtures.mjs';

export async function prepareProject(directory, label, mode = 'normal') {
  const root = join(directory, 'projects', label);
  await mkdir(root, { recursive: true });
  const files = [],
    threadIds = [];
  const put = async (name, bytes) => {
    const path = join(root, name);
    await writeFile(path, bytes, { flag: 'wx' });
    files.push(await fileIdentity(path));
  };
  await put('fixture-mode.txt', ['four', 'frontend-assistant'].includes(mode) ? 'normal' : mode);
  for (let ordinal = 1; ordinal <= 8; ordinal++) {
    threadIds.push(randomUUID());
    await put(`thread-${String(ordinal).padStart(2, '0')}.txt`, threadIds[ordinal - 1]);
    const text = ['four', 'frontend-assistant'].includes(mode)
      ? JSON.stringify({
          is_final: ordinal === 4,
          final_answer: ordinal === 4 ? 'SDK四轮助手最终回答。' : '',
          next_step: ordinal === 4 ? '' : '继续执行第' + (ordinal + 1) + '轮',
          missing_info: '',
        })
      : rawAnswer;
    await put(`answer-${String(ordinal).padStart(2, '0')}.txt`, text);
  }
  return { label, root, mode, files, threadIds, calls: [] };
}

export async function release(call, name) {
  assert.ok(
    ['start', 'answer', 'continue', 'exit', 'release-child', 'release-grandchild'].includes(name),
  );
  const pending = join(call.directory, name + '.pending');
  await writeFile(pending, '1', { flag: 'wx' });
  await rename(pending, join(call.directory, name));
}

export async function readJson(path, label) {
  return poll(
    async () => {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    Boolean,
    label,
  );
}

export async function readyCall(
  context,
  fixture,
  ordinal = 1,
  { threadId, assistant = false } = {},
) {
  const directory = join(fixture.root, 'call-' + String(ordinal).padStart(2, '0'));
  const ready = await readJson(join(directory, 'ready.json'), 'SDK原生CLI实际就绪');
  assert.equal(ready.format_version, 1);
  assert.equal(ready.ordinal, ordinal);
  assert.equal(ready.thread_id, threadId ?? fixture.threadIds[ordinal - 1]);
  assert.equal(normalize(ready.project).toLowerCase(), normalize(fixture.root).toLowerCase());
  assert.equal(ready.host_canary_present, false);
  assert.equal(ready.host_api_key_present, false);
  assert.equal(ready.deployment_canary_present, true);
  assert.equal(await readFile(join(directory, 'stdin-eof'), 'utf8'), '1');
  const actualPrompt = await readFile(join(directory, 'prompt.bin'));
  assert.ok(actualPrompt.length > 0 && actualPrompt.length <= 524288);
  const expected = ['exec', '--experimental-json', '--cd', fixture.root];
  if (assistant) {
    const schemaIndex = ready.argv.indexOf('--output-schema');
    assert.equal(schemaIndex, 4);
    const schema = JSON.parse(await readFile(ready.argv[schemaIndex + 1], 'utf8'));
    assert.deepEqual(schema, {
      type: 'object',
      properties: {
        is_final: { type: 'boolean' },
        final_answer: { type: 'string' },
        next_step: { type: 'string' },
        missing_info: { type: 'string' },
      },
      required: ['is_final', 'final_answer'],
      additionalProperties: false,
    });
    expected.push('--output-schema', ready.argv[schemaIndex + 1]);
    assert.ok(actualPrompt.toString('utf8').includes('Return JSON only with keys:'));
    if (ordinal === 1)
      assert.ok(actualPrompt.toString('utf8').includes('multi-agent-orchestrator'));
  } else assert.deepEqual(actualPrompt, Buffer.from(prompt));
  if (threadId) expected.push('resume', threadId);
  assert.deepEqual(ready.argv, expected);
  const family = await startFamily(context, ready, directory, fixture.label + '-' + ordinal);
  const call = { directory, ready, family, fixture };
  fixture.calls.push(call);
  context.report.tools.push({
    project_id: fixture.label,
    ordinal,
    ready,
    prompt: await fileIdentity(join(directory, 'prompt.bin')),
  });
  return call;
}

export async function finishCall(context, call, expectedCode) {
  await finishFamily(call.family, expectedCode);
  const entry = context.report.tools.find(
    (value) => value.ready.identity.pid === call.ready.identity.pid,
  );
  entry.actual_files = await Promise.all(
    ['ready.json', 'prompt.bin', 'stdin-eof', 'ready-child.json', 'ready-grandchild.json'].map(
      (name) => fileIdentity(join(call.directory, name)),
    ),
  );
  const temporary = join(context.stateRoot, 'temporary');
  assert.deepEqual(await readdir(temporary), [], '公开成功或清理确认时调用临时目录必须已清空');
}

export async function completeCall(call) {
  await release(call, 'answer');
  await release(call, 'continue');
  await readJson(join(call.directory, 'provider-candidate.json'), '真实CLI成功事件候选原件');
  await release(call, 'release-child');
  await release(call, 'release-grandchild');
  await release(call, 'exit');
}

export async function runVersionProbe(context, pending) {
  const root = join(context.directory, 'tools', 'version-evidence');
  const ordinal = ++context.versionOrdinal;
  const directory = join(root, 'version-' + String(ordinal).padStart(2, '0'));
  const ready = await readJson(join(directory, 'ready.json'), '隔离CLI版本探测就绪');
  const probe = await startProbe(
    context.probeBinary,
    ready.pid,
    join(directory, 'os-version'),
    context.pluginBinary,
  );
  assert.equal(probe.ready.target.creation_time_100ns, ready.creation_time_100ns);
  assert.equal(probe.ready.parent.pid, ready.parent_pid);
  await writeFile(join(directory, 'release'), '1', { flag: 'wx' });
  const value = await pending;
  const process = await finishProbe(probe);
  assert.equal(process.exit.target.exit_code, 0);
  assert.equal(process.exit.parent.exit_code, 0);
  context.report.version_probes.push({ ordinal, ready, process });
  return value;
}
