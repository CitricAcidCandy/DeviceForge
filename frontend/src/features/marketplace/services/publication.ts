import { ApiError } from '../../../services/api/index.ts';
import type { MarketplaceCapabilities } from '../types/index.ts';
import { marketplaceRequest, requireMarketplaceOk, waiting } from './transport.ts';

const logHeader = 'x-deviceforge-log-id';
const upgradeMessage = '市场服务器尚未支持完整功能插件发布，请先升级市场服务器';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function versionList(value: unknown, supported: readonly number[]): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item > 0,
    ) &&
    new Set(value).size === value.length &&
    value.some((version: number) => supported.includes(version))
  );
}

function protocol(response: Response, message: string, code = 'invalid_marketplace_response') {
  return new ApiError('protocol', code, message, response.status, response.headers.get(logHeader));
}

async function request(
  fetcher: typeof fetch,
  input: string,
  method: 'GET' | 'HEAD',
  signal: AbortSignal,
): Promise<Response> {
  return marketplaceRequest(
    fetcher,
    input,
    {
      method,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    },
    signal,
  );
}

export async function readReleaseCapabilities(
  fetcher: typeof fetch,
  source: string,
  signal: AbortSignal,
): Promise<MarketplaceCapabilities> {
  const response = await request(fetcher, `${source}/api/v1/capabilities`, 'GET', signal);
  if ([404, 405, 501].includes(response.status))
    throw new ApiError(
      'http',
      'marketplace_upgrade_required',
      upgradeMessage,
      response.status,
      response.headers.get(logHeader),
    );
  await requireMarketplaceOk(response, signal, '市场发布能力查询');
  if (response.status !== 200)
    throw protocol(response, upgradeMessage, 'marketplace_upgrade_required');
  let value: unknown;
  try {
    value = await waiting(response.json(), signal);
  } catch {
    signal.throwIfAborted();
    throw protocol(response, upgradeMessage, 'marketplace_upgrade_required');
  }
  signal.throwIfAborted();
  if (!record(value) || value['api_version'] !== 1 || !record(value['release_publication']))
    throw protocol(response, upgradeMessage, 'marketplace_upgrade_required');
  const publication = value['release_publication'];
  if (
    !versionList(publication['format_versions'], [1, 2]) ||
    !versionList(publication['host_api_versions'], [2]) ||
    typeof publication['resource_max_bytes'] !== 'number' ||
    !Number.isSafeInteger(publication['resource_max_bytes']) ||
    publication['resource_max_bytes'] < 1 ||
    publication['catalog_last'] !== true ||
    publication['immutable_versions'] !== true
  )
    throw protocol(response, upgradeMessage, 'marketplace_upgrade_required');
  return {
    api_version: 1,
    release_publication: {
      format_versions: publication['format_versions'],
      host_api_versions: publication['host_api_versions'],
      resource_max_bytes: publication['resource_max_bytes'],
      catalog_last: true,
      immutable_versions: true,
    },
  };
}

export async function probePublicationResource(
  fetcher: typeof fetch,
  source: string,
  digest: string,
  size: number,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('资源 SHA-256 摘要无效');
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('资源声明大小无效');
  const response = await request(fetcher, `${source}/api/v1/resources/${digest}`, 'HEAD', signal);
  signal.throwIfAborted();
  if (response.status === 404) return false;
  await requireMarketplaceOk(response, signal, '市场资源复用检查');
  if (
    response.status !== 200 ||
    response.headers.get('etag') !== `"${digest}"` ||
    response.headers.get('content-length') !== String(size)
  )
    throw protocol(response, '市场已有资源的 SHA-256 标记或大小不匹配，已停止发布');
  return true;
}
