import type {
  ArtifactDto,
  BrowserRunPath,
  Endpoint,
  EventQuery,
  JobDto,
  JobEventDto,
  JobQuery,
  OperationDto,
  PackageInfo,
  PackageKind,
  PackageMediaType,
  PackageTarget,
  PluginInfo,
  SubmitJob,
  UploadQuery,
} from './types.ts';
import {
  isArrayOf,
  isArtifact,
  isJob,
  isJobEvent,
  isOperation,
  isPackageInfo,
  isPluginInfo,
} from './validation.ts';

export function encodedId(id: string): string {
  if (!id || id === '.' || id === '..') throw new Error('公开标识不能为空或路径跳转段');
  return encodeURIComponent(id);
}
function query(path: string, values: Readonly<Record<string, number | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('分页参数必须为非负安全整数');
      params.set(key, String(value));
    }
  }
  return params.size ? `${path}?${params}` : path;
}
export const operationsEndpoint: Endpoint<void, OperationDto[]> = {
  request: () => ({ path: '/api/v2/operations', method: 'GET' }),
  decode: isArrayOf(isOperation),
};
export const jobsEndpoint: Endpoint<JobQuery, JobDto[]> = {
  request: (input) => ({ path: query('/api/v2/jobs', input), method: 'GET' }),
  decode: isArrayOf(isJob),
};
export const submitEndpoint: Endpoint<SubmitJob, JobDto> = {
  request: (input) => ({
    path: '/api/v2/jobs',
    method: 'POST',
    body: JSON.stringify(input),
    contentType: 'application/json',
  }),
  decode: isJob,
};
export const jobEndpoint: Endpoint<string, JobDto> = {
  request: (id) => ({ path: `/api/v2/jobs/${encodedId(id)}`, method: 'GET' }),
  decode: isJob,
};
export const cancelEndpoint: Endpoint<string, JobDto> = {
  request: (id) => ({ path: `/api/v2/jobs/${encodedId(id)}/cancel`, method: 'POST' }),
  decode: isJob,
};
export const eventsEndpoint: Endpoint<{ id: string; query: EventQuery }, JobEventDto[]> = {
  request: ({ id, query: values }) => ({
    path: query(`/api/v2/jobs/${encodedId(id)}/events`, values),
    method: 'GET',
  }),
  decode: isArrayOf(isJobEvent),
};
export const pluginsEndpoint: Endpoint<void, PluginInfo[]> = {
  request: () => ({ path: '/api/v2/plugins', method: 'GET' }),
  decode: isArrayOf(isPluginInfo),
};
export const loadPluginEndpoint: Endpoint<string, PluginInfo> = {
  request: (id) => ({ path: `/api/v2/plugins/${encodedId(id)}/load`, method: 'POST' }),
  decode: isPluginInfo,
};
export const unloadPluginEndpoint: Endpoint<string, PluginInfo> = {
  request: (id) => ({ path: `/api/v2/plugins/${encodedId(id)}/unload`, method: 'POST' }),
  decode: isPluginInfo,
};
export const uploadEndpoint: Endpoint<UploadQuery & { content: Blob }, ArtifactDto> = {
  request: ({ filename, content }) => ({
    path: `/api/v2/artifacts?${new URLSearchParams({ filename })}`,
    method: 'POST',
    body: content,
    contentType: 'application/octet-stream',
  }),
  decode: isArtifact,
};
export const packagesEndpoint: Endpoint<PackageKind, PackageInfo[]> = {
  request: (kind) => ({ path: `/api/v2/plugin-packages/${encodedId(kind)}`, method: 'GET' }),
  decode: isArrayOf(isPackageInfo),
};
export const installPackageEndpoint: Endpoint<
  { kind: PackageKind; content: Blob; mediaType: PackageMediaType },
  PackageInfo
> = {
  request: ({ kind, content, mediaType }) => ({
    path: `/api/v2/plugin-packages/${encodedId(kind)}?${new URLSearchParams({ format: mediaType === 'application/zip' ? 'zip' : 'tgz' })}`,
    method: 'POST',
    body: content,
    contentType: mediaType,
  }),
  decode: isPackageInfo,
};
export const deletePackageEndpoint: Endpoint<PackageTarget, PackageInfo> = {
  request: ({ kind, id }) => ({
    path: `/api/v2/plugin-packages/${encodedId(kind)}/${encodedId(id)}`,
    method: 'DELETE',
  }),
  decode: isPackageInfo,
};
export function browserPackageEntryUrl(baseUrl: string, input: BrowserRunPath): string {
  const segments = input.path.split('/');
  if (
    !segments.length ||
    segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
  )
    throw new Error('已安装包入口路径无效');
  const path = segments.map(encodeURIComponent).join('/');
  return new URL(
    `/api/v2/browser-plugins/${encodedId(input.id)}/runs/${encodedId(input.run_id)}/assets/${path}`,
    baseUrl,
  ).href;
}
