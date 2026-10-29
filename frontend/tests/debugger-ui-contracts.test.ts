import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

test('官方面板、活动和数据模型在真实插件类型配置下满足严格契约', () => {
  const configPath = fileURLToPath(new URL('../../examples/browser-debugger/tsconfig.json', import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  assert.equal(parsed.errors.length, 0);
  const tests = ['debugger-controller-data-activity.test.ts', 'debugger-activity-presentation.test.ts',
    'debugger-automation-labels.test.ts', 'debugger-data-view.test.ts', 'debugger-report-activity.test.ts', 'debugger-ui-contracts.test.ts']
    .map(name => fileURLToPath(new URL(name, import.meta.url)));
  const program = ts.createProgram([...parsed.fileNames, ...tests], { ...parsed.options, noEmit: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
});
