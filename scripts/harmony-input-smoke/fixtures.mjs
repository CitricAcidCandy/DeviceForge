import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import {
  prepareTool as portableTool,
  readyCall as originalReady,
  finishTools as originalFinish,
} from '../harmony-screenshot-smoke/fixtures.mjs';
export {
  callCount,
  configureHdc,
  finishPendingProbes,
} from '../harmony-screenshot-smoke/fixtures.mjs';
import { localId, otherId } from './contracts.mjs';

export const version = '5.0.1.1\n\nDF_INPUT_DONE:{{TOKEN}}:version:0\n';
export const help =
  'click/doubleClick/longClick <x> <y> click on the target coordinates\n' +
  'swipe/drag <from_x> <from_y> <to_x> <to_y> [velocity] velocity ranges from 200 to 40000, default 600\n' +
  'keyEvent <keyID/Back/Home/Power> inject keyEvent\n' +
  'inputText <x> <y> <text> inputText at the target coordinate point\n\nDF_INPUT_DONE:{{TOKEN}}:help:0\n';
export const successReceipt = 'No Error\n\nDF_INPUT_DONE:{{TOKEN}}:{{STAGE}}:0\n';
export const cases = [
  { kind: 'tap', action: { kind: 'tap', x: 1, y: 32767 }, command: 'uitest uiInput click 1 32767' },
  {
    kind: 'swipe',
    action: { kind: 'swipe', x1: 1, y1: 2, x2: 32767, y2: 3 },
    command: 'uitest uiInput swipe 1 2 32767 3 600',
  },
  {
    kind: 'keyevent',
    action: { kind: 'keyevent', key_code: 2054 },
    command: 'uitest uiInput keyEvent 2054',
  },
  {
    kind: 'text',
    action: { kind: 'text', x: 1, y: 2, text: "中文 space %s % ' $ \u0060 ", enter: true },
    command: "uitest uiInput inputText 1 2 '中文 space %s % '\\'' $ \u0060 '",
    enter: true,
  },
];

async function plan(fixture, ordinal, stage, command, stdout, device = localId) {
  const root = join(fixture.toolRoot, 'plan-' + String(ordinal).padStart(2, '0'));
  await mkdir(root);
  for (const [name, value] of Object.entries({
    stdout,
    stderr: '',
    code: '0',
    'input-stage': stage,
    'input-command': command,
    'input-serial': device,
  }))
    await writeFile(join(root, name), value, { flag: 'wx' });
  fixture.plans.push({ ordinal, stage, command, device, root });
}

export async function prepareInputTool(
  options,
  report,
  label,
  selected = cases[0],
  device = localId,
) {
  const fixture = await portableTool(options.directory, options.toolBinary, report, {
    label,
    screenshot: false,
  });
  fixture.plans = [];
  fixture.selected = selected;
  await writeFile(join(fixture.toolRoot, 'input-fixture'), '1', { flag: 'wx' });
  await plan(fixture, 1, 'version', 'uitest --version', version, device);
  await plan(fixture, 2, 'help', 'uitest help', help, device);
  await plan(fixture, 3, 'action', selected.command, successReceipt, device);
  if (selected.enter)
    await plan(fixture, 4, 'enter', 'uitest uiInput keyEvent 2054', successReceipt, device);
  return fixture;
}

export async function prepareDiscoveryTool(options, report, label, ids = [localId, otherId]) {
  const fixture = await portableTool(options.directory, options.toolBinary, report, {
    label,
    screenshot: false,
  });
  fixture.plans = [];
  await writeFile(join(fixture.toolRoot, 'input-fixture'), '1', { flag: 'wx' });
  await plan(fixture, 1, 'list', '', ids.join('\n') + '\n');
  for (const [index, id] of ids.entries()) {
    await plan(fixture, 2 + index * 2, 'version', 'uitest --version', version, id);
    await plan(fixture, 3 + index * 2, 'help', 'uitest help', help, id);
  }
  return fixture;
}

export async function setResponse(fixture, ordinal, name, bytes) {
  assert.ok(['stdout', 'stderr', 'code'].includes(name));
  const selected = fixture.plans.find((entry) => entry.ordinal === ordinal);
  assert.ok(selected);
  await writeFile(join(selected.root, name), bytes);
}

export async function readyCall(fixture, ordinal, options) {
  const planned = fixture.plans.find((entry) => entry.ordinal === ordinal);
  assert.ok(planned);
  if (planned.stage === 'list')
    return originalReady(fixture, ordinal, {
      ...options,
      stage: 'list',
      expected: ['list', 'targets'],
    });
  const directory = join(fixture.toolRoot, 'call-' + String(ordinal).padStart(2, '0'));
  await poll(
    async () => {
      try {
        return await readFile(join(directory, 'ready'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    (bytes) => bytes?.equals(Buffer.from('1')),
    '输入真实HDC门闩',
    8000,
  );
  const token = await readFile(join(directory, 'input-token'), 'utf8');
  assert.match(token, /^[a-f\d]{32}$/);
  assert.equal(await readFile(join(directory, 'input-stage'), 'utf8'), planned.stage);
  assert.deepEqual(await readFile(join(directory, 'input-argv-verified')), Buffer.from('1'));
  const script =
    planned.command +
    " 2>&1\ninput_status=$?\nprintf '\\nDF_INPUT_DONE:" +
    token +
    ':' +
    planned.stage +
    ':%s\\n\' "$input_status"\n';
  const call = await originalReady(fixture, ordinal, {
    ...options,
    stage: planned.stage,
    expected: ['-t', planned.device, 'shell', script],
  });
  call.token = token;
  return call;
}

export async function release(fixture, ordinal) {
  const planRoot = fixture.plans.find((entry) => entry.ordinal === ordinal).root;
  await writeFile(join(planRoot, 'release.tmp'), '1', { flag: 'wx' });
  await rename(join(planRoot, 'release.tmp'), join(planRoot, 'release'));
}

export async function advance(fixture, last = fixture.plans.length, options) {
  for (let ordinal = options?.from ?? 1; ordinal <= last; ordinal++) {
    await readyCall(fixture, ordinal, options);
    await release(fixture, ordinal);
  }
}

export async function finishTools(fixture) {
  const tools = await originalFinish(fixture);
  return tools.map((tool, index) => ({ ...tool, token: fixture.calls[index].token }));
}
