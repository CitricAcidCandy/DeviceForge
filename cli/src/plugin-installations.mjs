// 统一安装客户端只调用公开 API；不加载 Rust 校验器、不执行 npm 包脚本。
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readApiToken } from './options.mjs';

const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = (value) =>
  typeof value === 'string' &&
  /^[a-z0-9][a-z0-9._-]{0,98}$/.test(value) &&
  !value.startsWith('builtin.');
export function installationApiUrl(value = 'http://127.0.0.1:7030') {
  const url = new URL(value);
  fail(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['/', '/api/v2', '/api/v2/'].includes(url.pathname),
    'API 地址必须为不含凭据的 HTTP/HTTPS 服务根地址',
  );
  url.pathname = '/';
  return url;
}
function marketSource(options) {
  const source =
    typeof options.source === 'object'
      ? options.source
      : {
          kind: 'market',
          source_url: options.source,
          release_id: options.releaseId,
          version: options.releaseVersion,
          manifest_sha256: options.manifestSha256,
        };
  const url = new URL(source.source_url);
  fail(
    source.kind === 'market' &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      identifier(source.release_id) &&
      typeof source.version === 'string' &&
      /^[A-Za-z0-9._+-]{1,100}$/.test(source.version) &&
      digest(source.manifest_sha256),
    '市场安装必须提供完整清单 URL、发布 ID、版本和原字节 SHA-256',
  );
  return {
    kind: 'market',
    source_url: url.href,
    release_id: source.release_id,
    version: source.version,
    manifest_sha256: source.manifest_sha256,
  };
}
async function envelope(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    fail(size <= 1024 * 1024, '安装 API 响应超过1MiB');
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error(`安装 API 返回无效 JSON：HTTP ${response.status}`);
  }
  const logId = response.headers.get('x-deviceforge-log-id');
  fail(logId && value.log_id === logId, '安装 API 响应日志 ID 不一致');
  if (!response.ok) {
    const code =
      typeof value.error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(value.error.code)
        ? value.error.code
        : 'request_failed';
    // 不回显服务的任意错误载荷，防止令牌、用户输入和本机路径进入 CLI 日志。
    throw new Error(`安装请求失败：${code}，HTTP ${response.status}，日志 ${logId}`);
  }
  fail(Object.hasOwn(value, 'data'), '安装 API 成功响应缺少 data');
  return { data: value.data, logId };
}

export function createInstallationClient({
  apiUrl,
  environment = process.env,
  signal,
  transport = fetch,
  requestTimeoutMs = 30000,
} = {}) {
  const base = installationApiUrl(apiUrl),
    token = readApiToken(environment);
  return async (path, init = {}) => {
    signal?.throwIfAborted();
    const active = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
      : AbortSignal.timeout(requestTimeoutMs);
    let response;
    try {
      response = await transport(new URL(path, base), {
        ...init,
        redirect: 'error',
        signal: active,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
      });
    } catch (error) {
      if (active.aborted) throw active.reason;
      throw new Error('无法连接安装 API，请核对服务地址与网络');
    }
    return { ...(await envelope(response)), status: response.status };
  };
}

export async function waitInstallationJob(
  submitted,
  request,
  { signal, pollIntervalMs = 500, onProgress, expectedOperation } = {},
) {
  let job = submitted.data;
  fail(
    job && typeof job.id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(job.id),
    '安装 API 未返回任务身份',
  );
  const id = job.id;
  while (true) {
    signal?.throwIfAborted();
    fail(
      job.id === id &&
        (!expectedOperation || job.operation === expectedOperation) &&
        ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status),
      '安装任务身份、操作或状态无效',
    );
    onProgress?.({ jobId: id, status: job.status, logId: submitted.logId });
    if (job.status === 'succeeded') return { job, logId: submitted.logId };
    if (['failed', 'cancelled'].includes(job.status))
      throw new Error(
        `安装任务${job.status === 'cancelled' ? '已取消' : '失败'}：${id}，日志 ${submitted.logId}`,
      );
    await delay(pollIntervalMs, undefined, { signal });
    const result = await request(`/api/v2/jobs/${encodeURIComponent(id)}`);
    job = result.data;
  }
}

