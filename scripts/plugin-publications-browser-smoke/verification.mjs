// 独立检查真实转发日志的摘要、顺序及共享去重，不使用DOM成功文字代替网络证据。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { releaseResources, validateRelease } from '../plugin-releases/contract.mjs';
import { fileIdentity } from '../plugin-installations-smoke/host.mjs';

const execute = promisify(execFile);

// 只识别本轮独占配置目录的浏览器，不能把用户浏览器纳入回收范围。
export async function ownedBrowserProcesses(profile) {
  if (process.platform !== 'win32') return { supported: false, processes: [] };
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$profilePath = $env:DEVICEFORGE_PUBLICATION_PROFILE',
    '$all = @(Get-CimInstance Win32_Process)',
    '$items = @($all | Where-Object {',
    "  $_.Name -in @('msedge.exe', 'chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($profilePath)",
    '})',
    '$ids = [System.Collections.Generic.HashSet[uint32]]::new()',
    'foreach ($item in $items) { $null = $ids.Add([uint32]$item.ProcessId) }',
    'do {',
    '  $added = $false',
    '  foreach ($item in $all) {',
    '    if ($ids.Contains([uint32]$item.ParentProcessId) -and $ids.Add([uint32]$item.ProcessId)) { $added = $true }',
    '  }',
    '} while ($added)',
    '$owned = @($all | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | Select-Object ProcessId, ParentProcessId, Name, CommandLine)',
    'ConvertTo-Json -InputObject $owned -Compress',
  ].join('\n');
  assert.ok(typeof profile === 'string' && isAbsolute(profile), '浏览器归属查询必须指定本轮绝对配置路径');
  const pending = execute('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 10000,
      env: { ...process.env, DEVICEFORGE_PUBLICATION_PROFILE: profile },
    });
  const { stdout } = await pending;
  return { supported: true, processes: JSON.parse(stdout.trim() || '[]'),
    query_process: { pid: pending.child.pid, command: 'powershell.exe Get-CimInstance Win32_Process',
      exit_code: pending.child.exitCode, signal: pending.child.signalCode } };
}

