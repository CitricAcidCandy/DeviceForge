import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { createMarketplace } from '../src/features/marketplace/index.ts';
import type { MarketplacePublishEntry } from '../src/features/marketplace/index.ts';
import {
  prepareReleasePublication,
  publishReleasePublication,
} from '../src/pages/marketplace/release-publication/index.ts';
import type { ReleasePublicationPlan } from '../src/pages/marketplace/release-publication/index.ts';
import { digestBytes } from '../src/pages/marketplace/release-publication/resource.ts';

function fixture(corrupt = false, compressed = false) {
  const bytes = strToU8('实际组件归档字节');
  const sha256 = digestBytes(bytes);
  const manifest = {
    format_version: 1,
    host_api_version: 2,
    id: 'example-release',
    version: '1.0.0',
    name: '示例功能',
    description: '共享同一实际资源',
    components: ['one', 'two'].map((id) => ({
      id,
      kind: 'browser',
      version: '1.0.0',
      variants: [
        {
          platform: 'any',
          path: `components/${id}.zip`,
          format: 'zip',
          sha256,
          size: bytes.length,
        },
      ],
    })),
    tools: [],
  };
  const content = zipSync(
    {
      'release.json': strToU8(JSON.stringify(manifest)),
      'components/one.zip': corrupt ? new Uint8Array(bytes.length) : bytes,
      'components/two.zip': bytes,
    },
    { level: compressed ? 6 : 0 },
  );
  return new File([new Uint8Array(content)], '完整插件.zip', { type: 'application/zip' });
}

function metadata(plan: ReleasePublicationPlan): MarketplacePublishEntry {
  return {
    metadata_version: 1,
    kind: 'plugin',
    id: plan.manifest.id,
    version: plan.manifest.version,
    name: plan.manifest.name,
    description: plan.manifest.description,
    resource_id: plan.manifestSha256,
    summary: '完整功能插件示例',
    keywords: [],
    categories: ['function'],
    applies_to: ['deviceforge'],
    supports_mcp: 'none',
    supports_agent: false,
    restart_policy: 'none',
    platforms: [],
    architectures: [],
    details: {},
  };
}

const capabilities = {
  api_version: 1,
  release_publication: {
    format_versions: [1],
    host_api_versions: [2],
    resource_max_bytes: 2_147_483_648,
    catalog_last: true,
    immutable_versions: true,
  },
};
const signal = () => new AbortController().signal;

test('完整发布检查原样与压缩 ZIP 的实际字节，按摘要去重并改写在线引用', async () => {
  for (const compressed of [false, true]) {
    const plan = await prepareReleasePublication(fixture(false, compressed), signal());
    assert.equal(plan.resources.length, 1);
    assert.equal(plan.totalResourceBytes, plan.resources[0]?.size);
    const online: unknown = JSON.parse(await plan.manifestBlob.text());
    assert.ok(online && typeof online === 'object' && 'components' in online);
    assert.equal(
      digestBytes(new Uint8Array(await plan.manifestBlob.arrayBuffer())),
      plan.manifestSha256,
    );
    assert.match(
      await plan.manifestBlob.text(),
      new RegExp(`"path": "${plan.resources[0]?.sha256}"`),
    );
    assert.equal(plan.manifest.components[0]?.variants[0]?.path, 'components/one.zip');
  }
  await assert.rejects(prepareReleasePublication(fixture(true), signal()), /SHA-256 不一致/);
});

