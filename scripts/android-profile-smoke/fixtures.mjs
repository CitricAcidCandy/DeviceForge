import assert from 'node:assert/strict';
import { copyFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { canonicalMediaArgv } from './media-identity.mjs';
export { deviceId } from './probe-route.mjs';
export { packageName } from './protocol.mjs';
export function encodeArgv(args) {
  assert.ok(Array.isArray(args) && args.length <= 16);
  const parts = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(args.length);
  for (const arg of args) {
    const text = Buffer.from(arg);
    assert.ok(text.length <= 4096);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(text.length);
    parts.push(size, text);
  }
  return Buffer.concat(parts);
}
async function writeBytes(path, bytes) {
  const handle = await open(path, 'wx');
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes.subarray(offset, offset + 4096));
      assert.ok(result.bytesWritten > 0);
      offset += result.bytesWritten;
    }
  } finally {
    await handle.close();
  }
}
// 调用计划只允许固定argv和显式原字节；命令及身份样本由已冻结probe/record路由模块提供。
export async function prepareFixture(directory, binary, contract, report) {
  assert.equal(contract.frozen, true, 'PROFILE-OFFICIAL-ROUTE-NOT-FROZEN');
  assert.ok(
    Array.isArray(contract.cases) && contract.cases.length > 0 && contract.cases.length <= 16,
  );
  const root = join(directory, 'fixture');
  await mkdir(root);
  const adb = join(root, 'fake-adb.exe');
  await copyFile(binary, adb);
  assert.equal((await fileIdentity(binary)).sha256, (await fileIdentity(adb)).sha256);
  const commands = [...contract.shared, ...contract.cases.flatMap((value) => value.commands)];
  for (const scenario of contract.cases) {
    assert.match(scenario.id, /^[a-z][a-z0-9-]{0,47}$/);
    const folder = join(root, 'inputs', scenario.id);
    await mkdir(folder, { recursive: true });
    const specs = [...contract.shared, ...scenario.commands];
    assert.ok(specs.length <= 64);
    const unique = new Set();
    for (const [index, spec] of specs.entries()) {
      const key = encodeArgv(spec.argv).toString('hex');
      assert.ok(!unique.has(key), 'PROFILE-FIXTURE-ARGV-UNIQUE');
      unique.add(key);
      assert.match(spec.category, /^[a-z][a-z0-9-]{0,47}$/);
      assert.ok(spec.outputs.length > 0 && spec.outputs.length <= 64);
      const target = join(folder, 'spec-' + String(index + 1).padStart(3, '0'));
      await mkdir(target);
      await writeBytes(join(target, 'argv.bin'), encodeArgv(spec.argv));
      await writeFile(join(target, 'category'), spec.category, { flag: 'wx' });
      for (const [number, value] of spec.outputs.entries()) {
        assert.ok(
          value && Number.isSafeInteger(value.exit) && value.exit >= 0 && value.exit <= 125,
        );
        const suffix = String(number + 1).padStart(3, '0');
        const bytes = Buffer.from(value.stdout),
          errors = Buffer.from(value.stderr);
        assert.ok(bytes.length <= 1024 * 1024 && errors.length <= 65536);
        await writeBytes(join(target, 'stdout-' + suffix + '.bin'), bytes);
        await writeBytes(join(target, 'stderr-' + suffix + '.bin'), errors);
        await writeFile(join(target, 'exit-' + suffix + '.txt'), String(value.exit), {
          flag: 'wx',
        });
      }
    }
  }
  await writeFile(join(root, 'mode'), contract.cases[0].id, { flag: 'wx' });
  report.fixture = {
    root,
    executable: await fileIdentity(adb),
    mode_count: contract.cases.length,
    command_spec_count: commands.length,
    source: contract.source,
    route: contract.route,
    schema: contract.schema,
  };
  return { root, adb, cases: contract.cases, shared: contract.shared };
}
export async function setMode(fixture, mode) {
  assert.ok(fixture.cases.some((value) => value.id === mode));
  const pending = join(fixture.root, 'mode.tmp');
  await writeFile(pending, mode);
  await rename(pending, join(fixture.root, 'mode'));
}
export async function verifyFixture(fixture, report) {
  assert.deepEqual(await fileIdentity(fixture.adb), report.fixture.executable);
}

// 只替换已经核定的小写SHA256目录token；其余脚本须完整匹配固定计划。
export function canonicalArgv(args, fixture, mode) {
  const prefix = '/data/local/tmp/deviceforge-profile-',
    tokens = new Set();
  for (const arg of args) {
    let cursor = 0;
    while (true) {
      const found = arg.indexOf(prefix, cursor);
      if (found < 0) break;
      const begin = found + prefix.length,
        token = arg.slice(begin, begin + 64);
      assert.match(token, /^[a-f0-9]{64}$/, 'PROFILE-REMOTE-TOKEN');
      tokens.add(token);
      cursor = begin + 64;
    }
  }
  if (!tokens.size) return canonicalMediaArgv(args, fixture, mode);
  assert.equal(tokens.size, 1, 'PROFILE-REMOTE-SAME-TOKEN');
  const token = [...tokens][0];
  fixture.remoteTokens ??= new Map();
  if (fixture.remoteTokens.has(mode))
    assert.equal(token, fixture.remoteTokens.get(mode), 'PROFILE-REMOTE-FIXED-TOKEN');
  else fixture.remoteTokens.set(mode, token);
  return canonicalMediaArgv(
    args.map((arg) => arg.replaceAll(token, '@TOKEN@')),
    fixture,
    mode,
  );
}
