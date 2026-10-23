// 真实工具供应插件读取受控空清单，验证替代来源门禁及宿主仓库；不执行设备或下载工具。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function supplySourceServer() {
  const manifest = Buffer.from(
    JSON.stringify({ manifestVersion: 'managed-source-1', modules: [] }),
  );
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/catalog.json') {
      response.writeHead(404).end();
      return;
    }
    requests++;
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': manifest.length,
    });
    response.end(manifest);
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  let stopped = false;
  return {
    url: `http://127.0.0.1:${server.address().port}/catalog.json`,
    manifest,
    count: () => requests,
    async stop() {
      if (stopped) return;
      stopped = true;
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

export async function verifySupplySource(host, temporary, phase, source, report) {
  const previousRequests = source.count();
  const release = await host.call('/api/v2/plugin-installations/tool-supply');
  assert.equal(release.status, 'configuration_required');
  const path = '/api/v2/plugin-configurations/server/tool-supply';
  const current = await host.call(path);
  const local = join(temporary, `${phase}-supplier-catalog.json`);
  await writeFile(local, source.manifest);
  const configuration = await host.call(path, {
    method: 'PATCH',
    input: {
      expected_revision: current.revision,
      patch: {
        repository_mode: 'managed',
        install_root: null,
        manifest_url: phase === 'online' ? source.url : null,
        local_manifest: phase === 'offline' ? local : null,
        allow_http: true,
      },
    },
  });
  assert.equal(configuration.compatible, true);
  assert.ok(
    configuration.values.install_root === null ||
      !Object.hasOwn(configuration.values, 'install_root'),
  );
  const enabled = await host.job(
    '/api/v2/plugin-installations/tool-supply/enabled',
    { expected_revision: release.revision, enabled: true },
    { method: 'PATCH' },
  );
  assert.equal(enabled.result.status, 'enabled');
  const catalog = await host.job('/api/v2/jobs', {
    operation: 'plugin.tool-supply.catalog',
    input: {},
  });
  assert.deepEqual(catalog.result.artifacts, []);
  const result = catalog.result.result;
  assert.equal(result.manifest_version, 'managed-source-1');
  assert.equal(result.source_error, null);
  assert.deepEqual(result.modules, []);
  if (phase === 'online') assert.ok(source.count() > 0);
  else assert.equal(source.count(), previousRequests, '本地清单不得访问远端来源');
  report.supply_source_checks ??= [];
  report.supply_source_checks.push({
    phase,
    source: phase === 'online' ? 'remote' : 'local',
    managed_root_unset: true,
    enabled: true,
    runtime_catalog: true,
    configuration_revision: configuration.revision,
    job_id: catalog.id,
  });
}
