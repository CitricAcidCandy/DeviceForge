import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export async function freezeFrontend(root, destination, report) {
  const sourceRoot = join(root, 'frontend'), visited = new Set(), identities = [];
  async function visit(path) {
    path = resolve(path); if (visited.has(path)) return; visited.add(path);
    assert.ok(visited.size <= 512, 'PROFILE-FRONTEND-MODULE-BOUND');
    const name = relative(sourceRoot, path); assert.ok(!name.startsWith('..'), 'PROFILE-FRONTEND-PATH-BOUND');
    const before = await fileIdentity(path), source = await readFile(path, 'utf8'), target = join(destination, name);
    await mkdir(dirname(target), { recursive: true }); await copyFile(path, target);
    const actual = await fileIdentity(target); assert.equal(actual.sha256, before.sha256); assert.equal(actual.bytes, before.bytes);
    assert.deepEqual(await fileIdentity(path), before, 'PROFILE-FRONTEND-SOURCE-DURING-FREEZE'); identities.push({ source: before, actual });
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) await visit(resolve(dirname(path), match[1]));
    }
  }
  await visit(join(sourceRoot, 'src/features/android-profile/index.ts'));
  report.frontend_snapshots = identities; return destination;
}
export async function actualFrontend(destination) {
  return import(pathToFileURL(join(destination, 'src/features/android-profile/index.ts')).href);
}
export async function verifyFrontend(report) {
  for (const { source, actual } of report.frontend_snapshots) {
    assert.deepEqual(await fileIdentity(source.path), source, 'PROFILE-FRONTEND-SOURCE-STABLE');
    assert.deepEqual(await fileIdentity(actual.path), actual, 'PROFILE-FRONTEND-SNAPSHOT-STABLE');
  }
}
