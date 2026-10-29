import { HostError } from '@deviceforge/plugin-sdk';
import type { HostContext, JsonValue } from '@deviceforge/plugin-sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { invalid, natural, record } from './rules.ts';
import type { TaskPublication } from './types.ts';

/** 只接受结果中公开声明的产物，不能根据任意路径猜测下载入口。 */
export function decodePublication(value: JsonValue, logId: string | null): TaskPublication | null {
  if (!record(value) || !Object.hasOwn(value, 'artifacts')) return null;
  if (Object.keys(value).some((key) => key !== 'result' && key !== 'artifacts') ||
    !Object.hasOwn(value, 'result') || !Array.isArray(value.artifacts))
    invalid('任务产物封套格式无效', logId);
  const artifacts = value.artifacts.map((item) => {
    if (!record(item) || typeof item.id !== 'string' || !item.id.trim() ||
      typeof item.filename !== 'string' || !item.filename.trim() ||
      typeof item.media_type !== 'string' || !item.media_type.trim() ||
      !natural(item.size) || !natural(item.created_at) ||
      typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.sha256))
      invalid('任务产物元数据无效', logId);
    return Object.freeze({
      id: item.id, filename: item.filename, mediaType: item.media_type,
      size: item.size, createdAt: item.created_at, sha256: item.sha256.toLowerCase(),
    });
  });
  if (new Set(artifacts.map((item) => item.id)).size !== artifacts.length ||
    new Set(artifacts.map((item) => item.filename)).size !== artifacts.length)
    invalid('任务产物标识或文件名重复', logId);
  return Object.freeze({ result: value.result ?? null, artifacts: Object.freeze(artifacts) });
}
/** 无安全上下文的局域网 HTTP 同样使用 SHA-256，不跳过完整性校验。 */
export async function downloadTaskArtifact(
  context: HostContext, publication: TaskPublication, id: string, caller: AbortSignal,
) {
  const artifact = publication.artifacts.find((item) => item.id === id);
  if (!artifact) invalid('结果中没有指定产物');
  if (!context.artifacts) throw new HostError('protocol', 'artifacts_unavailable', '宿主未提供公开产物下载能力');
  const signal = AbortSignal.any([caller, context.signal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const result = await context.artifacts.download(artifact.id, signal);
  signal.throwIfAborted();
  if (result.data.size !== artifact.size)
    throw new HostError('protocol', 'artifact_size_mismatch', '产物字节数与元数据不一致', result.logId);
  const bytes = new Uint8Array(await result.data.arrayBuffer());
  signal.throwIfAborted();
  const digest = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== artifact.sha256)
    throw new HostError('protocol', 'artifact_digest_mismatch', '产物摘要与元数据不一致', result.logId);
  return result;
}
