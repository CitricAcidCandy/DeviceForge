import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { tree } from './inputs.mjs';

const values = new Map();
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf('='),
    name = argument.slice(0, separator),
    value = argument.slice(separator + 1);
  assert.ok(
    ['--frozen-input', '--plugin-snapshot', '--host-binary'].includes(name) && !values.has(name),
  );
  assert.ok(separator > 0 && isAbsolute(value));
  values.set(name, resolve(value));
}
assert.ok(
  values.has('--frozen-input') && (values.has('--plugin-snapshot') || values.has('--host-binary')),
);
const directory = values.get('--frozen-input'),
  manifestPath = join(directory, 'source-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.format_version, 1);
manifest.production_stages ??= [];
const copy = async (source, target) => {
  const before = await fileIdentity(source);
  try {
    await lstat(target);
    assert.fail('正式冻结材料不得覆盖已有目标');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  const actual = await fileIdentity(target),
    after = await fileIdentity(source);
  assert.deepEqual(before, after);
  assert.equal(actual.sha256, before.sha256);
  assert.equal(actual.bytes, before.bytes);
  return { original: before, actual };
};
if (values.has('--plugin-snapshot')) {
  const snapshot = values.get('--plugin-snapshot'),
    before = await tree(join(snapshot, 'plugin')),
    copied = [];
  for (const entry of before)
    copied.push(await copy(entry.path, join(directory, 'plugin', entry.relative_path)));
  const after = await tree(join(snapshot, 'plugin'));
  assert.deepEqual(after, before);
  copied.push(
    await copy(join(snapshot, 'identity.json'), join(directory, 'plugin-freeze-identity.json')),
  );
  manifest.production_stages.push({
    frozen_at: new Date().toISOString(),
    kind: 'plugin',
    snapshot,
    copied,
  });
}
if (values.has('--host-binary')) {
  const copied = await copy(values.get('--host-binary'), join(directory, 'apk-server.exe'));
  manifest.production_stages.push({
    frozen_at: new Date().toISOString(),
    kind: 'host',
    copied: [copied],
  });
}
const staged = new Set(manifest.production_stages.map((entry) => entry.kind));
manifest.host_and_plugin_pending = !(staged.has('host') && staged.has('plugin'));
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  JSON.stringify({
    directory,
    staged: [...staged],
    host_and_plugin_pending: manifest.host_and_plugin_pending,
  }),
);
