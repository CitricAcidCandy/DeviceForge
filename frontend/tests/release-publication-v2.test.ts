import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { ApiError } from '../src/services/api/index.ts';
import { createMarketplace } from '../src/features/marketplace/index.ts';
import type { MarketplacePublishEntry } from '../src/features/marketplace/index.ts';
import { prepareReleasePublication, publishReleasePublication } from '../src/pages/marketplace/release-publication/index.ts';
import type { ReleasePublicationPlan } from '../src/pages/marketplace/release-publication/index.ts';
import { parseReleaseManifest } from '../src/pages/marketplace/release-publication/manifest.ts';
import { digestBytes } from '../src/pages/marketplace/release-publication/resource.ts';
import { signal } from './fixtures.ts';

const componentBytes = strToU8('浏览器组件归档');
const toolBytes = strToU8('旧版工具归档');
const dependencyBytes = strToU8('新版依赖归档');
function source(kind: 'market' | 'official' = 'market', url = 'dependencies/tool.zip') {
  return { kind, url, platform: 'any', version: '1.0.0', sha256: digestBytes(dependencyBytes), size: dependencyBytes.length,
    format: 'zip', entries: { executable: 'bin/tool' } };
}
function declaration(sources = [source()]) {
  return { id: 'helper', name: '辅助工具', version_requirement: '>=1.0.0', entries: ['executable'], sources,
    discovery: [{ kind: 'environment', value: 'HELPER_HOME', entries: { executable: 'bin/tool' } }],
    probe: { entry: 'executable', args: ['--version'], pattern: '(\\d+\\.\\d+\\.\\d+)', timeout_ms: 3000 },
    bindings: [{ component_id: 'component', config_pointer: '/helper', entry: 'executable' }] };
}
function manifest(dependencies: unknown = { format_version: 1, dependencies: [declaration()] }) {
  return { format_version: 2, host_api_version: 2, id: 'full-release', version: '1.0.0', name: '完整发布', description: '第二版依赖声明',
    components: [{ id: 'component', kind: 'browser', version: '1.0.0', variants: [{ platform: 'any', path: 'components/web.zip',
      sha256: digestBytes(componentBytes), size: componentBytes.length, format: 'zip' }] }],
    tools: [{ id: 'legacy', version: '1.0.0', required: true, variants: [{ platform: 'any', path: 'tools/legacy.zip',
      sha256: digestBytes(toolBytes), size: toolBytes.length, format: 'zip', entries: { tool: 'bin/tool' } }], bindings: [] }],
    dependencies };
}
function archive(value: unknown, includeDependency = true, dependencyPath = 'dependencies/tool.zip'): File {
  return new File([new Uint8Array(zipSync({ 'release.json': strToU8(JSON.stringify(value)),
    'components/web.zip': componentBytes, 'tools/legacy.zip': toolBytes,
    ...(includeDependency ? { [dependencyPath]: dependencyBytes } : {}),
  }, { level: 0 }))], 'release.zip');
}
function metadata(plan: ReleasePublicationPlan): MarketplacePublishEntry {
  return { metadata_version: 1, id: plan.manifest.id, version: plan.manifest.version, name: plan.manifest.name,
    description: plan.manifest.description, summary: '完整功能发布', kind: 'plugin', resource_id: plan.manifestSha256,
    keywords: [], categories: ['function'], applies_to: ['deviceforge'], supports_mcp: 'none', supports_agent: false,
    restart_policy: 'none', platforms: [], architectures: [], details: {} };
}
const capabilities = { api_version: 1, release_publication: { format_versions: [1, 2], host_api_versions: [2],
  resource_max_bytes: 2 ** 31, catalog_last: true, immutable_versions: true } };

test('第二版保留旧 tools 闭包，内嵌市场依赖按实际字节核对并仅替换 market URL', async () => {
  const official = source('official', 'https://official.example/tool.zip?version=1.0.0');
  const plan = await prepareReleasePublication(archive(manifest({ format_version: 1,
    dependencies: [declaration([source(), official])] })), signal());
  assert.equal(plan.resources.length, 3);
  const online = parseReleaseManifest(new Uint8Array(await plan.manifestBlob.arrayBuffer()));
  assert.equal(online.tools[0]?.variants[0]?.path, digestBytes(toolBytes));
  assert.equal(online.dependencies?.dependencies[0]?.sources[0]?.url, digestBytes(dependencyBytes));
  assert.equal(online.dependencies?.dependencies[0]?.sources[1]?.url, official.url);
  assert.equal(plan.manifest.dependencies?.dependencies[0]?.sources[0]?.url, 'dependencies/tool.zip');
});

