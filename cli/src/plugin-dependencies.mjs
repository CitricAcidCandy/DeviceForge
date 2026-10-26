// 依赖客户端只走公开 HTTP；请求、日志关联和任务等待复用统一安装客户端。
import { createInstallationClient, waitInstallationJob } from './plugin-installations.mjs';

const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
const identifier = (value) =>
  typeof value === 'string' &&
  /^[a-z0-9][a-z0-9._-]{0,98}$/.test(value) &&
  !value.startsWith('builtin.');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function targetPath(target) {
  fail(
    target && ['release', 'server', 'browser'].includes(target.kind) && identifier(target.id),
    '依赖目标要求 release、server 或 browser 及有效插件 ID',
  );
  return `/api/v2/plugin-dependencies/${target.kind}/${encodeURIComponent(target.id)}`;
}

function dependenciesResult(value, target) {
  fail(
    value &&
      ((value.target?.kind === target.kind && value.target?.id === target.id) ||
        (target.kind !== 'release' && value.target?.kind === 'release' && identifier(value.target?.id))) &&
      digest(value.revision) &&
      Array.isArray(value.dependencies) &&
      typeof value.ready === 'boolean',
    '依赖响应的目标、修订或结果无效',
  );
  return value;
}

export async function getPluginDependencies(options, context = {}) {
  const path = targetPath(options.dependencyTarget);
  const result = await createInstallationClient({ ...context, apiUrl: options.apiUrl })(path);
  dependenciesResult(result.data, options.dependencyTarget);
  return result;
}

export async function changePluginDependencies(
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
  const path = targetPath(options.dependencyTarget);
  fail(['scan', 'install'].includes(options.dependencyAction), '依赖变更仅支持 scan/install');
  fail(digest(options.expectedRevision), '依赖变更要求预期修订 SHA-256');
  const ids = options.dependencyIds ?? [];
  fail(
    Array.isArray(ids) &&
      ids.length <= 128 &&
      ids.every(identifier) &&
      new Set(ids).size === ids.length,
    '依赖 ID 须为最多128个不重复的有效标识',
  );
  fail(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3600000,
    '依赖等待期限必须为1至3600000毫秒',
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
  const submitted = await request(`${path}/${options.dependencyAction}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: options.expectedRevision, dependency_ids: ids }),
  });
  fail(submitted.status === 202, '依赖 API 应返回202任务');
  const result = await waitInstallationJob(submitted, request, {
    signal: active,
    pollIntervalMs,
    onProgress,
    expectedOperation: `dependency.${options.dependencyAction}`,
  });
  const dependencies = dependenciesResult(result.job.result, options.dependencyTarget);
  return { ...result, dependencies };
}
