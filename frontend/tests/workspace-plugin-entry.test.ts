import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspacePluginEntry } from '../scripts/workspace-plugin-entry.ts';

test('发行入口转发真实身份，样式先就绪且失败时释放，不引入导入副作用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-plugin-entry-'));
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(join(root, 'index.js'), `export default async (identity) => ({ ...identity, panels: [],
      async activate(context) { context.ready(); throw new Error('真实激活失败'); } });`);
    await writeFile(join(root, 'styles.js'), `let active = 0;
      export const snapshot = () => active;
      export function acquireStyles() { active++; let released = false; return () => { if (!released) { released = true; active--; } }; }`);
    await writeFile(join(root, 'entry.js'), workspacePluginEntry());
    const entry = await import(pathToFileURL(join(root, 'entry.js')).href);
    const styles = await import(pathToFileURL(join(root, 'styles.js')).href);
    assert.equal(styles.snapshot(), 0);
    const plugin = await entry.default({ id: 'fixture', version: '1.0.0', apiVersion: 2 });
    assert.equal(plugin.id, 'fixture');
    const disposers: (() => void)[] = [];
    await assert.rejects(plugin.activate({ signal: new AbortController().signal,
      onDispose: (dispose: () => void) => { disposers.push(dispose); return dispose; },
      ready: () => assert.equal(styles.snapshot(), 1),
    }), /真实激活失败/);
    assert.equal(styles.snapshot(), 0);
    for (const dispose of disposers) dispose();
    assert.equal(styles.snapshot(), 0);
    await assert.rejects(plugin.activate({ signal: AbortSignal.abort(), onDispose: () => assert.fail() }));
    assert.equal(styles.snapshot(), 0);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
