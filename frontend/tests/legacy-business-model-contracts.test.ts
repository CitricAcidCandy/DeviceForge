import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createFrida } from '../src/features/frida/index.ts';
import { createAutomation } from '../src/features/automation/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { OperationDto } from '../src/services/api/index.ts';
import { JobFailure, JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { JobGateway } from '../src/shared/jobs/index.ts';
import type { ArtifactAccess } from '../src/plugin-sdk/index.ts';
import type {
  FridaOptions as LegacyFridaOptions, FridaCatalogSnapshot as LegacyFridaSnapshot,
  FridaScriptInput as LegacyFridaScript,
} from '../src/features/frida/types/index.ts';
import type {
  AutomationOptions as LegacyAutomationOptions, AutomationSequence as LegacySequence,
  AutomationCatalogSnapshot as LegacyAutomationSnapshot,
} from '../src/features/automation/types/index.ts';
import type {
  DesktopRepeat as LegacyDesktopRepeat, InputTracePlayback as LegacyTracePlayback,
} from '../src/features/automation/types/desktop.ts';
import type { FridaOptions, FridaCatalogSnapshot, FridaScriptInput } from '@deviceforge/frida/model';
import type {
  AutomationOptions, AutomationSequence, DesktopRepeat, InputTracePlayback, AutomationCatalogSnapshot,
} from '@deviceforge/automation/model';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type LegacyBusinessTypeContracts = [
  Assert<Equal<LegacyFridaOptions, FridaOptions>>,
  Assert<Equal<keyof LegacyFridaSnapshot, keyof FridaCatalogSnapshot>>,
  Assert<Equal<LegacyFridaSnapshot['operations'], readonly Readonly<OperationDto>[]>>,
  Assert<Equal<LegacyFridaSnapshot['error'], ApiError | null>>,
  Assert<Equal<LegacyFridaScript, FridaScriptInput>>,
  Assert<Equal<LegacyAutomationOptions, AutomationOptions>>,
  Assert<Equal<LegacySequence, AutomationSequence>>,
  Assert<Equal<LegacyDesktopRepeat, DesktopRepeat>>,
  Assert<Equal<LegacyTracePlayback, InputTracePlayback>>,
  Assert<Equal<keyof LegacyAutomationSnapshot, keyof AutomationCatalogSnapshot>>,
  Assert<Equal<LegacyAutomationSnapshot['operations'], readonly Readonly<OperationDto>[]>>,
  Assert<Equal<LegacyAutomationSnapshot['error'], ApiError | null>>,
];

const signal = () => new AbortController().signal;
const artifacts: ArtifactAccess = {
  async upload() { throw new Error('本单元不上传'); },
  async download() { throw new Error('本单元不下载'); },
};
function gateway(status: 'failed' | 'running', failure: Error): JobGateway {
  return {
    async submit(operation) {
      return { data: { id: 'compat-job', operation, status, error: '真实任务失败' }, logId: 'submit-log' };
    },
    async getJob() { throw failure; },
    async cancelJob() { throw new Error('本单元不取消服务器任务'); },
  };
}
function facades(jobs: JobGateway, directoryFailure?: Error) {
  const options = {
    pollIntervalMs: 0,
    ...(directoryFailure ? { operations: { async list() { throw directoryFailure; } } } : {}),
  };
  const frida = createFrida(jobs, artifacts, options);
  const automation = createAutomation(jobs, options);
  return [
    { id: 'frida', model: frida, invoke: () => frida.status('device-1', signal()) },
    { id: 'automation', model: automation, invoke: () => automation.mousePosition(signal()) },
  ];
}

test('旧领域类型从公开模型转发，仅目录快照保留真实宿主 DTO 兼容', () => {
  for (const [feature, entry] of [
    ['frida', 'index'], ['automation', 'index'], ['automation', 'desktop'],
  ]) {
    const path = `../src/features/${feature}/types/${entry}.ts`;
    const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest, true);
    const exports = source.statements.filter(ts.isExportDeclaration);
    assert.equal(exports.length, 1, path);
    const statement = exports[0];
    assert.ok(statement && statement.isTypeOnly, path);
    assert.ok(statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier), path);
    assert.equal(statement.moduleSpecifier.text, `@deviceforge/${feature}/model`, path);
    for (const node of source.statements.filter((item) => !ts.isExportDeclaration(item))) {
      const compatibleSnapshot = ts.isInterfaceDeclaration(node) &&
        node.name.text === (feature === 'frida' ? 'FridaCatalogSnapshot' : 'AutomationCatalogSnapshot');
      assert.ok(compatibleSnapshot || ts.isImportDeclaration(node) && node.importClause?.isTypeOnly, path);
    }
  }
});

test('旧目录入口保留宿主错误身份、原错误码和日志，不误包装成未知网络失败', async () => {
  const failure = new ApiError('http', 'missing_plugin', '贡献已停止', 503, 'catalog-error-log');
  for (const { id, model } of facades(gateway('failed', failure), failure)) {
    try {
      await assert.rejects(async () => model.refreshOperations(signal()), (error: unknown) =>
        error === failure && error instanceof ApiError && error.logId === 'catalog-error-log', id);
      assert.equal(model.snapshot().error, failure, id);
      assert.equal(model.snapshot().logId, 'catalog-error-log', id);
    } finally { model.dispose(); }
  }
});

test('旧任务入口保留失败及结果未知的异常身份、原票据和等待原因', async () => {
  const failure = new ApiError('network', 'poll_failed', '任务结果未知', null, 'poll-log');
  for (const status of ['failed', 'running'] as const) {
    for (const { id, model, invoke } of facades(gateway(status, failure))) {
      try {
        await assert.rejects(invoke, (error: unknown) => status === 'failed'
          ? error instanceof JobFailure && error.job.id === 'compat-job' &&
            error.submitLogId === 'submit-log'
          : error instanceof JobWaitFailure && error.job.id === 'compat-job' &&
            error.submitLogId === 'submit-log' && error.cause === failure, id);
      } finally { model.dispose(); }
    }
  }
});