export async function reclaimOwnedBrowserProcesses(profile, report) {
  const before = await ownedBrowserProcesses(profile);
  report.owned_browser_processes_before_cleanup = before;
  report.browser_recovery = [];
  // 已由独占配置目录确认的根进程才能回收整棵树；不按进程名称批量结束。
  for (const item of before.processes.filter((entry) => entry.CommandLine?.includes(profile))) {
    const current = await ownedBrowserProcesses(profile);
    if (!current.processes.some((entry) => entry.ProcessId === item.ProcessId)) continue;
    const pending = execute('taskkill.exe', ['/PID', String(item.ProcessId), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    try {
      await pending;
      report.browser_recovery.push({ pid: item.ProcessId, command: 'taskkill.exe /PID <本轮PID> /T /F',
        helper_pid: pending.child.pid, exit_code: pending.child.exitCode });
    } catch (error) {
      report.browser_recovery.push({ pid: item.ProcessId, helper_pid: pending.child.pid, error: error.message });
    }
  }
  return ownedBrowserProcesses(profile);
}

export async function cleanupTemporary(temporary) {
  const target = await realpath(temporary), parent = await realpath(tmpdir()), info = await lstat(temporary);
  const subpath = relative(parent, target);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && subpath && !isAbsolute(subpath) &&
    subpath !== '..' && !subpath.startsWith(`..${sep}`) && basename(target).startsWith('deviceforge-publications-browser-'),
  '仅允许清理本轮系统临时目录');
  await rm(target, { recursive: true, force: true });
}

export function verifyPublicationPhase(entries, fixture, known, phase, catalogStatus = 201) {
  const requests = entries.filter((entry) => entry.phase === phase);
  const capabilities = requests.find((entry) => entry.method === 'GET' && entry.path === '/api/v1/capabilities');
  assert.equal(capabilities?.status, 200, `${phase} 必须读取真实市场能力`);
  const capability = capabilities.json_response;
  assert.equal(capability?.api_version, 1);
  assert.ok(capability.release_publication.format_versions.includes(1));
  assert.ok(capability.release_publication.host_api_versions.includes(2));
  assert.equal(capability.release_publication.catalog_last, true);
  assert.equal(capability.release_publication.immutable_versions, true);
  const posts = requests.filter((entry) => entry.method === 'POST');
  const catalogs = posts.filter((entry) => entry.path === '/api/v1/catalog');
  assert.equal(catalogs.length, 1, `${phase} 只能提交一个完整功能市场条目`);
  assert.equal(catalogs[0].status, catalogStatus);
  const resources = posts.filter((entry) => entry.path === '/api/v1/resources');
  assert.equal(posts.length, resources.length + 1, '发布过程不能额外上传ZIP或单独组件目录条目');
  const manifests = resources.filter((entry) => entry.json_body?.format_version === 1);
  assert.equal(manifests.length, 1, `${phase} 必须上传一份在线发布清单`);
  const uploadedManifest = manifests[0];
  const manifest = validateRelease(uploadedManifest.json_body);
  const expected = structuredClone(fixture.manifest);
  for (const owner of [...expected.components, ...expected.tools])
    for (const variant of owner.variants) variant.path = variant.sha256;
  assert.deepEqual(manifest, expected, '网页只能将离线路径改为在线摘要，发布与组件身份保持原值');
  const required = releaseResources(manifest);
  const missing = required.filter((resource) => !known.has(resource.sha256));
  assert.equal(resources.length, missing.length + 1, `${phase} 只传缺失资源及新的在线清单`);
  for (const resource of required) {
    const head = requests.find((entry) => entry.method === 'HEAD' && entry.path === `/api/v1/resources/${resource.sha256}`);
    assert.ok(head, `缺少资源HEAD ${resource.sha256}`);
    assert.equal(head.status, known.has(resource.sha256) ? 200 : 404);
    assert.ok(head.sequence > capabilities.sequence, '能力检查必须早于资源请求');
    assert.ok(capabilities.finished_at <= head.at, '能力检查完成后才允许资源请求');
    if (known.has(resource.sha256)) {
      assert.equal(head.response_headers?.etag, `"${resource.sha256}"`);
      assert.equal(head.response_headers?.content_length, String(resource.size));
    }
    assert.ok(head.finished_at <= uploadedManifest.at, '全部依赖检查完成后再上传发布清单');
    const uploads = resources.filter((entry) => entry.body_sha256 === resource.sha256);
    assert.equal(uploads.length, known.has(resource.sha256) ? 0 : 1, '已有资源不应再次POST');
    if (uploads.length) {
      const upload = uploads[0];
      assert.equal(upload.body_bytes, resource.size);
      assert.equal(upload.status, 201);
      assert.equal(upload.json_response?.id, resource.sha256);
      assert.equal(upload.json_response?.sha256, resource.sha256);
      assert.equal(upload.json_response?.size, resource.size);
      assert.ok(upload.sequence > head.sequence);
      assert.ok(upload.sequence < uploadedManifest.sequence, '全部依赖先于发布清单上传');
      assert.ok(upload.finished_at <= uploadedManifest.at, '依赖上传完成后再上传发布清单');
    }
  }
  assert.equal(uploadedManifest.status, 201);
  assert.equal(uploadedManifest.json_response?.sha256, uploadedManifest.body_sha256);
  assert.equal(uploadedManifest.json_response?.id, uploadedManifest.body_sha256);
  assert.equal(uploadedManifest.json_response?.size, uploadedManifest.body_bytes);
  const manifestHead = requests.find((entry) => entry.method === 'HEAD' &&
    entry.path === `/api/v1/resources/${uploadedManifest.body_sha256}`);
  assert.equal(manifestHead?.status, 404, '新清单也必须先检查是否存在');
  assert.ok(manifestHead.sequence < uploadedManifest.sequence && manifestHead.finished_at <= uploadedManifest.at);
  assert.equal(catalogs[0].json_body.resource_id, uploadedManifest.body_sha256);
  assert.equal(catalogs[0].json_body.id, fixture.id);
  assert.equal(catalogs[0].json_body.version, fixture.version);
  assert.equal(catalogs[0].json_body.name, fixture.manifest.name);
  assert.equal(catalogs[0].json_body.description, fixture.manifest.description);
  assert.equal(catalogs[0].json_body.details.release_format_version, 1);
  assert.equal(catalogs[0].json_body.details.host_api_version, 2);
  assert.ok(catalogs[0].sequence > uploadedManifest.sequence);
  assert.ok(uploadedManifest.finished_at <= catalogs[0].at, '市场条目必须最后提交');
  for (const resource of required) known.add(resource.sha256);
  known.add(uploadedManifest.body_sha256);
  return { phase, passed: true, dependent_resources: required.length, resource_posts: resources.length,
    missing_dependencies_uploaded: missing.length, existing_dependencies_reused: required.length - missing.length,
    manifest_sha256: uploadedManifest.body_sha256, catalog_last: true, catalog_status: catalogStatus };
}

export function verifyFailureBoundaries(entries) {
  const legacy = entries.filter((item) => item.phase === 'legacy-capabilities');
  assert.ok(legacy.some((item) => item.path === '/api/v1/capabilities' && item.status === 404 && item.injected));
  assert.equal(legacy.some((item) => item.method === 'POST'), false, '旧市场能力失败不得回退成独立包上传');
  const failed = entries.filter((item) => item.phase === 'resource-error');
  assert.ok(failed.some((item) => item.injected === 'resource-post-503' && item.status === 503));
  assert.equal(failed.some((item) => item.method === 'POST' && item.path === '/api/v1/catalog'), false);
  const cancelled = entries.filter((item) => item.phase === 'cancel-publication');
  assert.ok(cancelled.some((item) => item.held && item.client_aborted), '取消必须实际中断浏览器连接');
  assert.equal(cancelled.some((item) => item.method === 'POST' && item.path === '/api/v1/catalog'), false);
}

export function verifySameOriginSdk(report, releaseId) {
  assert.ok(report.browser_network.some((item) => item.origin === report.product_origin &&
    item.path === '/api/v2/plugin-installations' && item.method === 'POST' && item.status === 202), '安装必须经过产品同源宿主代理');
  assert.ok(report.browser_network.some((item) => {
    if (item.origin !== report.product_origin || item.method !== 'POST' || item.status !== 202 || item.path !== '/api/v2/jobs') return false;
    try {
      const identity = JSON.parse(item.plugin_release);
      return identity.id === releaseId && typeof identity.revision === 'string' && identity.revision.length > 0;
    } catch { return false; }
  }), '公开SDK必须携带完整发布修订身份并经过产品同源宿主代理');
}

export async function verifyPublicationEvidence({ gateway, market, fixtures, report }) {
  const entries = gateway.ledger;
  verifyFailureBoundaries(entries);
  const known = new Set();
  const first = verifyPublicationPhase(entries, fixtures.first, known, 'first-publication');
  const shared = verifyPublicationPhase(entries, fixtures.shared, known, 'shared-publication');
  assert.equal(shared.existing_dependencies_reused, 3, '第二发布须复用两份组件和一份共享工具');
  assert.equal(shared.missing_dependencies_uploaded, 1, '第二发布只新增一个工具资源');
  const conflict = verifyPublicationPhase(entries, fixtures.conflict, known, 'conflicting-publication', 409);
  assert.equal(conflict.missing_dependencies_uploaded, 0, '冲突发布不得重复上传既有组件与工具');
  assert.notEqual(conflict.manifest_sha256, first.manifest_sha256);
  const response = await fetch(`${market.base}/api/v1/catalog?kind=plugin&limit=100`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.entries.length, 2, '真实市场最终只出现两份完整功能条目');
  assert.deepEqual(new Set(catalog.entries.map((item) => item.id)), new Set([fixtures.first.id, fixtures.shared.id]));
  for (const [fixture, publication] of [[fixtures.first, first], [fixtures.shared, shared]]) {
    const entry = catalog.entries.find((item) => item.id === fixture.id);
    assert.equal(entry.version, fixture.version);
    assert.equal(entry.resource_id, publication.manifest_sha256, '冲突不得覆盖已有市场清单身份');
    assert.equal(entry.description, fixture.manifest.description);
  }
  assert.equal(report.bridge_errors?.length ?? 0, 0);
  assert.equal(report.publication_gateway_errors?.length ?? 0, 0);
  assert.equal(report.browser_console.some((item) => item.kind === 'exception'), false);
  assert.ok(report.product_proxy.some((item) => item.path === '/api/v2/plugin-installations' && item.method === 'POST' && item.status === 202));
  verifySameOriginSdk(report, fixtures.first.id);
  return { passed: true, legacy_no_writes: true, failed_no_catalog: true, cancelled_no_catalog: true,
    actual_client_abort: true, first, shared, conflict, original_catalog_preserved: true, same_origin_sdk: true,
    final_catalog_entries: catalog.entries };
}

export async function verifyFrozenDist(report) {
  const results = [];
  for (const previous of report.production_inputs ?? []) {
    const current = await fileIdentity(previous.path);
    results.push({ ...current, unchanged: current.size === previous.bytes && current.sha256 === previous.sha256 });
  }
  assert.ok(results.length > 0 && results.every((item) => item.unchanged), '本轮受检生产dist在验收期间发生漂移');
  return results;
}

export async function listenerReleased(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}
