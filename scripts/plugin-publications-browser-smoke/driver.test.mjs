// 轻量回归只生成小型ZIP并验证驱动规则，不启动浏览器、宿主或监听端口。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { publicationFixtures } from './fixtures.mjs';
import { publicationSmokeOptions } from './options.mjs';
import { publicationBrowserResult } from './browser.mjs';
import { releaseCard } from './controls.mjs';
import { cleanupTemporary, verifyFailureBoundaries, verifyPublicationPhase, verifySameOriginSdk } from './verification.mjs';
import { verifyEntries } from '../plugin-releases/archive.mjs';
import { releaseResources } from '../plugin-releases/contract.mjs';
import { jsonBytes } from '../plugin-releases/pack.mjs';

let temporary, fixtures;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-publications-browser-'));
  fixtures = await publicationFixtures(temporary);
});
after(async () => { if (temporary) await cleanupTemporary(temporary); });

test('DOM失败结果在退出清理前保存，不被清理断言覆盖', () => {
  const result = { passed: false, dom_assertions: [{ name: '已完成阶段', passed: true }], error: { message: '原始页面错误' } };
  const report = { checks: { dom: null, network: null } };
  assert.throws(() => publicationBrowserResult({ result: { value: result } }, report), /原始页面错误/);
  assert.equal(report.browser, result);
  assert.equal(report.checks.dom, false);
  assert.equal(report.checks.network, null);
  const success = { passed: true, dom_assertions: [] };
  assert.equal(publicationBrowserResult({ result: { value: success } }, report), success);
  assert.equal(report.checks.dom, true);
  assert.equal(report.checks.network, null);
});

test('卡片定位使用精确展示标识，不依赖相邻DOM文本之间的空格', () => {
  const previous = Object.fromEntries(['document', 'getComputedStyle'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const card = (id) => ({ textContent: `中文名称${id} · v1.0.0`, getClientRects: () => [1],
    querySelectorAll: () => [{ getAttribute: (name) => name === 'title' ? id : null }] });
  const prefix = card('feature_extra'), exact = card('feature');
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [prefix, exact] } });
    Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ visibility: 'visible' }) });
    assert.equal(releaseCard('feature'), exact);
    assert.equal(releaseCard('missing'), undefined);
  } finally {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('冻结宿主、市场与dist目录可以分别指定并保留既有参数规则', () => {
  const root = join(tmpdir(), 'publication-options');
  const options = publicationSmokeOptions(root, ['--release', '--binary-directory', 'host',
    '--market-binary-directory=market', '--dist-directory', 'dist'], root, 'win32');
  assert.equal(options.binary, join(root, 'host', 'apk-server.exe'));
  assert.equal(options.marketBinary, join(root, 'market', 'deviceforge-resource-server.exe'));
  assert.equal(options.dist, join(root, 'dist'));
  assert.equal(options.profile, 'release');
  const defaults = publicationSmokeOptions(root, [], root, 'linux');
  assert.equal(defaults.binary, join(root, 'backend', 'target', 'debug', 'apk-server'));
  assert.equal(defaults.marketBinary, join(root, 'resource-server', 'target', 'debug', 'deviceforge-resource-server'));
  assert.equal(defaults.dist, join(root, 'frontend', 'dist'));
});

test('未知、重复及缺值目录参数在服务启动前拒绝', () => {
  for (const args of [['--other'], ['--dist-directory'], ['--market-binary-directory='],
    ['--dist-directory', '--release'], ['--dist-directory=a', '--dist-directory=b'],
    ['--market-binary-directory=a', '--market-binary-directory=b'], ['--release', '--release']]) {
    assert.throws(() => publicationSmokeOptions(tmpdir(), args));
  }
});

test('共享夹具保留三个原字节资源，冲突ZIP只改同身份清单', async () => {
  assert.deepEqual(fixtures.shared.manifest.components, fixtures.first.manifest.components);
  const original = releaseResources(fixtures.first.manifest).map((item) => item.sha256);
  const shared = releaseResources(fixtures.shared.manifest).map((item) => item.sha256);
  assert.equal(original.length, 3);
  assert.equal(shared.length, 4);
  assert.ok(original.every((digest) => shared.includes(digest)));
  const files = await verifyEntries(fixtures.conflict.archive, { format: 'zip' });
  const manifest = JSON.parse(files.get('release.json'));
  assert.deepEqual(manifest, fixtures.conflict.manifest);
  assert.equal(manifest.id, fixtures.first.id);
  assert.equal(manifest.version, fixtures.first.version);
  assert.notEqual(manifest.description, fixtures.first.manifest.description);
  for (const resource of releaseResources(manifest)) {
    const bytes = files.get(resource.path);
    assert.equal(bytes.length, resource.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), resource.sha256);
  }
});

