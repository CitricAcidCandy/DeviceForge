import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { poll } from '../device-provider/client.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { jpeg, localId, otherId } from './contracts.mjs';

export const stages = ['probe', 'capture', 'size', 'read', 'clear'];
const activeProbes = new Set();
const receipts = [
  'RGV2aWNlRm9yZ2U=\nDF_PROBE_DONE:{{TOKEN}}:0\n',
  'DF_OWNER_READY:{{TOKEN}}\n\nsuccess: snapshot display 0 , write to {{REMOTE}}/screenshot.jpeg as jpeg, width 1, height 1\n\nDF_CAPTURED:{{TOKEN}}:0\n',
  '\nDF_IMAGE_SIZE:{{TOKEN}}:0:{{SIZE}}\n',
  '\nDF_READ_DONE:{{TOKEN}}:0\n',
  'DF_CLEARED:{{TOKEN}}\n',
];

export async function prepareTool(
  directory,
  toolBinary,
  report,
  { label, screenshot = true, inputQualification = false } = {},
) {
  assert.match(label, /^[a-z0-9-]+$/);
  const toolRoot = join(directory, 'tools', label),
    scratchRoot = join(toolRoot, 'scratch');
  await mkdir(scratchRoot, { recursive: true });
  const copiedTool = join(toolRoot, process.platform === 'win32' ? 'fake-hdc.exe' : 'fake-hdc');
  await copyFile(toolBinary, copiedTool);
  const fixture = {
    toolRoot,
    scratchRoot,
    copiedTool,
    screenshot,
    inputQualification,
    probes: [],
    calls: [],
    label,
  };
  const original = await fileIdentity(toolBinary),
    actual = await fileIdentity(copiedTool);
  assert.equal(actual.sha256, original.sha256);
  report.fixtures ??= [];
  report.fixtures.push({ label, screenshot, original, actual, scratch_root: scratchRoot });
  if (screenshot) {
    await writeFile(join(toolRoot, 'screenshot-fixture'), '1', { flag: 'wx' });
    await writeFile(join(toolRoot, 'screenshot-source.jpeg'), jpeg, { flag: 'wx' });
    for (let index = 0; index < stages.length; index++) {
      const plan = join(toolRoot, `plan-${String(index + 1).padStart(2, '0')}`);
      await mkdir(plan);
      await writeFile(join(plan, 'stdout'), receipts[index]);
      await writeFile(join(plan, 'stderr'), '');
      await writeFile(join(plan, 'code'), '0');
      await writeFile(
        join(plan, 'screenshot-action'),
        index === 1 ? 'capture' : index === 4 ? 'clear' : 'none',
      );
      if (index === 3) await writeFile(join(plan, 'screenshot-base64'), '1');
    }
  } else {
    await writeFile(join(toolRoot, 'stdout'), `${localId}\n${otherId}\n`);
    await writeFile(join(toolRoot, 'stderr'), '');
    await writeFile(join(toolRoot, 'code'), '0');
    if (inputQualification) {
      await writeFile(join(toolRoot, 'input-fixture'), '1', { flag: 'wx' });
      const help =
        'click/doubleClick/longClick <x> <y> click on the target coordinates\n' +
        'swipe/drag <from_x> <from_y> <to_x> <to_y> [velocity] velocity ranges from 200 to 40000, default 600\n' +
        'keyEvent <keyID/Back/Home/Power> inject keyEvent\n' +
        'inputText <x> <y> <text> inputText at the target coordinate point\n\n';
      const plans = [
        [
          2,
          'version',
          'uitest --version',
          '5.0.1.1\n\nDF_INPUT_DONE:{{TOKEN}}:version:0\n',
          localId,
        ],
        [3, 'help', 'uitest help', help + 'DF_INPUT_DONE:{{TOKEN}}:help:0\n', localId],
        [
          4,
          'version',
          'uitest --version',
          '5.0.1.1\n\nDF_INPUT_DONE:{{TOKEN}}:version:0\n',
          otherId,
        ],
        [5, 'help', 'uitest help', help + 'DF_INPUT_DONE:{{TOKEN}}:help:0\n', otherId],
      ];
      for (const [ordinal, stage, command, stdout, serial] of plans) {
        const plan = join(toolRoot, `plan-${String(ordinal).padStart(2, '0')}`);
        await mkdir(plan);
        await writeFile(join(plan, 'stdout'), stdout, { flag: 'wx' });
        await writeFile(join(plan, 'stderr'), '', { flag: 'wx' });
        await writeFile(join(plan, 'code'), '0', { flag: 'wx' });
        await writeFile(join(plan, 'input-stage'), stage, { flag: 'wx' });
        await writeFile(join(plan, 'input-command'), command, { flag: 'wx' });
        await writeFile(join(plan, 'input-serial'), serial, { flag: 'wx' });
        await writeFile(join(plan, 'release'), '1', { flag: 'wx' });
      }
    }
  }
  return fixture;
}

