import { jsonObject, naturalNumber, onlyKeys, decodeEmptyArtifactResult, invalidBusinessResult } from '../../shared/jobs/index.ts';
import { byteLength, frozenCopy, isDexSdkRule } from './rules.ts';
import type { NormalizedDexScan } from './rules.ts';
import type { DexArtifactInput, DexCounts, DexFinding, DexInspection, DexScanResult, DexVersion } from './types.ts';

const moduleName = 'DEX直接分析';
const baseKeys = ['artifact_id', 'version', 'file_size', 'counts', 'integrity'];
const isVersion = (value: unknown): value is DexVersion => value === '035' || value === '037' || value === '038' || value === '039' || value === '040';
function isCounts(value: unknown): value is DexCounts {
  return jsonObject(value) && onlyKeys(value, ['strings', 'types', 'prototypes', 'fields', 'methods', 'defined_classes'])
    && naturalNumber(value.strings) && value.strings <= 1000000
    && naturalNumber(value.types) && value.types <= 65535
    && naturalNumber(value.prototypes) && value.prototypes <= 65535
    && naturalNumber(value.fields) && value.fields <= 65535
    && naturalNumber(value.methods) && value.methods <= 65535
    && naturalNumber(value.defined_classes) && value.defined_classes <= value.types && value.types <= value.strings;
}
function isInspection(value: unknown): value is DexInspection {
  if (!jsonObject(value) || typeof value.artifact_id !== 'string' || !isVersion(value.version)
    || !naturalNumber(value.file_size) || value.file_size < 112 || value.file_size > 64 * 1024 * 1024
    || !isCounts(value.counts) || !jsonObject(value.integrity) || !onlyKeys(value.integrity, ['artifact_sha256', 'dex_sha1', 'dex_adler32'])
    || value.integrity.artifact_sha256 !== true || value.integrity.dex_sha1 !== true || value.integrity.dex_adler32 !== true) return false;
  const counts = value.counts;
  return 112 + counts.strings * 4 + counts.types * 4 + counts.prototypes * 12 + counts.fields * 8 + counts.methods * 8 + counts.defined_classes * 32 <= value.file_size
    && (counts.prototypes === 0 || counts.types > 0)
    && (counts.fields === 0 || counts.types > 0)
    && (counts.methods === 0 || counts.types > 0 && counts.prototypes > 0);
}
function simpleName(name: string, version: DexVersion): boolean {
  return name.length > 0 && [...name].every((character) => {
    const point = character.codePointAt(0) ?? -1;
    return /^[A-Za-z0-9$_-]$/.test(character)
      || point >= 0x00a1 && point <= 0x1fff || point >= 0x2010 && point <= 0x2027
      || point >= 0x2030 && point <= 0xd7ff || point >= 0xe000 && point <= 0xffef
      || point >= 0x10000 && point <= 0x10ffff
      || version === '040' && (point === 0x20 || point === 0xa0 || point >= 0x2000 && point <= 0x200a || point === 0x202f);
  });
}
function utf8Before(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left); const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index++) {
    const leftByte = leftBytes[index]; const rightByte = rightBytes[index];
    if (leftByte !== undefined && rightByte !== undefined && leftByte !== rightByte) return leftByte < rightByte;
  }
  return leftBytes.length < rightBytes.length;
}
function isFinding(value: unknown): value is DexFinding {
  return jsonObject(value) && onlyKeys(value, ['rule', 'package_found', 'class_found', 'evidence'])
    && isDexSdkRule(value.rule) && Object.hasOwn(value.rule, 'class_name')
    && typeof value.package_found === 'boolean' && (value.class_found === null || typeof value.class_found === 'boolean')
    && Array.isArray(value.evidence) && value.evidence.length <= 10 && value.evidence.every((name: unknown) => typeof name === 'string');
}
export function decodeInspection(value: unknown, logId: string | null, input: DexArtifactInput): DexInspection {
  const raw = decodeEmptyArtifactResult(value, moduleName, logId);
  if (!jsonObject(raw) || !onlyKeys(raw, baseKeys) || !isInspection(raw) || raw.artifact_id !== input.artifact_id) throw invalidBusinessResult(moduleName, logId);
  return frozenCopy(raw);
}
export function decodeScan(value: unknown, logId: string | null, input: NormalizedDexScan): DexScanResult {
  const raw = decodeEmptyArtifactResult(value, moduleName, logId);
  if (!jsonObject(raw) || !onlyKeys(raw, [...baseKeys, 'findings']) || !isInspection(raw) || raw.artifact_id !== input.artifact_id
    || !('findings' in raw) || !Array.isArray(raw.findings) || !raw.findings.every(isFinding) || raw.findings.length !== input.rules.length) throw invalidBusinessResult(moduleName, logId);
  const findings: DexFinding[] = raw.findings.filter(isFinding);
  const definedEvidence = new Set<string>(); let budget = 1024;
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index]; const rule = input.rules[index];
    if (!finding || !rule || finding.rule.name !== rule.name || finding.rule.package_path !== rule.package_path
      || finding.rule.class_name !== rule.class_name) throw invalidBusinessResult(moduleName, logId);
    const prefix = rule.package_path.replaceAll('.', '/') + '/';
    if (finding.evidence.some((name, position) => name.length > 4094 || !name.startsWith(prefix) || !name.split('/').every((part) => simpleName(part, raw.version))
      || position > 0 && !utf8Before(finding.evidence[position - 1] ?? '', name))
      || finding.package_found !== (finding.evidence.length > 0)
      || (rule.class_name === null ? finding.class_found !== null : finding.class_found !== finding.evidence.includes(prefix + rule.class_name))) throw invalidBusinessResult(moduleName, logId);
    for (const name of finding.evidence) definedEvidence.add(name);
    budget += 200 + (byteLength(rule.name) + byteLength(rule.package_path) + (rule.class_name === null ? 0 : byteLength(rule.class_name))) * 6;
    budget += finding.evidence.reduce((total, name) => total + byteLength(name) * 6 + 3, 0);
  }
  if (budget > 512 * 1024 || definedEvidence.size > raw.counts.defined_classes) throw invalidBusinessResult(moduleName, logId);
  return frozenCopy({ ...raw, findings });
}
