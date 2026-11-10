import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import test from 'node:test';
import { HostError as compatibilityError } from '../src/plugin-sdk/index.ts';
import { HostError as packageError } from '@deviceforge/plugin-sdk';
import { sdkBrowserPackage, sdkRepositoryRoot } from '../scripts/sdk-repository.ts';

const frontend = resolve(import.meta.dirname, '..');

test('宿主只保留SDK薄兼容入口，与独立包共享同一错误类型', () => {
  assert.equal(compatibilityError, packageError);
  assert.ok(isAbsolute(sdkRepositoryRoot(frontend)));
  assert.equal(existsSync(resolve(frontend, 'sdk')), false);
  assert.equal(existsSync(resolve(frontend, 'plugin-tools')), false);
  assert.equal(existsSync(resolve(frontend, 'contracts')), false);
  const entry = readFileSync(resolve(frontend, 'src/plugin-sdk/index.ts'), 'utf8');
  assert.match(entry, /export \* from '@deviceforge\/plugin-sdk'/);
  assert.doesNotMatch(entry, /class HostError|interface HostContext/);
  for (const name of ['sdk', 'tools', 'contracts'] as const)
    assert.ok(existsSync(resolve(sdkBrowserPackage(frontend, name), 'package.json')));
});

test('显式独立SDK检出必须用绝对路径，不回退宿主内副本', () => {
  const original = process.env['DEVICEFORGE_SDK_ROOT'];
  try {
    process.env['DEVICEFORGE_SDK_ROOT'] = 'relative-sdk';
    assert.throws(() => sdkRepositoryRoot(frontend), /绝对路径/);
    const selected = resolve(frontend, '../../DeviceForge-SDK');
    process.env['DEVICEFORGE_SDK_ROOT'] = selected;
    assert.equal(sdkRepositoryRoot(frontend), selected);
  } finally {
    if (original === undefined) delete process.env['DEVICEFORGE_SDK_ROOT'];
    else process.env['DEVICEFORGE_SDK_ROOT'] = original;
  }
});
