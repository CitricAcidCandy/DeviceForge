// 每项断言均经过公开 HTTP/MCP，不直接修改宿主安装数据库。
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { planPublication, publishRelease } from '../plugin-releases/publish.mjs';
import { writeZip } from '../plugin-releases/archive.mjs';
import { jsonBytes } from '../plugin-releases/pack.mjs';

export async function publish(fixture, market) {
  const plan = await planPublication({
    directory: fixture.directory,
    market: fixture.market,
    server: market.base,
  });
  await publishRelease(plan);
  return plan.summary.source;
}
export async function upload(host, fixture) {
  return host.call(`/api/v2/plugin-installations/artifacts?filename=${basename(fixture.archive)}`, {
    method: 'POST',
    status: 201,
    headers: { 'content-type': 'application/octet-stream' },
    body: createReadStream(fixture.archive),
  });
}
export async function inspect(
  host,
  fixture,
  release,
  { setting = '初始配置', value = '共享工具内容' } = {},
) {
  const result = await host.job(
    '/api/v2/jobs',
    { operation: `plugin.${fixture.serverId}.inspect`, input: {} },
    {
      headers: {
        'x-deviceforge-plugin-release': JSON.stringify({
          id: fixture.id,
          revision: release.revision,
        }),
      },
    },
  );
  assert.deepEqual(result.result, {
    version: fixture.version,
    value,
    configuration: setting,
    absolute: true,
  });
}
export async function asset(host, release) {
  const component = release.components.find((item) => item.kind === 'browser');
  assert.ok(component.entry_url.includes(`/revisions/${release.revision}/`));
  const response = await fetch(host.base + component.entry_url, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const bytes = await response.text();
  assert.ok(bytes.includes(`version:${JSON.stringify(release.version)}`));
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
}
export async function configuration(host, fixture, setting) {
  const path = `/api/v2/plugin-configurations/server/${fixture.serverId}`;
  const current = await host.call(path);
  const updated = await host.call(path, {
    method: 'PATCH',
    input: { expected_revision: current.revision, patch: { setting } },
  });
  assert.equal(updated.values.setting, setting);
}
export async function rpc(host, name, args = {}) {
  const response = await fetch(host.base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: host.base,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.equal(reply.result.isError, false, JSON.stringify(reply));
  return reply.result.structuredContent;
}
export async function stageEvents(host, id) {
  const events = await host.call(`/api/v2/jobs/${id}/events`);
  const stages = events.flatMap((event) => (event.progress ? [event.progress.stage] : []));
  for (const stage of [
    'preparing',
    'downloading',
    'verifying',
    'deploying',
    'activating',
    'complete',
  ])
    assert.ok(stages.includes(stage), `缺少安装阶段 ${stage}`);
  assert.ok(
    events.some(
      (event) => event.progress?.stage === 'downloading' && event.progress.completed_bytes > 0,
    ),
  );
  return stages;
}
export async function persistedConfiguration(user, fixture) {
  // 持久化原文件包含用户值，允许目录按修订组织，不依赖具体文件名。
  const { readdir } = await import('node:fs/promises');
  const root = `${user}/plugin-configurations/server`;
  const files = await readdir(root, { recursive: true });
  let found = false;
  for (const file of files.filter((item) => item.endsWith('.json'))) {
    const bytes = await readFile(`${root}/${file}`, 'utf8');
    if (bytes.includes('用户配置不丢失')) found = true;
  }
  assert.ok(found, `${fixture.id} 用户目录必须包含真实配置`);
}

export async function invalidOffline(host, fixture, report) {
  const original = JSON.parse(await readFile(join(fixture.directory, 'release.json'), 'utf8'));
  const cases = [
    [
      'digest',
      (manifest) => {
        manifest.tools[0].variants[0].sha256 = 'a'.repeat(64);
      },
      /SHA-256|摘要|digest/,
    ],
    [
      'missing',
      (manifest) => {
        manifest.tools[0].variants = [];
      },
      /依赖|工具|平台/,
    ],
    [
      'platform',
      (manifest) => {
        manifest.components[0].variants[0].platform = 'linux-arm64';
      },
      /平台|依赖/,
    ],
  ];
  report.negative = [];
  for (const [label, mutate, reason] of cases) {
    const manifest = structuredClone(original);
    mutate(manifest);
    const archive = join(fixture.directory, `invalid-${label}.zip`);
    const resources = new Map(
      [...original.components, ...original.tools]
        .flatMap((owner) => owner.variants)
        .map((variant) => [
          variant.path,
          { name: variant.path, path: join(fixture.directory, variant.path) },
        ]),
    );
    await writeZip(archive, [
      { name: 'release.json', bytes: jsonBytes(manifest) },
      ...resources.values(),
    ]);
    const artifact = await upload(host, { archive });
    const failed = await host.job(
      '/api/v2/plugin-installations',
      { source: { kind: 'offline', artifact_id: artifact.id } },
      { success: false },
    );
    assert.match(failed.error, reason, label);
    await host.call(`/api/v2/plugin-installations/${fixture.id}`, { status: 404 });
    report.negative.push({ label, job_id: failed.id, status: failed.status, error: failed.error });
  }
}
