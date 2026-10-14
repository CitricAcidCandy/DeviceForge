import { ApiError } from '../../../services/api/index.ts';
import { jsonObject, onlyKeys } from '../../../shared/jobs/index.ts';
import { aiProjectId, requireAiInput } from './rules.ts';
import type { AiSingleInput } from '../types/index.ts';

export interface AiLegacySingleOptions {
  readonly projectBindings: Readonly<Record<string, AiSingleInput['project_id']>>;
}

export function convertLegacyAiSingleRequest(
  value: unknown,
  options: AiLegacySingleOptions,
): AiSingleInput {
  if (
    typeof value === 'object' &&
    value !== null &&
    ['timeoutMs', 'requestId'].some((field) => Object.hasOwn(value, field))
  ) {
    throw new ApiError(
      'protocol',
      'unsupported_legacy_ai_fields',
      '旧单次请求的超时或请求身份没有等价公开字段',
    );
  }
  if (
    !jsonObject(value) ||
    !onlyKeys(value, ['projectRoot', 'userPrompt']) ||
    typeof value.projectRoot !== 'string' ||
    !value.projectRoot.trim() ||
    typeof value.userPrompt !== 'string'
  ) {
    throw new ApiError('protocol', 'invalid_legacy_ai_input', '旧 AI 单次请求字段无效');
  }
  if (
    !jsonObject(options) ||
    !onlyKeys(options, ['projectBindings']) ||
    !jsonObject(options.projectBindings) ||
    Object.entries(options.projectBindings).some(
      ([directory, projectId]) => !directory.trim() || !aiProjectId(projectId),
    )
  ) {
    throw new ApiError('protocol', 'invalid_legacy_ai_bindings', 'AI 目录与公开项目身份绑定无效');
  }
  const projectId = options.projectBindings[value.projectRoot];
  if (!Object.hasOwn(options.projectBindings, value.projectRoot) || typeof projectId !== 'string') {
    throw new ApiError(
      'protocol',
      'unbound_legacy_ai_project',
      '旧 AI 项目目录没有显式公开项目绑定',
    );
  }
  const input = { project_id: projectId, prompt: value.userPrompt };
  requireAiInput(input, true);
  return input;
}
