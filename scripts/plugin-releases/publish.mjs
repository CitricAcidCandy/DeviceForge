// 仅显式发布才写远端；先校验完整闭包，再上传资源，目录条目最后提交。
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { readJson, verifyFile } from './io.mjs';
import { releaseResources } from './contract.mjs';
import { verifyReleaseDirectory, jsonBytes, digestBytes } from './pack.mjs';

const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
export function serverUrl(value) {
  const url = new URL(value);
  fail(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    '资源服务地址必须为不含凭据的 HTTP/HTTPS URL',
  );
  return url;
}
function catalogEntry(metadata, manifest, sha256) {
  fail(
    metadata?.metadata_version === 1 &&
      metadata.kind === 'plugin' &&
      metadata.id === manifest.id &&
      metadata.version === manifest.version,
    '市场元数据身份与发布清单不一致',
  );
  for (const [key, max] of [
    ['name', 160],
    ['version', 80],
    ['summary', 400],
    ['description', 20000],
  ])
    fail(
      typeof metadata[key] === 'string' &&
        (key === 'description' || metadata[key].trim()) &&
        Buffer.byteLength(metadata[key]) <= max,
      `市场字段无效：${key}`,
    );
  fail(
    Array.isArray(metadata.applies_to) &&
      metadata.applies_to.length > 0 &&
      metadata.applies_to.every(
        (item) => typeof item === 'string' && item.trim() && Buffer.byteLength(item) <= 100,
      ),
    '市场适用对象无效',
  );
  fail(
    ['none', 'client', 'server', 'both'].includes(metadata.supports_mcp) &&
      typeof metadata.supports_agent === 'boolean' &&
      ['none', 'browser_refresh', 'plugin_reload', 'service_restart', 'device_restart'].includes(
        metadata.restart_policy,
      ),
    '市场能力或重启策略无效',
  );
  for (const key of ['keywords', 'categories', 'platforms', 'architectures'])
    fail(
      metadata[key] === undefined ||
        (Array.isArray(metadata[key]) &&
          metadata[key].every((item) => typeof item === 'string' && item.trim())),
      `市场数组无效：${key}`,
    );
  const allowed = ['function', 'theme', 'ui', 'integration'];
  // 历史官方声明使用业务分类；发布层显式转换为资源服务插件分类，并在计划中报告。
  const categories = [
    ...new Set(
      (metadata.categories ?? []).map((item) => (allowed.includes(item) ? item : 'function')),
    ),
  ];
  const fields = [
    'metadata_version',
    'id',
    'kind',
    'name',
    'version',
    'summary',
    'description',
    'keywords',
    'applies_to',
    'supports_mcp',
    'supports_agent',
    'restart_policy',
    'platforms',
    'architectures',
    'author',
    'license',
    'homepage',
    'visibility',
    'details',
  ];
  const entry = Object.fromEntries(
    fields.filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]),
  );
  return {
    ...entry,
    // 在线目录展示统一发布的描述，旧独立包元数据文件保持原有语义。
    description: manifest.description,
    categories,
    resource_id: sha256,
    details: {
      ...(metadata.details ?? {}),
      release_format_version: manifest.format_version,
      host_api_version: manifest.host_api_version,
    },
  };
}
export async function planPublication({ directory, market, server }) {
  const base = serverUrl(server),
    { manifest, files } = await verifyReleaseDirectory(directory);
  const resources = releaseResources(manifest);
  const online = structuredClone(manifest);
  for (const owner of [...online.components, ...(online.tools ?? [])])
    for (const variant of owner.variants) variant.path = variant.sha256;
  for (const dependency of online.dependencies?.dependencies ?? [])
    for (const source of dependency.sources ?? [])
      if (source.kind === 'market')
        source.url = new URL(`/api/v1/resources/${source.sha256}`, base).href;
  const bytes = jsonBytes(online),
    sha256 = digestBytes(bytes),
    metadata = await readJson(market);
  const entry = catalogEntry(metadata, online, sha256);
  const source = {
    kind: 'market',
    source_url: new URL(`/api/v1/resources/${sha256}`, base).href,
    release_id: manifest.id,
    version: manifest.version,
    manifest_sha256: sha256,
  };
  const summary = {
    source,
    resource_count: resources.length,
    total_resource_bytes: resources.reduce((sum, resource) => sum + resource.size, 0),
    categories_before: metadata.categories ?? [],
    categories_after: entry.categories,
    catalog_last: true,
    remote_written: false,
  };
  return { base: base.href, manifest: online, bytes, sha256, resources, files, entry, summary };
}

async function readResponse(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    fail(size <= 256 * 1024, '资源服务响应超过256KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function publishRelease(plan, { transport = fetch, signal } = {}) {
  const summaries = [];
  const request = (path, init = {}) =>
    transport(new URL(path, plan.base), {
      ...init,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000),
      redirect: 'error',
    });
  const upload = async ({ sha256, size, file, bytes, filename, kind }) => {
    if (file) await verifyFile(file, { sha256, size });
    const head = await request(`/api/v1/resources/${sha256}`, { method: 'HEAD' });
    if (head.ok) {
      fail(
        head.headers.get('etag') === `"${sha256}"` &&
          Number(head.headers.get('content-length')) === size,
        '已有远端资源长度或摘要身份不符',
      );
      summaries.push({ sha256, reused: true });
      return;
    }
    fail(head.status === 404, `资源去重查询失败：HTTP ${head.status}`);
    const response = await request('/api/v1/resources', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        'x-resource-filename': encodeURIComponent(filename),
        'x-resource-filename-encoding': 'percent',
        'x-resource-kind': kind,
      },
      body: bytes ?? createReadStream(file),
      ...(file ? { duplex: 'half' } : {}),
    });
    fail(response.ok, `资源上传失败：HTTP ${response.status}`);
    const record = await readResponse(response);
    fail(
      record.id === sha256 && record.sha256 === sha256 && record.size === size,
      '资源服务上传结果与实际字节不一致',
    );
    summaries.push({ sha256, reused: false });
  };
  for (const variant of plan.resources)
    await upload({
      ...variant,
      file: plan.files.get(variant.sha256),
      filename: basename(plan.files.get(variant.sha256)),
      kind: 'resource',
    });
  await upload({
    sha256: plan.sha256,
    size: plan.bytes.length,
    bytes: plan.bytes,
    filename: 'release.json',
    kind: 'plugin',
  });
  const response = await request('/api/v1/catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan.entry),
  });
  fail(response.ok, `目录发布失败：HTTP ${response.status}`);
  await readResponse(response);
  return { ...plan.summary, remote_written: true, resources: summaries };
}
