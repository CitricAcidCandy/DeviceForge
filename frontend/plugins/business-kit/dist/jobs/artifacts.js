import { sha256 } from '@noble/hashes/sha2.js';
import { abortable, ApiError, isRecord } from "../api/index.js";
import { invalidBusinessResult, naturalNumber, nonemptyText, onlyKeys } from "./values.js";
export function isTaskArtifact(value) {
    return isRecord(value) && nonemptyText(value.id) && nonemptyText(value.filename) &&
        nonemptyText(value.mediaType) && naturalNumber(value.size) && naturalNumber(value.createdAt) &&
        typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(value.sha256);
}
/** 任务封套是未知业务数据，边界校验后映射到同一份公开 SDK 产物模型。 */
function artifact(value) {
    if (isTaskArtifact(value))
        return Object.freeze({ ...value });
    if (!isRecord(value) || !nonemptyText(value.id) || !nonemptyText(value.filename) ||
        !nonemptyText(value.media_type) || !naturalNumber(value.size) || !naturalNumber(value.created_at) ||
        typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256))
        return null;
    return Object.freeze({
        id: value.id, filename: value.filename, mediaType: value.media_type,
        size: value.size, createdAt: value.created_at, sha256: value.sha256,
    });
}
export function decodeArtifactEnvelope(value, module, logId) {
    if (!isRecord(value) || !onlyKeys(value, ['result', 'artifacts']) ||
        !Object.hasOwn(value, 'result') || !Array.isArray(value.artifacts))
        throw invalidBusinessResult(module, logId);
    const artifacts = value.artifacts.map(artifact);
    if (artifacts.some((item) => !item))
        throw invalidBusinessResult(module, logId);
    const valid = artifacts.filter((item) => item !== null);
    if (new Set(valid.map((item) => item.id)).size !== valid.length ||
        new Set(valid.map((item) => item.filename)).size !== valid.length)
        throw invalidBusinessResult(module, logId);
    return { result: value.result, artifacts: valid };
}
export function decodeEmptyArtifactResult(value, module, logId) {
    const envelope = decodeArtifactEnvelope(value, module, logId);
    if (envelope.artifacts.length)
        throw invalidBusinessResult(module, logId);
    return envelope.result;
}
export function requireArtifactNames(envelope, names, module, logId) {
    if (envelope.artifacts.length !== names.length ||
        !names.every((name) => envelope.artifacts.some((item) => item.filename === name)))
        throw invalidBusinessResult(module, logId);
}
export async function downloadPublishedArtifact(reader, result, filename, signal) {
    if (signal.aborted)
        throw new ApiError('cancelled', 'cancelled', '产物读取等待已取消');
    const found = result.artifacts.find((item) => item.filename === filename);
    if (!found || !isTaskArtifact(found))
        throw new ApiError('protocol', 'missing_artifact', '结果中没有有效的指定产物');
    const downloaded = await abortable(reader.download(found.id, signal), signal);
    if (downloaded.data.size !== found.size)
        throw new ApiError('protocol', 'artifact_size_mismatch', '产物字节数与元数据不一致', null, downloaded.logId);
    let hash;
    try {
        const bytes = await abortable(downloaded.data.arrayBuffer(), signal);
        hash = globalThis.crypto?.subtle
            ? new Uint8Array(await abortable(globalThis.crypto.subtle.digest('SHA-256', bytes), signal))
            : sha256(new Uint8Array(bytes));
        signal.throwIfAborted();
    }
    catch (error) {
        if (signal.aborted)
            throw new ApiError('cancelled', 'cancelled', '产物读取等待已取消', null, downloaded.logId);
        throw error;
    }
    const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== found.sha256.toLowerCase())
        throw new ApiError('protocol', 'artifact_digest_mismatch', '产物摘要与元数据不一致', null, downloaded.logId);
    return downloaded;
}
