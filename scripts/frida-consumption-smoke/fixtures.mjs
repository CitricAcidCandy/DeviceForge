import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../terminal-interactive-smoke/cases.mjs';

export const scriptBytes = Buffer.from('send({type:"notice",message:"授权样例"});\n', 'utf8');
export const serverBytes = Buffer.from('frida-server-fixture', 'ascii');
export const noticeBytes = Buffer.from('{"type":"notice","message":"observed"}\n');
export const processOutput = '[{"pid":123,"name":"中文应用"},{"pid":456,"name":"system_server"}]';

export async function prepareTools(directory) {
  await mkdir(directory, { recursive: true });
  const output = [
    'installed\n16.7.0\nPID 991\nPID 992\n',
    processOutput,
    'pushed\n',
    '16.7.0\n16.7.0\n',
    '',
    'OWNED 801 12345\n',
    'server output\nCLEAN\n',
    'console-message\n__DEVICEFORGE_NOTICE__{"type":"notice","message":"observed"}\n',
    '__DEVICEFORGE_HOOK__{"type":"installed","class":"android.hardware.Camera"}\n' +
      '__DEVICEFORGE_HOOK__{"type":"summary","installed":1,"missing":0}\n',
    processOutput,
    'cancelled fixture must not publish',
  ];
  for (const [offset, stdout] of output.entries()) {
    const index = offset + 1;
    await writeFile(join(directory, `stdout-${index}`), stdout);
    await writeFile(join(directory, `stderr-${index}`), '');
    await writeFile(join(directory, `code-${index}`), '0');
  }
}

export async function waitTool(directory, index) {
  const path = join(directory, `call-${String(index).padStart(2, '0')}`, 'ready');
  await poll(
    async () => {
      try {
        return (await readFile(path)).toString() === '1';
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    Boolean,
    `Frida真实工具${index}就绪`,
  );
}

export function argumentsFrom(bytes) {
  let offset = 0;
  const number = () => {
    assert.ok(offset + 4 <= bytes.length);
    const value = bytes.readUInt32LE(offset);
    offset += 4;
    return value;
  };
  const count = number();
  assert.ok(count <= 32);
  const values = [];
  for (let index = 0; index < count; index++) {
    const length = number();
    assert.ok(length <= 65536 && offset + length <= bytes.length);
    values.push(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length)),
    );
    offset += length;
  }
  assert.equal(offset, bytes.length);
  return values;
}

export async function verifyTools(directory, report) {
  const calls = (await readdir(directory)).filter((name) => /^call-\d\d$/.test(name)).sort();
  assert.equal(calls.length, 11);
  assert.equal(report.tools.length, 11);
  for (const [offset, name] of calls.entries()) {
    const path = join(directory, name),
      argv = argumentsFrom(await readFile(join(path, 'argv.bin')));
    assert.deepEqual(await readFile(join(path, 'restricted.bin')), Buffer.from([0, 0, 0]));
    const plannedExit = await readFile(join(path, 'normal-exit-code'), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (offset !== 10) assert.equal(plannedExit, '0');
    const actual = report.tools.find((value) => value.ordinal === offset + 1);
    assert.deepEqual(actual.argv, argv);
    assert.equal(actual.pid, Number(await readFile(join(path, 'pid'), 'utf8')));
    assert.equal(actual.os_handle_observed, true);
    assert.equal(actual.process.exit.target.state, 'exited');
    actual.normal_exit_plan = plannedExit;
  }
  assert.deepEqual(report.tools[1].argv, ['-D', 'device-1', '--json']);
  assert.deepEqual(report.tools[9].argv, ['-D', 'device-1', '--json']);
  assert.deepEqual(await readFile(join(directory, 'call-03/source.bin')), serverBytes);
  assert.deepEqual(await readFile(join(directory, 'call-08/script.js')), scriptBytes);
  assert.ok(
    (await readFile(join(directory, 'call-09/script.js'), 'utf8')).includes(
      'android.hardware.Camera',
    ),
  );
  for (const name of ['call-06', 'call-07']) {
    const stdin = await readFile(join(directory, name, 'stdin.bin'), 'utf8');
    assert.ok(stdin.includes('deviceforge-frida-run-'));
    assert.ok(!stdin.includes('pkill') && !stdin.includes('killall'));
  }
}