function phaseLedger(fixture, known, phase, status = 201) {
  const entries = [];
  const add = (method, path, details) => {
    entries.push({ sequence: entries.length + 1, phase, method, path,
      at: '2026-10-23T00:00:00.000Z', finished_at: '2026-10-23T00:00:00.000Z', ...details });
  };
  add('GET', '/api/v1/capabilities', { status: 200, json_response: { api_version: 1,
    release_publication: { format_versions: [1], host_api_versions: [2], catalog_last: true, immutable_versions: true } } });
  const manifest = structuredClone(fixture.manifest);
  for (const owner of [...manifest.components, ...manifest.tools])
    for (const variant of owner.variants) variant.path = variant.sha256;
  for (const resource of releaseResources(manifest)) {
    add('HEAD', `/api/v1/resources/${resource.sha256}`, { status: known.has(resource.sha256) ? 200 : 404,
      response_headers: { etag: `"${resource.sha256}"`, content_length: String(resource.size) } });
    if (!known.has(resource.sha256)) add('POST', '/api/v1/resources', { status: 201,
      body_sha256: resource.sha256, body_bytes: resource.size,
      json_response: { id: resource.sha256, sha256: resource.sha256, size: resource.size } });
  }
  const bytes = jsonBytes(manifest), digest = createHash('sha256').update(bytes).digest('hex');
  add('HEAD', `/api/v1/resources/${digest}`, { status: 404 });
  add('POST', '/api/v1/resources', { status: 201, body_sha256: digest, body_bytes: bytes.length,
    json_body: manifest, json_response: { id: digest, sha256: digest, size: bytes.length } });
  add('POST', '/api/v1/catalog', { status, json_body: { id: fixture.id, version: fixture.version,
    name: fixture.manifest.name, description: fixture.manifest.description, resource_id: digest,
    details: { release_format_version: 1, host_api_version: 2 } } });
  return entries;
}

test('首次发布、共享去重及真实409边界的独立断言可以接续', () => {
  const known = new Set();
  const first = verifyPublicationPhase(phaseLedger(fixtures.first, known, 'first'), fixtures.first, known, 'first');
  assert.equal(first.missing_dependencies_uploaded, 3);
  const shared = verifyPublicationPhase(phaseLedger(fixtures.shared, known, 'shared'), fixtures.shared, known, 'shared');
  assert.equal(shared.existing_dependencies_reused, 3);
  assert.equal(shared.missing_dependencies_uploaded, 1);
  const conflict = verifyPublicationPhase(phaseLedger(fixtures.conflict, known, 'conflict', 409), fixtures.conflict, known, 'conflict', 409);
  assert.equal(conflict.missing_dependencies_uploaded, 0);
  assert.equal(conflict.catalog_status, 409);
});