test('真实客户端按固定来源探测、上传资源与清单，最后仅提交一个目录条目', async () => {
  const plan = await prepareReleasePublication(fixture(), signal());
  const calls: string[] = [];
  const market = createMarketplace(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://fixed.example');
    const call = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push(call);
    if (url.pathname.endsWith('/capabilities')) {
      market.setUrl('http://changed.example');
      return Response.json(capabilities);
    }
    if (init?.method === 'HEAD') return new Response(null, { status: 404 });
    if (url.pathname.endsWith('/resources')) {
      assert.ok(init?.body instanceof Blob);
      const bytes = new Uint8Array(await init.body.arrayBuffer());
      const digest = digestBytes(bytes);
      return Response.json({
        id: digest,
        sha256: digest,
        size: bytes.length,
        filename: '资源',
        kind: 'resource',
        media_type: 'application/octet-stream',
      });
    }
    assert.equal(call, 'POST /api/v1/catalog');
    assert.ok(init && typeof init.body === 'string');
    return new Response(init.body, { headers: { 'content-type': 'application/json' } });
  });
  market.setUrl('http://fixed.example');
  const result = await publishReleasePublication(plan, metadata(plan), market, signal());
  assert.equal(result.source, 'http://fixed.example');
  assert.equal(result.resourceCount, 1);
  assert.deepEqual(calls, [
    'GET /api/v1/capabilities',
    `HEAD /api/v1/resources/${plan.resources[0]?.sha256}`,
    'POST /api/v1/resources',
    `HEAD /api/v1/resources/${plan.manifestSha256}`,
    'POST /api/v1/resources',
    'POST /api/v1/catalog',
  ]);
});

test('旧市场和超限能力在首次资源写入之前拒绝', async () => {
  const plan = await prepareReleasePublication(fixture(), signal());
  for (const oldMarket of [true, false]) {
    let writes = 0;
    const market = createMarketplace(async (_, init) => {
      if (init?.method === 'POST') ++writes;
      return oldMarket
        ? new Response(null, { status: 404 })
        : Response.json({
            ...capabilities,
            release_publication: { ...capabilities.release_publication, resource_max_bytes: 1 },
          });
    });
    await assert.rejects(
      publishReleasePublication(plan, metadata(plan), market, signal()),
      oldMarket ? /升级市场服务器/ : /单资源上限/,
    );
    assert.equal(writes, 0);
  }
});

test('已存在的资源和清单不重传，只有目录提交成功后返回完成', async () => {
  const plan = await prepareReleasePublication(fixture(), signal());
  let writes = 0;
  const market = createMarketplace(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/capabilities')) return Response.json(capabilities);
    if (init?.method === 'HEAD') {
      const digest = path.split('/').at(-1);
      const size =
        digest === plan.manifestSha256 ? plan.manifestBlob.size : plan.resources[0]?.size;
      return new Response(null, {
        headers: { etag: `"${digest}"`, 'content-length': String(size) },
      });
    }
    assert.equal(path, '/api/v1/catalog');
    ++writes;
    return Response.json(metadata(plan));
  });
  const stages: string[] = [];
  const result = await publishReleasePublication(plan, metadata(plan), market, signal(), (value) =>
    stages.push(value.stage),
  );
  assert.equal(result.reusedCount, 1);
  assert.equal(writes, 1);
  assert.equal(stages.at(-1), 'complete');
});

test('资源上传摘要错配或复用检查后取消均不提交目录', async () => {
  const plan = await prepareReleasePublication(fixture(), signal());
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const stages: string[] = [];
    let catalogs = 0;
    const market = createMarketplace(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/capabilities')) return Response.json(capabilities);
      if (init?.method === 'HEAD') {
        if (cancel) controller.abort();
        return new Response(null, { status: 404 });
      }
      if (path.endsWith('/catalog')) ++catalogs;
      return Response.json({
        id: 'b'.repeat(64),
        sha256: 'b'.repeat(64),
        size: 1,
        filename: '不匹配',
        kind: 'resource',
        media_type: 'application/octet-stream',
      });
    });
    await assert.rejects(
      publishReleasePublication(plan, metadata(plan), market, controller.signal, (value) =>
        stages.push(value.stage),
      ),
      cancel ? { name: 'AbortError' } : /摘要或大小不匹配/,
    );
    assert.equal(catalogs, 0);
    assert.ok(!stages.includes('complete'));
  }
});
