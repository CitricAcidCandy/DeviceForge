import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export async function freezeFrontend(root, destination, report) {
  const sourceRoot = join(root, 'frontend'), visited = new Set(), identities = [];
  async function visit(path) {
    path = resolve(path); if (visited.has(path)) return; visited.add(path);
    assert.ok(visited.size <= 256); const name = relative(sourceRoot, path); assert.ok(!name.startsWith('..'));
    const source = await readFile(path, 'utf8'), target = join(destination, name);
    await mkdir(dirname(target), { recursive: true }); await copyFile(path, target);
    const before = await fileIdentity(path), actual = await fileIdentity(target); assert.equal(actual.sha256, before.sha256);
    identities.push({ source: before, actual });
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) await visit(resolve(dirname(path), match[1]));
    }
  }
  await visit(join(sourceRoot, 'src/features/performance/index.ts'));
  await visit(join(sourceRoot, 'src/shared/api/client.ts'));
  report.frontend_snapshots = identities; return destination;
}
export async function actualFrontend(host, report, root) {
  const { createApiClient } = await import(pathToFileURL(join(root, 'src/shared/api/client.ts')).href);
  const { createHttpPerformance } = await import(pathToFileURL(join(root, 'src/features/performance/index.ts')).href);
  const client = createApiClient({ baseUrl: host.client.base, transport: async (input, options) => {
    const response = await fetch(input, options), logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId, /^[a-f\d-]{36}$/); host.client.logIds.add(logId);
    const url = new URL(input instanceof Request ? input.url : String(input));
    report.requests.push({ client_method: '实际性能前端工厂', path: url.pathname + url.search,
      method: options?.method ?? 'GET', status: response.status, log_id: logId });
    return response;
  } });
  return createHttpPerformance(client, { pollIntervalMs: 25 });
}
export async function verifyFrontend(report) {
  for (const { source, actual } of report.frontend_snapshots) {
    assert.deepEqual(await fileIdentity(source.path), source); assert.deepEqual(await fileIdentity(actual.path), actual);
  }
}