test('不能以catalog请求先发、依赖未结束或资源长度错误冒充完整发布', () => {
  for (const mutate of [
    (entries) => { entries.at(-1).sequence = 1; },
    (entries) => { entries.find((entry) => entry.method === 'POST').finished_at = '2026-10-23T00:00:01.000Z'; },
    (entries) => { entries.find((entry) => entry.method === 'POST').body_bytes++; },
    (entries) => { entries.at(-1).json_body.version = '9.0.0'; },
    (entries) => { entries.splice(entries.findLastIndex((entry) => entry.method === 'HEAD'), 1); },
    (entries) => { entries.at(-2).json_body.description = '被改写'; },
    (entries) => { entries[0].json_response.release_publication.immutable_versions = false; },
  ]) {
    const entries = phaseLedger(fixtures.first, new Set(), 'first');
    mutate(entries);
    assert.throws(() => verifyPublicationPhase(entries, fixtures.first, new Set(), 'first'));
  }
});

test('资源复用必须核对HEAD摘要和长度，不能把缺失资源当作已共享', () => {
  const known = new Set(releaseResources(fixtures.first.manifest).map((item) => item.sha256));
  for (const field of ['etag', 'content_length']) {
    const entries = phaseLedger(fixtures.conflict, known, 'conflict', 409);
    entries.find((entry) => entry.method === 'HEAD').response_headers[field] = '错误身份';
    assert.throws(() => verifyPublicationPhase(entries, fixtures.conflict, new Set(known), 'conflict', 409));
  }
});

test('冲突不能被200或201成功状态替代', () => {
  const known = new Set(releaseResources(fixtures.first.manifest).map((item) => item.sha256));
  for (const status of [200, 201]) assert.throws(() => verifyPublicationPhase(
    phaseLedger(fixtures.conflict, known, 'conflict', status), fixtures.conflict, new Set(known), 'conflict', 409));
});

test('临时目录清理拒绝工作区和系统临时根', async () => {
  await assert.rejects(cleanupTemporary(tmpdir()), /仅允许清理/);
  await assert.rejects(cleanupTemporary(new URL('.', import.meta.url)), /仅允许清理/);
});

test('旧市场、上传失败和真实取消必须有相应证据且不能提交catalog', () => {
  const entries = [
    { phase: 'legacy-capabilities', method: 'GET', path: '/api/v1/capabilities', status: 404, injected: 'legacy-capabilities-404' },
    { phase: 'resource-error', method: 'POST', path: '/api/v1/resources', status: 503, injected: 'resource-post-503' },
    { phase: 'cancel-publication', method: 'POST', path: '/api/v1/resources', held: true, client_aborted: true },
  ];
  verifyFailureBoundaries(entries);
  for (const phase of ['legacy-capabilities', 'resource-error', 'cancel-publication']) {
    assert.throws(() => verifyFailureBoundaries([...entries, { phase, method: 'POST', path: '/api/v1/catalog' }]));
    assert.throws(() => verifyFailureBoundaries(entries.filter((item) => item.phase !== phase)));
  }
  const notAborted = structuredClone(entries); notAborted.at(-1).client_aborted = false;
  assert.throws(() => verifyFailureBoundaries(notAborted));
});

test('SDK发布身份是JSON而非裸ID，安装与调用都必须同源', () => {
  const origin = 'http://127.0.0.1:49999';
  const report = { product_origin: origin, browser_network: [
    { origin, path: '/api/v2/plugin-installations', method: 'POST', status: 202 },
    { origin, path: '/api/v2/jobs', method: 'POST', status: 202,
      plugin_release: JSON.stringify({ id: 'feature', revision: 'revision-1' }) },
  ] };
  verifySameOriginSdk(report, 'feature');
  for (const index of [0, 1]) {
    const changed = structuredClone(report); changed.browser_network[index].origin = 'http://127.0.0.1:7031';
    assert.throws(() => verifySameOriginSdk(changed, 'feature'));
  }
  assert.throws(() => verifySameOriginSdk(report, 'other'));
  report.browser_network[1].plugin_release = 'feature';
  assert.throws(() => verifySameOriginSdk(report, 'feature'));
});
