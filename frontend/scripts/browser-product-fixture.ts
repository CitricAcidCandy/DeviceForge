import type { DeviceCapability } from '../src/plugin-sdk/index.ts';
import type { DeviceDirectoryDto, DeviceProviderDto, OperationDto } from '../src/shared/api/index.ts';

export const fixtureArtifact = '12345678-1234-4234-8234-123456789abc';
export const fixtureTaskFiles = [
  {jobId: 'fixture-task-artifact-first', artifactId: '22345678-1234-4234-8234-123456789abc', filename: 'task-first.bin', bytes: [1, 2, 3, 4], sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a'},
  {jobId: 'fixture-task-artifact-second', artifactId: '32345678-1234-4234-8234-123456789abc', filename: 'task-second.bin', bytes: [9, 8, 7], sha256: '06df4f7e1394f1c57cc6583fba4d8060a5a66f4f4771c14aeff6b9af8a28c9b3'},
];
export interface FixtureRequest {readonly method: string; readonly path: string; readonly input: unknown}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringSchema = {type: 'string'};
const moduleSchema = {type: ['array', 'null'], items: stringSchema};
function envelope(fields: Record<string, unknown>, required = Object.keys(fields)) {
  return {type: 'object', properties: {device_id: stringSchema, input: {type: 'object', properties: fields, required}}, required: ['input']};
}
function provider(id: string, bundleInput: boolean): DeviceProviderDto {
  const ids = ['packages', 'app.start', 'app.stop', 'app.uninstall', 'app.install', 'connect', 'disconnect', ...(bundleInput ? ['app.detail', 'app.reset'] : ['app.install_apks'])];
  const capabilities: DeviceProviderDto['definition']['capabilities'] = ids.map(capability => ({id: capability, version: 1, operation: `${id}.${capability}`,
    scope: capability === 'connect' || capability === 'disconnect' ? 'provider' : 'device', access: capability === 'packages' || capability === 'app.detail' ? 'read' : 'write'}));
  // 非标准平台名称用于证明表单依据能力与 schema，而非平台字符串分支。
  return {id, generation: 'generation-1', version: '1.0.0', definition: {api_version: 1, platform: bundleInput ? '扩展乙' : '扩展甲', discover_operation: `${id}.discover`, capabilities}};
}
function operation(capability: DeviceCapability | DeviceProviderDto['definition']['capabilities'][number], bundleInput: boolean): OperationDto {
  let fields: Record<string, unknown> = {}; let required: string[] = [];
  if (capability.id === 'connect' || capability.id === 'disconnect') {fields = {address: stringSchema}; required = ['address'];}
  else if (capability.id === 'app.install') {fields = {artifact_id: stringSchema}; required = ['artifact_id'];}
  else if (capability.id === 'app.install_apks') {fields = {artifact_id: stringSchema, modules: moduleSchema}; required = ['artifact_id'];}
  else if (capability.id !== 'packages') {
    const identifier = bundleInput && capability.id !== 'app.uninstall' ? 'bundle' : 'package';
    fields = {[identifier]: stringSchema, ...(bundleInput && capability.id === 'app.start' ? {ability: stringSchema} : {})}; required = [identifier];
  }
  return {id: capability.operation, title: capability.id, input_schema: envelope(fields, required)};
}
export function createProductFixture() {
  const requests: FixtureRequest[] = [];
  const providers = [provider('fixture.first', false), provider('fixture.second', true)];
  let listedOperations: OperationDto[] = providers.flatMap((item, index) => item.definition.capabilities.map(capability => operation(capability, index === 1)));
  for (const id of ['plugin.android-packages.manifest', 'plugin.android-packages.scan_sdks', 'plugin.android-packages.extract_splits', 'plugin.msgpack.query',
    'plugin.spreadsheet.inspect', 'plugin.spreadsheet.read', 'plugin.tool-supply.catalog', 'plugin.tool-supply.plan', 'plugin.tool-supply.install', 'plugin.tool-supply.remove']) {
    listedOperations.push({id, title: id, input_schema: {type: 'object'}});
  }
  const allOperations = [...listedOperations];
  let installedTool = true; let heldOperation = ''; let failureOperation = ''; let listOutput: string | null = null; let abortedRequests = 0;
  const jobs = new Map<string, Record<string, unknown>>(); const delayed = new Map<string, () => void>(); let sequence = 0;
  for (const [index, file] of fixtureTaskFiles.entries()) {
    jobs.set(file.jobId, {id: file.jobId, operation: `fixture.task-artifact.${index + 1}`, input: {}, created_at: 100 + index, status: 'succeeded', error: null,
      result: {result: {message: '受控任务发布原字节产物'}, artifacts: [{id: file.artifactId, filename: file.filename, media_type: 'application/octet-stream',
        size: file.bytes.length, sha256: file.sha256, created_at: 100 + index}]}});
  }
  const response = (data: unknown, status = 200): Response => new Response(JSON.stringify({log_id: 'fixture-log', data}), {status, headers: {'content-type': 'application/json', 'x-deviceforge-log-id': 'fixture-log'}});
  const metadata = () => ({id: fixtureArtifact, filename: 'fixture.zip', media_type: 'application/zip', size: 64, sha256: 'a'.repeat(64), created_at: 1});
  const tool = () => ({module_id: 'fixture-tool', kind: 'tool', feature_key: null, installed_version: installedTool ? '1.0.0' : null,
    available_version: '1.0.0', entry_present: installedTool, action: installedTool ? 'current' : 'install', required: true, size: 32});
  const directory = (item: DeviceProviderDto): DeviceDirectoryDto => ({provider: item, observed_at: 1, discovery_job_id: 'discovery-fixture', devices: [{
    reference: {provider_id: item.id, generation: item.generation, local_id: 'device-a'}, model: '受控设备', state: 'online',
    capabilities: item.definition.capabilities.filter(capability => capability.scope === 'device').map(capability => ({id: capability.id, version: capability.version, available: true, reason: null})),
  }]});
  function business(operationId: string, input: Record<string, unknown>): unknown {
    if (operationId.endsWith('.packages')) {
      const output = listOutput ?? Array.from({length: 35}, (_, index) => `${operationId.startsWith('fixture.first.') ? 'package:' : ''}com.fixture.app${index}`).join('\n');
      return {result: {output}, artifacts: []};
    }
    if (operationId.startsWith('fixture.')) return {result: operationId.endsWith('.app.detail') ? {name: input['bundle'], unknown_field: '保留字段'} : {output: 'fixture operation completed'}, artifacts: []};
    if (operationId === 'plugin.android-packages.manifest') return {result: {artifact_id: input['artifact_id'], format: 'apk', module: null, package_name: 'com.fixture.package', application_label: '受控安装包', version_name: '1.0', version_code: '1', min_sdk: '23', target_sdk: '35', debuggable: false, permissions: ['android.permission.INTERNET'], xml: '<manifest />'}, artifacts: []};
    if (operationId === 'plugin.msgpack.query') {
      const offset = typeof input['offset'] === 'number' ? input['offset'] : 0; const limit = typeof input['limit'] === 'number' ? input['limit'] : 50;
      const records = [{id: 1, value: '甲'}, {id: 2, value: '乙'}, {id: 3, value: '丙'}].slice(offset, offset + limit);
      return {result: {format_version: 1, source_artifact_id: input['artifact_id'], total: 3, matched: 3, offset, records, next_offset: offset + records.length < 3 ? offset + records.length : null}, artifacts: []};
    }
    if (operationId === 'plugin.spreadsheet.inspect' || operationId === 'plugin.spreadsheet.read') {
      const result = {format_version: 1, artifact_id: input['artifact_id'], source_filename: 'fixture.xlsx', format: 'xlsx', sheets: [{name: '工作表一', index: 0}]};
      if (operationId.endsWith('.inspect')) return {result, artifacts: []};
      const offset = typeof input['offset'] === 'number' ? input['offset'] : 0; const limit = typeof input['limit'] === 'number' ? input['limit'] : 100;
      return {result: {...result, sheet_name: '工作表一', headers: ['count', 'enabled'], rows: [{count: 0, enabled: false}, {count: 1, enabled: true}].slice(offset, offset + limit), total_rows: 2, offset, limit}, artifacts: []};
    }
    if (operationId === 'plugin.tool-supply.catalog') return {result: {manifest_version: '1', source_error: null, modules: [tool()]}, artifacts: []};
    if (operationId === 'plugin.tool-supply.plan') return {result: {manifest_version: '1', download_bytes: installedTool ? 0 : 32, modules: [tool()]}, artifacts: []};
    if (operationId === 'plugin.tool-supply.remove') {installedTool = false; return {result: {module_id: input['module_id'], removed: true, version: '1.0.0'}, artifacts: []};}
    if (operationId === 'plugin.tool-supply.install') {installedTool = true; return {result: {module_id: input['module_id'], version: '1.0.0', changed: true, sha256: 'b'.repeat(64)}, artifacts: []};}
    return {result: {output: '未提供此受控结果'}, artifacts: []};
  }
  const transport: typeof fetch = async (resource, options) => {
    const url = resource instanceof Request ? new URL(resource.url) : new URL(String(resource));
    const method = options?.method ?? 'GET';
    let input: unknown = null;
    if (typeof options?.body === 'string') input = JSON.parse(options.body);
    requests.push({method, path: url.pathname + url.search, input});
    const signal = options?.signal;
    if (signal?.aborted) throw new DOMException('受控请求已取消', 'AbortError');
    if (url.pathname === '/api/v2/operations') return response(listedOperations);
    if (url.pathname === '/api/v2/device-providers') return response(providers);
    if (url.pathname === '/api/v2/devices') return response(providers.map(directory));
    if (url.pathname === '/api/v2/artifacts' && method === 'POST') {
      const contentSize = options?.body instanceof Blob ? options.body.size : 0;
      return response({...metadata(), filename: url.searchParams.get('filename') ?? 'fixture.zip', size: contentSize}, 201);
    }
    if (url.pathname.endsWith('/content')) {
      const file = fixtureTaskFiles.find(item => url.pathname === `/api/v2/artifacts/${item.artifactId}/content`);
      return new Response(new Uint8Array(file?.bytes ?? [1, 2, 3, 4]), {headers: {'content-type': 'application/octet-stream', 'x-deviceforge-log-id': 'fixture-log'}});
    }
    if (url.pathname.endsWith('/entries')) {
      const offset = Number(url.searchParams.get('offset') ?? 0); const limit = Number(url.searchParams.get('limit') ?? 50);
      return response({total: 3, entries: ['first.apk', 'second.apk', 'third.apk'].slice(offset, offset + limit).map(name => ({name, directory: false, size: 16, compressed_size: 8})), next_offset: offset + limit < 3 ? offset + limit : null});
    }
    if (url.pathname.startsWith('/api/v2/artifacts/')) return response(metadata());
    if (url.pathname === '/api/v2/jobs' && method === 'GET') return response([...jobs.values()].slice(0, Number(url.searchParams.get('limit') ?? 50)));
    if (url.pathname === '/api/v2/device-actions' || url.pathname === '/api/v2/jobs' && method === 'POST') {
      if (!object(input)) return response(null, 400);
      const operationId = url.pathname.endsWith('device-actions') ? `${String(input['provider_id'])}.${String(input['capability'])}` : String(input['operation']);
      const businessInput = object(input['input']) ? input['input'] : {};
      const id = `fixture-job-${++sequence}`;
      const job = {id, operation: operationId, input: businessInput, created_at: 1, status: failureOperation === operationId ? 'failed' : heldOperation === operationId ? 'running' : 'succeeded', error: failureOperation === operationId ? '受控任务失败' : null, result: business(operationId, businessInput)};
      jobs.set(id, job); return response(job, 201);
    }
    if (url.pathname.startsWith('/api/v2/jobs/') && url.pathname.endsWith('/events')) {
      const eventJobId = url.pathname.slice('/api/v2/jobs/'.length, -'/events'.length);
      return response(jobs.has(eventJobId) ? [{job_id: eventJobId, sequence: 1, timestamp: 100, status: 'succeeded'}] : []);
    }
    const jobId = url.pathname.startsWith('/api/v2/jobs/') ? url.pathname.slice('/api/v2/jobs/'.length) : '';
    const job = jobs.get(jobId);
    if (job) {
      if (job['operation'] === heldOperation) {
        return new Promise<Response>(resolve => {
          delayed.set(jobId, () => {delayed.delete(jobId); resolve(response({...job, status: 'succeeded'}));});
          signal?.addEventListener('abort', () => {abortedRequests++;}, {once: true});
        });
      }
      return response(job);
    }
    return response(null, 404);
  };
  return {transport, requests, providers, allOperations,
    setOperations(ids: readonly string[]) {listedOperations = allOperations.filter(item => ids.includes(item.id));},
    restoreOperations() {listedOperations = [...allOperations];},
    hold(operationId: string) {heldOperation = operationId;}, fail(operationId: string) {failureOperation = operationId;},
    output(value: string | null) {listOutput = value;},
    release() {heldOperation = ''; for (const finish of [...delayed.values()]) finish();},
    pending: () => delayed.size, aborted: () => abortedRequests,
  };
}
