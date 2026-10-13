import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareInputBase } from './inputs.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)), args = process.argv.slice(2);
const values = new Map();
for (const argument of args) {
  const separator = argument.indexOf('=');
  const name = argument.slice(0, separator), value = argument.slice(separator + 1);
  assert.ok(['--sdk-package', '--fixture-root', '--probe-binary'].includes(name) && !values.has(name));
  assert.ok(separator > 0 && isAbsolute(value)); values.set(name, resolve(value));
}
for (const name of ['--sdk-package', '--fixture-root', '--probe-binary']) assert.ok(values.has(name));
assert.equal(process.platform, 'win32'); assert.equal(process.version, 'v24.14.0');
const directory = join(root, 'artifacts', 'ai-sdk-inputs-' + randomUUID());
const manifest = await prepareInputBase({ root, directory, sdkRoot: values.get('--sdk-package'),
  fixtureRoot: values.get('--fixture-root'), probeBinary: values.get('--probe-binary') });
console.log(JSON.stringify({ directory, members: manifest.sources.length, host_and_plugin_pending: true }));
