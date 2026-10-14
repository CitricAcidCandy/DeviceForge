import type { paths } from './generated.ts';

// 全部业务类型直接索引生成契约，传输适配不另建 DTO。
type JsonResponse<T> = T extends { content: { 'application/json': infer R } } ? R : never;
type Data<T> = JsonResponse<T> extends { data: infer D } ? D : never;
export type OperationDto = Data<paths['/api/v2/operations']['get']['responses'][200]>[number];
export type JobDto = Data<paths['/api/v2/jobs/{id}']['get']['responses'][200]>;
export type SubmitJob = paths['/api/v2/jobs']['post']['requestBody']['content']['application/json'];
export type JobQuery = NonNullable<paths['/api/v2/jobs']['get']['parameters']['query']>;
export type JobEventDto = Data<paths['/api/v2/jobs/{id}/events']['get']['responses'][200]>[number];
export type EventQuery = NonNullable<
  paths['/api/v2/jobs/{id}/events']['get']['parameters']['query']
>;
export type PluginInfo = Data<paths['/api/v2/plugins']['get']['responses'][200]>[number];
export type ArtifactDto = Data<paths['/api/v2/artifacts']['post']['responses'][201]>;
export type UploadQuery = paths['/api/v2/artifacts']['post']['parameters']['query'];
export type PackageInfo = Data<
  paths['/api/v2/plugin-packages/{kind}']['get']['responses'][200]
>[number];
export type PackageKind =
  paths['/api/v2/plugin-packages/{kind}']['get']['parameters']['path']['kind'];
export type PackageMediaType =
  keyof paths['/api/v2/plugin-packages/{kind}']['post']['requestBody']['content'];
export type PackageTarget =
  paths['/api/v2/plugin-packages/{kind}/{id}']['delete']['parameters']['path'];
export type BrowserRunPath =
  paths['/api/v2/browser-plugins/{id}/runs/{run_id}/assets/{path}']['get']['parameters']['path'];
export type DeviceProviderDto = Data<
  paths['/api/v2/device-providers']['get']['responses'][200]
>[number];
export type DeviceDirectoryDto = Data<paths['/api/v2/devices']['get']['responses'][200]>[number];
export type DeviceRefDto = DeviceDirectoryDto['devices'][number]['reference'];
export type RefreshDeviceProviderBody =
  paths['/api/v2/device-providers/{id}/refresh']['post']['requestBody']['content']['application/json'];
export type RefreshDeviceProviderPath =
  paths['/api/v2/device-providers/{id}/refresh']['post']['parameters']['path'];
export type DeviceActionDto =
  paths['/api/v2/device-actions']['post']['requestBody']['content']['application/json'];

export interface ApiResult<T> {
  readonly data: T;
  readonly logId: string | null;
}
export interface RequestSpec {
  readonly path: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly body?: string | Blob | ArrayBuffer;
  readonly contentType?: string;
}
export interface Endpoint<I, O> {
  readonly request: (input: I) => RequestSpec;
  readonly decode: (value: unknown) => value is O;
}
export interface ApiClient {
  readonly call: <I, O>(
    endpoint: Endpoint<I, O>,
    input: I,
    signal: AbortSignal,
  ) => Promise<ApiResult<O>>;
  readonly downloadArtifact: (id: string, signal: AbortSignal) => Promise<ApiResult<Blob>>;
}