export async function configureHdc(deployment, fixture, report) {
  fixture.pluginBinary = deployment.actualBinary;
  const configPath = join(dirname(deployment.actualBinary), 'harmony-device.config.json');
  const pending = configPath + '.' + randomUUID() + '.tmp';
  const bytes =
    JSON.stringify({
      format_version: 1,
      tools: { hdc: fixture.copiedTool },
      scratch_root: fixture.scratchRoot,
    }) + '\n';
  await writeFile(pending, bytes, { flag: 'wx' });
  await rename(pending, configPath);
  report.configuration_changes ??= [];
  report.configuration_changes.push({
    label: fixture.label,
    config: await fileIdentity(configPath),
    boundary: '完整旁置配置原子替换；并行切换必须在首任务HDC就绪确认已读取配置后执行',
  });
}

export async function setPlan(fixture, ordinal, name, bytes) {
  assert.ok(Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= 5);
  assert.ok(
    [
      'stdout',
      'stderr',
      'code',
      'screenshot-action',
      'screenshot-worker',
      'screenshot-body.bin',
    ].includes(name),
  );
  await writeFile(join(fixture.toolRoot, `plan-${String(ordinal).padStart(2, '0')}`, name), bytes);
}

export async function release(fixture, ordinal) {
  const plan = fixture.screenshot
    ? join(fixture.toolRoot, `plan-${String(ordinal).padStart(2, '0')}`)
    : fixture.toolRoot;
  const pending = join(plan, 'release.tmp');
  await writeFile(pending, '1', { flag: 'wx' });
  await rename(pending, join(plan, 'release'));
}

