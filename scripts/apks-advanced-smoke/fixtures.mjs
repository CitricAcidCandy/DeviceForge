import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep, toNamespacedPath } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { finishPendingProbes, finishProbe, startProbe } from '../harmony-screenshot-smoke/fixtures.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { baseApk, featureApk } from './contracts.mjs';

export { finishPendingProbes };
const canonical = value => toNamespacedPath(resolve(value)).toLowerCase();

export async function prepareTool(context, source) {
  const root = join(context.directory, 'tool');
  await mkdir(root);
  const executable = join(root, 'fake-java.exe'), jar = join(root, 'synthetic-bundletool.jar');
  await copyFile(source, executable);
  await writeFile(jar, '公开占位JAR；不执行真实Java或bundletool', { flag: 'wx' });
  await writeFile(join(root, 'base.apk'), baseApk, { flag: 'wx' });
  await writeFile(join(root, 'feature.apk'), featureApk, { flag: 'wx' });
  const files = await Promise.all([executable, jar, join(root, 'base.apk'), join(root, 'feature.apk')].map(fileIdentity));
  assert.equal(files[0].sha256, (await fileIdentity(source)).sha256);
  context.report.fixture = { source: await fileIdentity(source), files,
    boundary: 'std-only可控Java/ADB入口与占位JAR、合成APKS，仅证明固定编排和公开消费' };
  return { root, executable, jar, calls: [] };
}

export async function callKeys(tool) {
  return (await readdir(tool.root)).filter(name => /^call-\d+$/.test(name)).sort();
}

export async function started(context, previous, { pluginId, command, inputBytes, privateBytes, modules, instant = false, deviceId } = {}) {
  const call = await poll(async () => {
    const names = (await callKeys(context.tool)).filter(name => !previous.includes(name));
    assert.ok(names.length <= 1, '一次业务只允许一个直接工具');
    if (!names.length) return null;
    const directory = join(context.tool.root, names[0]);
    try { return { directory, ready: JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')) }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, Boolean, 'APKS直接工具与固定参数就绪', 12000);
  assert.equal(call.ready.command, command);
  assert.ok(Number.isSafeInteger(call.ready.pid) && call.ready.pid > 0);
  const argv = call.ready.argv;
  if (command === 'discover') assert.deepEqual(argv, ['devices', '-l']);
  else {
    assert.deepEqual([argv[0], argv[1], argv[3]], ['-Xmx256m', '-jar', command]);
    assert.equal(canonical(argv[2]), canonical(context.tool.jar));
    assert.ok(argv[4].startsWith('--apks='));
    const inputPath = argv[4].slice('--apks='.length);
    assert.ok(isAbsolute(inputPath));
    assert.ok(canonical(inputPath).startsWith(canonical(context.scratch[pluginId]) + sep));
    assert.deepEqual(await readFile(inputPath), inputBytes);
    assert.deepEqual(await readFile(join(call.directory, 'input.bin')), inputBytes);
    call.privateRoot = dirname(inputPath);
    call.inputIdentity = await fileIdentity(join(call.directory, 'input.bin'));
    if (command === 'extract-apks') {
      assert.equal(argv[5], '--output-dir=' + join(call.privateRoot, 'selected'));
      assert.equal(argv[6], '--device-spec=' + join(call.privateRoot, 'device-spec.json'));
      assert.deepEqual(await readFile(join(call.directory, 'device-spec.json')), Buffer.from(privateBytes));
      assert.deepEqual(await readFile(argv[6].slice('--device-spec='.length)), Buffer.from(privateBytes));
      call.privateJson = await fileIdentity(join(call.directory, 'device-spec.json'));
    } else {
      assert.equal(basename(inputPath), 'input.apks');
      assert.equal(argv[5], '--device-id=' + deviceId);
      assert.equal(await realpath(argv[6].slice('--adb='.length)), await realpath(context.tool.executable));
      for (const name of ['cwd', 'temp', 'tmp', 'tmpdir']) assert.equal(canonical(call.ready[name]), canonical(call.privateRoot));
    }
    assert.deepEqual(argv.slice(7), [...(modules ? ['--modules=' + modules.join(',')] : []), ...(instant ? ['--instant'] : [])]);
  }
  call.probe = await startProbe(context.probeBinary, call.ready.pid, join(call.directory, 'process'), context.pluginBinaries[pluginId]);
  assert.equal(call.probe.ready.target.state, 'running');
  assert.equal(call.probe.ready.parent.state, 'running');
  context.tool.calls.push(call);
  context.report.tools.push({ directory: call.directory, plugin_id: pluginId, ...call.ready,
    input: call.inputIdentity, private_json: call.privateJson, probe_ready: call.probe.ready });
  return call;
}

export async function release(call) {
  await writeFile(join(call.directory, 'release'), '1', { flag: 'wx' });
}

export async function finished(context, call, { cancelled = false } = {}) {
  let timeout;
  try {
    const evidence = await Promise.race([finishProbe(call.probe), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('APKS直接进程退出确认超时')), 8000);
    })]);
    assert.equal(evidence.exit.target.state, 'exited');
    assert.equal(evidence.exit.parent.state, 'exited');
    assert.equal(evidence.exit.parent.exit_code, 0);
    if (!cancelled) assert.equal(evidence.exit.target.exit_code, 0);
    context.report.tools.find(entry => entry.pid === call.ready.pid).process = evidence;
    if (call.privateRoot) await assert.rejects(lstat(call.privateRoot), { code: 'ENOENT' });
    await emptyScratch(context);
    return evidence;
  } finally { clearTimeout(timeout); }
}

export async function emptyScratch(context) {
  for (const root of Object.values(context.scratch)) assert.deepEqual(await readdir(root), [], '私有目录必须物理清理');
}