export async function installPluginRelease(
  options,
  {
    signal,
    environment = process.env,
    transport = fetch,
    onProgress,
    pollIntervalMs = 500,
    timeoutMs = 600000,
  } = {},
) {
  fail(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3600000,
    '安装等待期限必须为1至3600000毫秒',
  );
  const active = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const request = createInstallationClient({
    apiUrl: options.apiUrl,
    signal: active,
    environment,
    transport,
  });
  fail(
    options.expectedRevision === undefined ||
      options.expectedRevision === null ||
      digest(options.expectedRevision),
    '更新必须提供旧发布修订 SHA-256',
  );
  if (options.updateId !== undefined)
    fail(
      identifier(options.updateId) && digest(options.expectedRevision),
      '更新需要发布 ID 和预期旧修订',
    );
  let source;
  if (typeof options.source === 'object' || /^https?:\/\//i.test(options.source ?? '')) {
    source = marketSource(options);
    fail(
      options.updateId === undefined || source.release_id === options.updateId,
      '更新目标与发布 ID 不一致',
    );
  } else {
    fail(
      typeof options.source === 'string' && options.source.toLowerCase().endsWith('.zip'),
      '统一安装需要 release.json URL 或离线 ZIP；旧 npm/TGZ 请使用 install-legacy',
    );
    fail(
      [options.releaseId, options.releaseVersion, options.manifestSha256].every(
        (value) => value === undefined,
      ),
      '离线 ZIP 不能混用市场来源身份参数',
    );
    const path = resolve(options.source),
      stat = await lstat(path);
    fail(
      stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 4 * 1024 * 1024 * 1024,
      '离线安装源必须为4GiB以内的普通 ZIP 文件',
    );
    const upload = await request(
      `/api/v2/plugin-installations/artifacts?filename=${encodeURIComponent(basename(path))}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(stat.size),
        },
        body: createReadStream(path),
        duplex: 'half',
      },
    );
    fail(
      typeof upload.data?.id === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(upload.data.id),
      '产物 API 未返回有效身份',
    );
    source = { kind: 'offline', artifact_id: upload.data.id };
  }
  const body = { source, expected_revision: options.expectedRevision ?? null };
  const path = options.updateId
    ? `/api/v2/plugin-installations/${encodeURIComponent(options.updateId)}`
    : '/api/v2/plugin-installations';
  const submitted = await request(path, {
    method: options.updateId ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  fail(submitted.status === 202, '安装 API 应返回202任务');
  return waitInstallationJob(submitted, request, { signal: active, pollIntervalMs, onProgress });
}

export async function listPluginInstallations(options, context = {}) {
  return (
    await createInstallationClient({ ...context, apiUrl: options.apiUrl })(
      '/api/v2/plugin-installations',
    )
  ).data;
}

export async function cleanupPluginResources(
  options,
  {
    signal,
    environment = process.env,
    transport = fetch,
    onProgress,
    pollIntervalMs = 500,
    timeoutMs = 600000,
  } = {},
) {
  fail(options.dryRun === undefined || typeof options.dryRun === 'boolean', '清理预览参数必须为布尔值');
  fail(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3600000, '清理等待期限必须为1至3600000毫秒');
  const dryRun = options.dryRun ?? true,
    active = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
    request = createInstallationClient({ apiUrl: options.apiUrl, signal: active, environment, transport });
  const submitted = await request('/api/v2/plugin-installations/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dry_run: dryRun }),
  });
  fail(submitted.status === 202, '清理 API 应返回202任务');
  const result = await waitInstallationJob(submitted, request, {
    signal: active, pollIntervalMs, onProgress, expectedOperation: 'installation.cleanup',
  });
  const report = result.job.result;
  fail(
    report && report.dry_run === dryRun && Array.isArray(report.items) &&
      report.items.length <= 32768 && Number.isSafeInteger(report.total_bytes) && report.total_bytes >= 0 &&
      report.items.every((item) =>
        item && typeof item.resource === 'string' && item.resource.length > 0 && item.resource.length <= 1024 &&
        !/[\u0000-\u001f\u007f]/.test(item.resource) &&
        Number.isSafeInteger(item.bytes) && item.bytes >= 0) &&
      report.items.reduce((sum, item) => sum + item.bytes, 0) === report.total_bytes,
    '清理任务缺少有效报告或预览模式不一致',
  );
  return { ...result, report };
}