export async function callCount(fixture) {
  return (await readdir(fixture.toolRoot, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && /^call-\d{2}$/.test(entry.name),
  ).length;
}

function decodeArgv(bytes) {
  let offset = 0;
  const number = () => {
    assert.ok(offset + 4 <= bytes.length);
    const value = bytes.readUInt32LE(offset);
    offset += 4;
    return value;
  };
  const count = number();
  assert.ok(count <= 32);
  const argv = [];
  for (let index = 0; index < count; index++) {
    const length = number();
    assert.ok(length <= 65536 && offset + length <= bytes.length);
    const argument = bytes.subarray(offset, offset + length);
    offset += length;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(argument);
    argv.push(text);
  }
  assert.equal(offset, bytes.length);
  return argv;
}

export async function readyCall(
  fixture,
  ordinal,
  { stage, device = localId, probeBinary, expected } = {},
) {
  const directory = join(fixture.toolRoot, `call-${String(ordinal).padStart(2, '0')}`);
  await poll(
    async () => {
      try {
        return await readFile(join(directory, 'ready'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    (value) => value?.equals(Buffer.from('1')),
    '本次真实HDC就绪',
    8000,
  );
  const pid = Number(await readFile(join(directory, 'pid'), 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const argv = decodeArgv(await readFile(join(directory, 'argv.bin')));
  assert.deepEqual(
    await readFile(join(directory, 'restricted-flags.bin')),
    Buffer.from([0, 0, 0, 0]),
  );
  let token;
  if (fixture.screenshot) {
    token = await readFile(join(directory, 'screenshot.token'), 'utf8');
    assert.match(token, /^[a-f\d]{32}$/);
    assert.equal(await readFile(join(directory, 'screenshot.stage'), 'utf8'), stage);
    assert.deepEqual(argv, expectedArgv(stage, token, device));
    if (fixture.token) assert.equal(token, fixture.token);
    else fixture.token = token;
  } else assert.deepEqual(argv, expected ?? ['list', 'targets']);
  const call = { directory, pid, argv, token, stage };
  if (probeBinary) {
    call.probe = await startProbe(
      probeBinary,
      pid,
      join(directory, 'process'),
      fixture.pluginBinary,
    );
    fixture.probes.push(call.probe);
  }
  fixture.calls.push(call);
  return call;
}

export function expectedArgv(stage, token, device) {
  assert.match(token, /^[a-f\d]{32}$/);
  assert.ok(stages.includes(stage));
  const remote = '/data/local/tmp/deviceforge-screenshot-' + token;
  const scripts = {
    probe:
      "printf 'DeviceForge' | base64 -w 0\nprobe_status=$?\nprintf '\\nDF_PROBE_DONE:TOKEN:%s\\n' \"$probe_status\"\n",
    capture:
      "umask 077\nif ! mkdir 'REMOTE'; then\n  printf '\\nDF_DIR_REJECTED:TOKEN\\n'\n  exit 1\nfi\nif ! printf 'TOKEN\\n' > 'REMOTE/owner'; then\n  printf '\\nDF_OWNER_FAILED:TOKEN\\n'\n  exit 1\nfi\nprintf 'DF_OWNER_READY:TOKEN\\n'\nsnapshot_display -f 'REMOTE/screenshot.jpeg'\ncapture_status=$?\nprintf '\\nDF_CAPTURED:TOKEN:%s\\n' \"$capture_status\"\n",
    size: "if [ \"$(cat 'REMOTE/owner')\" != 'TOKEN' ]; then\n  printf '\\nDF_SIZE_REJECTED:TOKEN\\n'\n  exit 1\nfi\nif [ ! -f 'REMOTE/screenshot.jpeg' ] || [ -L 'REMOTE/screenshot.jpeg' ]; then\n  printf '\\nDF_SIZE_REJECTED:TOKEN\\n'\n  exit 1\nfi\nimage_size=$(wc -c < 'REMOTE/screenshot.jpeg')\nsize_status=$?\nprintf '\\nDF_IMAGE_SIZE:TOKEN:%s:%s\\n' \"$size_status\" \"$image_size\"\n",
    read: "if [ \"$(cat 'REMOTE/owner')\" != 'TOKEN' ]; then\n  printf '\\nDF_READ_REJECTED:TOKEN\\n'\n  exit 1\nfi\nbase64 -w 0 'REMOTE/screenshot.jpeg'\nread_status=$?\nprintf '\\nDF_READ_DONE:TOKEN:%s\\n' \"$read_status\"\n",
    clear:
      "if [ \"$(cat 'REMOTE/owner')\" != 'TOKEN' ]; then\n  printf '\\nDF_CLEAR_REJECTED:TOKEN\\n'\n  exit 1\nfi\nif ! rm -f 'REMOTE/screenshot.jpeg'; then\n  printf '\\nDF_CLEAR_REJECTED:TOKEN\\n'\n  exit 1\nfi\nif ! rm 'REMOTE/owner' || ! rmdir 'REMOTE'; then\n  printf '\\nDF_CLEAR_REJECTED:TOKEN\\n'\n  exit 1\nfi\nif [ -e 'REMOTE' ] || [ -L 'REMOTE' ]; then\n  printf '\\nDF_CLEAR_REJECTED:TOKEN\\n'\n  exit 1\nfi\nprintf 'DF_CLEARED:TOKEN\\n'\n",
  };
  return [
    '-t',
    device,
    'shell',
    scripts[stage].replaceAll('TOKEN', token).replaceAll('REMOTE', remote),
  ];
}

export async function startProbe(binary, pid, evidence, expectedParent) {
  assert.equal(process.platform, 'win32', '本批真实OS进程退出探针仅支持Windows');
  const args = ['--pid', String(pid), '--evidence', evidence];
  if (expectedParent) args.push('--expected-parent', expectedParent);
  const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const probe = { child, evidence, pid, output_bytes: 0, error_bytes: 0 };
  activeProbes.add(probe);
  child.stdout.on('data', (chunk) => {
    probe.output_bytes += chunk.length;
  });
  child.stderr.on('data', (chunk) => {
    probe.error_bytes += chunk.length;
  });
  probe.closed = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      probe.exit = { code, signal };
      activeProbes.delete(probe);
      done(probe.exit);
    });
  });
  probe.closed.catch(() => {});
  probe.ready = await poll(
    async () => {
      try {
        return JSON.parse(await readFile(evidence + '.ready.json', 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') {
          assert.equal(child.exitCode, null, '真实进程探针未就绪即退出');
          return null;
        }
        throw error;
      }
    },
    Boolean,
    '真实进程探针取得本次句柄',
    3000,
  );
  return probe;
}

export async function finishProbe(probe) {
  await probe.closed;
  assert.deepEqual(probe.exit, { code: 0, signal: null });
  assert.ok(probe.output_bytes <= 65536 && probe.error_bytes <= 65536);
  const exit = JSON.parse(await readFile(probe.evidence + '.exit.json', 'utf8'));
  assert.equal(exit.test_kill, false);
  return { ready: probe.ready, exit, probe_exit: probe.exit };
}

export async function observeProbe(probe) {
  const request = probe.evidence + '.request',
    pending = request + '.tmp';
  await writeFile(pending, '1', { flag: 'wx' });
  await rename(pending, request);
  const observed = await poll(
    async () => {
      try {
        return JSON.parse(await readFile(probe.evidence + '.observed.json', 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') {
          assert.equal(probe.child.exitCode, null);
          return null;
        }
        throw error;
      }
    },
    Boolean,
    '收到门闩后的真实OS状态观测',
    1000,
  );
  assert.equal(observed.target.pid, probe.pid);
  assert.equal(observed.test_kill, false);
  return observed;
}

export async function finishPendingProbes(report) {
  const probes = [...activeProbes];
  if (!probes.length) return;
  await Promise.race([Promise.allSettled(probes.map((probe) => probe.closed)), delay(7000)]);
  for (const probe of probes) {
    if (probe.child.exitCode === null && probe.child.signalCode === null) {
      report.probe_failure_cleanup ??= [];
      report.probe_failure_cleanup.push({
        own_probe_pid: probe.child.pid,
        target_pid: probe.pid,
        evidence: probe.evidence,
        forced_own_probe_termination: true,
        target_terminated: false,
      });
      probe.child.kill();
    }
  }
  await Promise.allSettled(probes.map((probe) => probe.closed));
  assert.equal(report.probe_failure_cleanup, undefined, '自有探针被兜底结束不能计为资源确认通过');
}

export async function advance(fixture, last, options) {
  for (let ordinal = options?.from ?? 1; ordinal <= last; ordinal++) {
    const call = await readyCall(fixture, ordinal, { ...options, stage: stages[ordinal - 1] });
    await release(fixture, ordinal);
    if (ordinal !== last)
      await poll(
        async () => {
          try {
            await lstat(
              join(fixture.toolRoot, 'call-' + String(ordinal + 1).padStart(2, '0'), 'ready'),
            );
            return true;
          } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
          }
        },
        Boolean,
        '下一截图阶段',
        8000,
      );
    call.released = true;
  }
}

export async function finishTools(fixture) {
  const tools = [];
  for (const call of fixture.calls) {
    assert.ok(call.probe, '每个已启动工具必须在就绪期间取得真实等待句柄');
    tools.push({
      directory: call.directory,
      pid: call.pid,
      argv: call.argv,
      stage: call.stage,
      process: await finishProbe(call.probe),
    });
  }
  return tools;
}

export function remoteRoot(fixture) {
  assert.match(fixture.token, /^[a-f\d]{32}$/);
  return join(fixture.toolRoot, 'screenshot-remote', 'deviceforge-screenshot-' + fixture.token);
}