test('官方 HTTPS 来源只保留完整元数据，无来源依赖只发现，不要求内嵌第三方原包', async () => {
  for (const sources of [[], [source('official', 'https://official.example/tool.zip')]]) {
    const plan = await prepareReleasePublication(archive(manifest({ format_version: 1,
      dependencies: [declaration(sources)] }), false), signal());
    assert.equal(plan.resources.length, 2);
    assert.equal(plan.remoteResources?.length, 0);
    assert.equal(plan.manifest.dependencies?.dependencies[0]?.sources.length, sources.length);
  }
});

test('打包器的 blobs 摘要入口优先核验 ZIP 内原包，不误判为仅能复用远端；损坏原包不降级远端', async () => {
  const digest = digestBytes(dependencyBytes);
  for (const path of [digest, `blobs/${digest}`]) {
    const plan = await prepareReleasePublication(archive(manifest({ format_version: 1,
      dependencies: [declaration([source('market', path)])] }), true, path), signal());
    assert.equal(plan.resources.length, 3);
    assert.equal(plan.remoteResources?.length, 0);
    const resource = plan.resources.find((item) => item.sha256 === digest);
    assert.ok(resource);
    assert.deepEqual(new Uint8Array(await resource.blob.arrayBuffer()), dependencyBytes);
    const online = parseReleaseManifest(new Uint8Array(await plan.manifestBlob.arrayBuffer()));
    assert.equal(online.dependencies?.dependencies[0]?.sources[0]?.url, digest);
    assert.deepEqual(online.dependencies?.dependencies[0]?.sources[0]?.entries, { executable: 'bin/tool' });
  }
  const wrong = 'f'.repeat(64), path = `blobs/${wrong}`;
  await assert.rejects(prepareReleasePublication(archive(manifest({ format_version: 1,
    dependencies: [declaration([{ ...source('market', path), sha256: wrong }])] }), true, path), signal()), /SHA-256 不一致/);
});

test('远端市场摘要先 HEAD 验闭包，缺失时零写入，不能从另一市场地址抓包', async () => {
  const digest = digestBytes(dependencyBytes);
  for (const url of [digest, `blobs/${digest}`, `https://other.example/api/v1/resources/${digest}`]) {
    const plan = await prepareReleasePublication(archive(manifest({ format_version: 1,
      dependencies: [declaration([source('market', url)])] }), false), signal());
    assert.equal(plan.resources.length, 2);
    assert.equal(plan.remoteResources?.length, 1);
    const requests: string[] = [];
    const market = createMarketplace(async (input, init) => {
      const parsed = new URL(String(input));
      assert.equal(parsed.origin, 'http://127.0.0.1:7040');
      requests.push(`${init?.method ?? 'GET'} ${parsed.pathname}`);
      if (parsed.pathname.endsWith('/capabilities')) return Response.json(capabilities);
      return new Response(null, { status: 404 });
    });
    await assert.rejects(publishReleasePublication(plan, metadata(plan), market, signal()), /缺少依赖摘要资源/);
    assert.deepEqual(requests, ['GET /api/v1/capabilities', `HEAD /api/v1/resources/${digest}`]);
  }
});

