import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('动作、验证和批处理及其定向测试满足严格TS，不使用类型断言绕过边界', () => {
  const paths = [
    '../src/plugins/debugger/control-verification.ts', '../src/plugins/debugger/contracts.ts',
    '../src/plugins/debugger/actions.ts', '../src/plugins/debugger/assert.ts', '../src/plugins/debugger/collector.ts',
    '../src/app/debugger-local/ui.ts', '../src/app/debugger-local/ui-parameters.ts', '../src/app/debugger-local/verification.ts',
    '../src/app/debugger-automation/index.ts', '../src/app/debugger-automation/parameters.ts', '../src/app/debugger-automation/evidence.ts',
    './realtime-debugger-actions.test.ts', './realtime-debugger-verification.test.ts', './realtime-debugger-automation.test.ts',
  ].map((path) => fileURLToPath(new URL(path, import.meta.url)));
  const config = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL('../tsconfig.json', import.meta.url)), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); },
  });
  assert.ok(config);
  const program = ts.createProgram(paths, config.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (file) => file, getNewLine: () => '\n',
  }));
  const own = new Set(paths.map((path) => path.replaceAll('\\', '/')));
  for (const file of program.getSourceFiles().filter((file) => own.has(file.fileName.replaceAll('\\', '/')))) {
    function inspect(node: ts.Node) {
      assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, `${file.fileName}不能引入any`);
      assert.ok(!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node) && !ts.isNonNullExpression(node), `${file.fileName}不能用类型断言绕过边界`);
      ts.forEachChild(node, inspect);
    }
    inspect(file);
  }
});
