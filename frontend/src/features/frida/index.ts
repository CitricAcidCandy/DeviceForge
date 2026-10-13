import type { ArtifactAccess } from '../../plugin-sdk/index.ts';
import { abortable } from '../../shared/api/abort.ts';
import { ApiError, operationsEndpoint, uploadEndpoint } from '../../shared/api/index.ts';
import type { ApiClient } from '../../shared/api/index.ts';
import { createHttpJobGateway, createJobRunner, downloadPublishedArtifact, requireJson } from '../../shared/jobs/index.ts';
import type { JobGateway, JobTicket, PublishedResult } from '../../shared/jobs/index.ts';
import { fridaDuration, frozenFridaCopy, requireFridaBusinessInput, requireFridaInput } from './rules.ts';
import { decodeDeployment, decodeProcesses, decodeScript, decodeServerRun, decodeStatus } from './results.ts';
import type { FridaAction, FridaOptions, FridaPermissionsInput, FridaScriptInput } from './types.ts';
import { createFridaCatalog, fridaOperation, isFridaOperation } from './catalog.ts';

export type * from './types.ts';
export function createFrida(gateway: JobGateway, artifacts: ArtifactAccess, options: FridaOptions = {}) {
  const jobs = createJobRunner(gateway, options); const lifetime = new AbortController();
  const catalog = createFridaCatalog(options.operations);
  const current = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  const operation = fridaOperation;
  function checkTicket(action: FridaAction, ticket: JobTicket): void {
    if (ticket.operation !== operation(action)) throw new ApiError('protocol', 'invalid_frida_ticket', '恢复任务与 Frida 操作不匹配');
  }
  function run<T>(action: FridaAction, deviceId: string, input: unknown, signal: AbortSignal, decode: (value: unknown, logId: string | null) => T) {
    requireFridaInput(action, deviceId, input);
    const copied = frozenFridaCopy(requireJson(input));
    const selected = catalog.requireOperation(action);
    return jobs.execute(selected, frozenFridaCopy({ device_id: deviceId, input: copied }), current(signal), decode);
  }
  async function upload(content: Blob, script: boolean, signal: AbortSignal) {
    const active = current(signal);
    if (active.aborted) throw new ApiError('cancelled', 'cancelled', 'Frida 产物上传等待已取消');
    if (content.size === 0 || content.size > 64 * 1024 * 1024) throw new ApiError('protocol', 'invalid_frida_artifact', 'Frida 输入产物须为 1 字节至 64 MiB');
    if (script) {
      const bytes = await abortable(content.arrayBuffer(), active);
      let source: string;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ApiError('protocol', 'invalid_frida_script', 'Frida 脚本须为有效 UTF-8'); }
      if (source.includes('\0')) throw new ApiError('protocol', 'invalid_frida_script', 'Frida 脚本不得包含空字节');
    }
    const filename = script ? 'script.js' : 'frida-server.bin';
    const response = await abortable(artifacts.upload(filename, content, active), active);
    if (!response.data.id || response.data.filename !== filename || response.data.size !== content.size || !/^[0-9a-f]{64}$/i.test(response.data.sha256)) throw new ApiError('protocol', 'invalid_frida_artifact', '上传产物元数据与请求不一致', null, response.logId);
    if (active.aborted) throw new ApiError('cancelled', 'cancelled', 'Frida产物上传等待已取消', null, response.logId);
    return frozenFridaCopy(response);
  }
  return {
    refreshOperations: catalog.refresh,
    snapshot: catalog.snapshot,
    uploadServer: (content: Blob, signal: AbortSignal) => upload(content, false, signal),
    uploadScript: (content: Blob, signal: AbortSignal) => upload(content, true, signal),
    deploy: (deviceId: string, artifactId: string, signal: AbortSignal) => run('server.deploy', deviceId, { artifact_id: artifactId }, signal, decodeDeployment),
    status: (deviceId: string, signal: AbortSignal) => run('server.status', deviceId, {}, signal, decodeStatus),
    processes: (deviceId: string, signal: AbortSignal) => run('processes', deviceId, {}, signal, decodeProcesses),
    runServer: (deviceId: string, durationMs: number, signal: AbortSignal) => run('server.run', deviceId, { duration_ms: durationMs }, signal, (value, logId) => decodeServerRun(value, logId, durationMs)),
    runScript(deviceId: string, input: FridaScriptInput, signal: AbortSignal) {
      requireFridaInput('script.run', deviceId, input);
      const copied = frozenFridaCopy(input);
      const expected = { package: copied.package, mode: copied.mode, duration_ms: copied.duration_ms };
      return run('script.run', deviceId, copied, signal, (value, logId) => decodeScript(value, logId, expected, false));
    },
    analyzePermissions(deviceId: string, input: FridaPermissionsInput, signal: AbortSignal) {
      requireFridaInput('permissions.analyze', deviceId, input);
      const copied = frozenFridaCopy(input);
      const expected = { package: copied.package, mode: copied.mode, duration_ms: copied.duration_ms };
      return run('permissions.analyze', deviceId, copied, signal, (value, logId) => decodeScript(value, logId, expected, true));
    },
    resumeDeploy(ticket: JobTicket, signal: AbortSignal) { checkTicket('server.deploy', ticket); return jobs.resume(ticket, current(signal), decodeDeployment); },
    resumeStatus(ticket: JobTicket, signal: AbortSignal) { checkTicket('server.status', ticket); return jobs.resume(ticket, current(signal), decodeStatus); },
    resumeProcesses(ticket: JobTicket, signal: AbortSignal) { checkTicket('processes', ticket); return jobs.resume(ticket, current(signal), decodeProcesses); },
    resumeRun(ticket: JobTicket, durationMs: number, signal: AbortSignal) {
      checkTicket('server.run', ticket); if (!fridaDuration(durationMs)) throw new ApiError('protocol', 'invalid_frida_input', 'Frida运行时长无效');
      return jobs.resume(ticket, current(signal), (value, logId) => decodeServerRun(value, logId, durationMs));
    },
    resumeScript(ticket: JobTicket, input: FridaScriptInput, signal: AbortSignal) {
      checkTicket('script.run', ticket); requireFridaBusinessInput('script.run', input);
      const expected = { package: input.package, mode: input.mode, duration_ms: input.duration_ms };
      return jobs.resume(ticket, current(signal), (value, logId) => decodeScript(value, logId, expected, false));
    },
    resumePermissions(ticket: JobTicket, input: FridaPermissionsInput, signal: AbortSignal) {
      checkTicket('permissions.analyze', ticket); requireFridaBusinessInput('permissions.analyze', input);
      const expected = { package: input.package, mode: input.mode, duration_ms: input.duration_ms };
      return jobs.resume(ticket, current(signal), (value, logId) => decodeScript(value, logId, expected, true));
    },
    queryJob(ticket: JobTicket, signal: AbortSignal) {
      if (!isFridaOperation(ticket.operation)) throw new ApiError('protocol', 'invalid_frida_ticket', '任务不属于Frida模块');
      return jobs.query(ticket, current(signal));
    },
    cancel(ticket: JobTicket, signal: AbortSignal) {
      if (!isFridaOperation(ticket.operation)) throw new ApiError('protocol', 'invalid_frida_ticket', '任务不属于 Frida 模块');
      return jobs.cancel(ticket, current(signal));
    },
    download<T>(output: PublishedResult<T>, filename: string, signal: AbortSignal) { return downloadPublishedArtifact(artifacts, output, filename, current(signal)); },
    dispose() { lifetime.abort(); catalog.dispose(); jobs.dispose(); },
  };
}
export function createHttpFrida(client: ApiClient, options: Omit<FridaOptions, 'operations'> = {}) {
  const artifacts: ArtifactAccess = {
    async upload(filename, content, signal) {
      const response = await client.call(uploadEndpoint, { filename, content }, signal);
      const artifact = response.data;
      return { data: { id: artifact.id, filename: artifact.filename, mediaType: artifact.media_type, size: artifact.size, sha256: artifact.sha256, createdAt: artifact.created_at }, logId: response.logId };
    },
    download: (id, signal) => client.downloadArtifact(id, signal),
  };
  return createFrida(createHttpJobGateway(client), artifacts, { ...options, operations: { list: (signal) => client.call(operationsEndpoint, undefined, signal) } });
}