test('第二版真实发布按能力、远端摘要、资源、清单、目录顺序推进且官方地址零请求', async () => {
  const digest = digestBytes(dependencyBytes);
  const plan = await prepareReleasePublication(archive(manifest({ format_version: 1,
    dependencies: [declaration([source('market', digest), source('official', 'https://official.example/tool.zip')])] }), false), signal());
  const writes: string[] = [], reads: string[] = [];
  const market = createMarketplace(async (input, init) => {
    const path = new URL(String(input)).pathname;
    assert.equal(new URL(String(input)).host, '127.0.0.1:7040');
    if (path.endsWith('/capabilities')) return Response.json(capabilities);
    if (init?.method === 'HEAD') {
      reads.push(path);
      return path.endsWith(digest) ? new Response(null, { headers: { etag: `"${digest}"`, 'content-length': String(dependencyBytes.length) } }) : new Response(null, { status: 404 });
    }
    writes.push(path);
    if (path.endsWith('/catalog')) {
      assert.ok(typeof init?.body === 'string');
      const entry: unknown = JSON.parse(init.body);
      assert.ok(entry && typeof entry === 'object' && 'details' in entry);
      return Response.json(entry);
    }
    assert.ok(init?.body instanceof Blob);
    const uploadedDigest = digestBytes(new Uint8Array(await init.body.arrayBuffer()));
    return Response.json({ id: uploadedDigest, sha256: uploadedDigest, size: init.body.size, filename: '资源', kind: 'resource', media_type: 'application/octet-stream' });
  });
  const result = await publishReleasePublication(plan, metadata(plan), market, signal());
  assert.equal(reads[0], `/api/v1/resources/${digest}`);
  assert.deepEqual(writes, ['/api/v1/resources', '/api/v1/resources', '/api/v1/resources', '/api/v1/catalog']);
  assert.equal(result.resourceCount, 3);
  assert.equal(result.reusedCount, 1);
});

test('第一版清单不向只支持第二版市场写入，第二版也不向旧市场写入', async () => {
  const plans = [await prepareReleasePublication(archive({ ...manifest(), format_version: 1, dependencies: undefined }), signal()),
    await prepareReleasePublication(archive(manifest()), signal())];
  for (const plan of plans) {
    let writes = 0;
    const market = createMarketplace(async (_, init) => {
      if (init?.method === 'POST') ++writes;
      return Response.json({ ...capabilities, release_publication: { ...capabilities.release_publication,
        format_versions: [plan.manifest.format_version === 1 ? 2 : 1] } });
    });
    await assert.rejects(publishReleasePublication(plan, metadata(plan), market, signal()),
      (error: unknown) => error instanceof ApiError && error.code === 'marketplace_upgrade_required');
    assert.equal(writes, 0);
  }
});

test('第二版拒绝不安全官方来源、缺失本地包、未知字段、错误绑定、配套循环', async () => {
  for (const url of ['http://official.example/tool.zip', 'https://user:secret@official.example/tool.zip', 'https://official.example/tool.zip#fragment'])
    await assert.rejects(prepareReleasePublication(archive(manifest({ format_version: 1,
      dependencies: [declaration([source('official', url)])] }), false), signal()));
  await assert.rejects(prepareReleasePublication(archive(manifest(), false), signal()), /资源缺失/);
  const invalid: unknown[] = [
    { ...declaration(), unknown: true }, { ...declaration(), requires: ['helper'] },
    { ...declaration(), requires: ['missing'] }, { ...declaration(), bindings: [{ component_id: 'missing', config_pointer: '/tool', entry: 'executable' }] },
    { ...declaration(), sources: [{ ...source(), entries: {} }] },
  ];
  for (const value of invalid) await assert.rejects(prepareReleasePublication(archive(manifest({ format_version: 1, dependencies: [value] })), signal()));
  await assert.rejects(prepareReleasePublication(archive({ ...manifest(), format_version: 1 }), signal()), /发布格式第二版/);
});

test('依赖公开标识与后端一致：数字可开头、99字节可用，拒绝大写、100字节、保留前缀和前导符号', () => {
  function parse(value: unknown) { return parseReleaseManifest(strToU8(JSON.stringify(manifest({ format_version: 1, dependencies: [value] })))); }
  for (const id of ['0helper', 'a'.repeat(99)]) assert.equal(parse({ ...declaration([]), id }).dependencies?.dependencies[0]?.id, id);
  for (const id of ['Atool', 'a'.repeat(100), 'builtin.tool', '_tool', '-tool', '.tool']) {
    for (const value of [{ ...declaration([]), id }, { ...declaration([]), entries: [id] },
      { ...declaration([]), requires: [id] },
      { ...declaration([]), bindings: [{ component_id: id, config_pointer: '/tool', entry: 'executable' }] }])
      assert.throws(() => parse(value), /依赖标识/);
  }
});
