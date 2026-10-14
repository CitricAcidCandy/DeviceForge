import { ApiError } from '../../../shared/api/index.ts';
import { jsonObject, onlyKeys } from '../../../shared/jobs/index.ts';
import type { DexArtifactInput, DexScanInput, DexSdkRule } from './types.ts';

export type NormalizedDexRule = Readonly<Required<DexSdkRule>>;
export type NormalizedDexScan = DexArtifactInput & { readonly rules: NormalizedDexRule[] };
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const packagePath = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new ApiError('protocol', 'invalid_dex_input', 'DEX输入须为原产物ID及严格有界SDK规则');
export const byteLength = (value: string): number => new TextEncoder().encode(value).length;
function validUnicode(value: string): boolean {
  return [...value].every((character) => { const point = character.codePointAt(0) ?? -1; return point < 0xd800 || point > 0xdfff; });
}
export function isDexSdkRule(value: unknown): value is DexSdkRule {
  return jsonObject(value) && onlyKeys(value, ['name', 'package_path', 'class_name'])
    && typeof value.name === 'string' && /\P{White_Space}/u.test(value.name) && byteLength(value.name) <= 100
    && validUnicode(value.name) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value.name)
    && typeof value.package_path === 'string' && value.package_path.length <= 200 && packagePath.test(value.package_path)
    && (!Object.hasOwn(value, 'class_name') || value.class_name === null || typeof value.class_name === 'string' && value.class_name.length <= 100 && identifier.test(value.class_name));
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
export function frozenCopy<T>(value: T): T { const copy = structuredClone(value); freeze(copy); return copy; }
export function normalizeDexId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw invalid();
  return value.toLowerCase();
}
export function normalizeInspect(input: DexArtifactInput): DexArtifactInput {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id'])) throw invalid();
  return frozenCopy({ artifact_id: normalizeDexId(input.artifact_id) });
}
export function normalizeScan(input: DexScanInput): NormalizedDexScan {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id', 'rules']) || !Array.isArray(input.rules)
    || input.rules.length < 1 || input.rules.length > 100 || !input.rules.every(isDexSdkRule)) throw invalid();
  const rules = input.rules.filter(isDexSdkRule).map((rule) => ({ name: rule.name, package_path: rule.package_path, class_name: rule.class_name ?? null }));
  if (new Set(rules.map((rule) => rule.name)).size !== rules.length) throw invalid();
  return frozenCopy({ artifact_id: normalizeDexId(input.artifact_id), rules });
}
export function isDefinitionSchema(value: unknown): boolean { return jsonObject(value) && value.type === 'object'; }
