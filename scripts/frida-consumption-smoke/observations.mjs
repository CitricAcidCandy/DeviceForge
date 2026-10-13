import assert from 'node:assert/strict';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep, toNamespacedPath } from 'node:path';
import { startProbe, finishProbe, finishPendingProbes } from '../harmony-screenshot-smoke/fixtures.mjs';
import { serverBytes, scriptBytes, waitTool, argumentsFrom } from './fixtures.mjs';
import { remoteServer, rootFrame, statusScript } from './contracts.mjs';

export { finishPendingProbes };
const canonical = value => toNamespacedPath(resolve(value)).toLowerCase();

export async function beginTool(context, ordinal) {
  await waitTool(context.tools, ordinal);
  const directory = join(context.tools, 'call-' + String(ordinal).padStart(2, '0'));
  const pid = Number(await readFile(join(directory, 'pid'), 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const probe = await startProbe(context.probeBinary, pid, join(directory, 'process'), context.pluginBinary);
  assert.equal(canonical(probe.ready.target.exe), canonical(context.toolBinary));
  assert.equal(probe.ready.target.state, 'running');
  assert.equal(probe.ready.parent.state, 'running');
  const argv = argumentsFrom(await readFile(join(directory, 'argv.bin')));
  assert.deepEqual(await readFile(join(directory, 'restricted.bin')), Buffer.from([0, 0, 0]));
  const stdin = await readFile(join(directory, 'stdin.bin'));
  const entry = { ordinal, directory, argv, pid, probe_ready: probe.ready, restricted_flags: [0, 0, 0], os_handle_observed: true };
  const call = { ordinal, directory, probe, entry };
  context.calls.push(call);
  context.report.tools.push(entry);
  if ([1, 4, 5, 6, 7].includes(ordinal)) {
    assert.deepEqual(argv, ['-s', 'device-1', 'shell', 'sh']);
    assert.ok(!stdin.includes(Buffer.from('pkill')) && !stdin.includes(Buffer.from('killall')));
    if (ordinal === 1) assert.deepEqual(stdin, Buffer.from(rootFrame(statusScript)));
    else assert.ok(stdin.toString('utf8').startsWith("su -c '"));
  } else if ([2, 10].includes(ordinal)) {
    assert.deepEqual(argv, ['-D', 'device-1', '--json']);
    assert.equal(stdin.length, 0);
  } else if (ordinal === 3) {
    assert.equal(argv.length, 5);
    assert.deepEqual(argv.slice(0, 3), ['-s', 'device-1', 'push']);
    assert.equal(basename(argv[3]), 'server.bin');
    assert.match(argv[4], /^\/data\/local\/tmp\/deviceforge-frida-upload-\d+-\d+$/);
    assert.equal(Number(argv[4].split('-').at(-2)), probe.ready.parent.pid);
    assert.deepEqual(await readFile(argv[3]), serverBytes);
    assert.deepEqual(await readFile(join(directory, 'source.bin')), serverBytes);
    call.privateRoot = dirname(argv[3]);
    context.uploadedPath = argv[4];
    assert.equal(stdin.length, 0);
  } else {
    assert.deepEqual(argv.slice(0, 5), ['-D', 'device-1', ordinal === 9 ? '-n' : '-f', 'com.example.app', '-l']);
    assert.equal(argv.length, 10);
    assert.deepEqual(argv.slice(6), ['-q', '--timeout', ordinal === 8 ? '2' : ordinal === 9 ? '1' : '120', '--exit-on-error']);
    assert.equal(basename(argv[5]), ordinal === 9 ? 'permissions.js' : 'script.js');
    const expected = ordinal === 9 ? context.permissionBytes : scriptBytes;
    assert.deepEqual(await readFile(argv[5]), expected);
    assert.deepEqual(await readFile(join(directory, 'script.js')), expected);
    assert.equal(stdin.length, 0);
    call.privateRoot = dirname(argv[5]);
    for (const name of ['cwd', 'TEMP', 'TMP', 'TMPDIR']) {
      assert.equal(canonical(await readFile(join(directory, name), 'utf8')), canonical(call.privateRoot));
    }
  }
  if (call.privateRoot) {
    assert.ok(isAbsolute(call.privateRoot));
    assert.ok(canonical(call.privateRoot).startsWith(canonical(context.scratch) + sep));
  }
  await verifyShell(context, ordinal, stdin.toString('utf8'), probe.ready.parent.pid);
  return call;
}

export async function releaseTool(context, call) {
  await writeFile(join(context.tools, 'release-' + call.ordinal), '1', { flag: 'wx' });
}

async function verifyShell(context, ordinal, frame, parentPid) {
  if (ordinal === 4) {
    const path = remoteServer, staged = context.uploadedPath;
    const script = "set -e\nid -u | grep -qx 0\n[ ! -L '" + path + "' ]\n[ ! -e '" + path + "' ] || [ -f '" + path + "' ]\nchmod 700 '" + staged + "'\n'" + staged + "' --version\ncp '" + staged + "' '" + path + "'\nchmod 700 '" + path + "'\n'" + path + "' --version\n";
    assert.equal(frame, rootFrame(script));
  } else if (ordinal === 5) {
    assert.equal(frame, rootFrame("rm -f '" + context.uploadedPath + "'\n[ ! -e '" + context.uploadedPath + "' ]"));
  } else if ([6, 7].includes(ordinal)) {
    assert.ok(frame.startsWith("su -c '") && frame.endsWith("'\n"));
    const body = frame.slice(7, -2).replaceAll("'\\''", "'");
    assert.equal(rootFrame(body), frame);
    const paths = [...new Set([...body.matchAll(/\/data\/local\/tmp\/deviceforge-frida-run-\d+-\d+/g)].map(value => value[0]))];
    assert.equal(paths.length, 1);
    const directory = paths[0];
    assert.equal(Number(directory.split('-').at(-2)), parentPid);
    if (ordinal === 6) {
      context.runPath = directory;
      for (const clause of ["mkdir '" + directory + "'", "mkdir '" + directory + "/lock'", 'sleep 3 &',
        "record \"$p\" '" + directory + "/server.identity'", "record \"$timer\" '" + directory + "/timer.identity'",
        "record \"$watch\" '" + directory + "/watch.identity'", 'shift 19', '[ "$1" != "$start" ] || kill "$p"']) assert.ok(body.includes(clause));
    } else {
      assert.equal(directory, context.runPath);
      for (const clause of ["stop '" + directory + "/timer.identity'", "stop '" + directory + "/watch.identity'",
        "stop '" + directory + "/server.identity'", '[ "$p" -gt 1 ] && [ "$start" -gt 0 ] || exit 72',
        '[ "$(readlink /proc/$p/exe)" = "$exe" ] || exit 73', 'kill -9 "$p"', "rmdir '" + directory + "'", 'echo CLEAN']) assert.ok(body.includes(clause));
    }
  }
}

export async function finishTools(context, calls, cancelled = false) {
  let timer;
  try {
    const values = await Promise.race([Promise.all(calls.map(call => finishProbe(call.probe))), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Frida直接父子实际退出确认超时')), 8000);
    })]);
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index], observed = values[index];
      assert.equal(observed.exit.target.state, 'exited');
      assert.equal(observed.exit.parent.state, 'exited');
      assert.equal(observed.exit.parent.exit_code, 0);
      if (cancelled) assert.notEqual(observed.exit.target.exit_code, 0);
      else assert.equal(observed.exit.target.exit_code, 0);
      call.entry.process = observed;
      if (call.privateRoot) await assert.rejects(lstat(call.privateRoot), { code: 'ENOENT' });
    }
    assert.deepEqual(await readdir(context.scratch), []);
  } finally { clearTimeout(timer); }
}
