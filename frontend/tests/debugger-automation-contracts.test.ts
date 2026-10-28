import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

test('自动调试执行器与所属用例满足严格TS契约，只检查本功能入口', () => {
  const source = fileURLToPath(new URL('../src/app/debugger-automation/', import.meta.url));
  const roots = [
    ...readdirSync(source).filter((file) => file.endsWith('.ts')).map((file) => source + file),
    fileURLToPath(new URL('./debugger-automation.test.ts', import.meta.url)),
    fileURLToPath(new URL('./debugger-automation-contracts.test.ts', import.meta.url)),
  ];
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true,
    skipLibCheck: true, allowImportingTsExtensions: true, esModuleInterop: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: ['node'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (file) => file, getNewLine: () => '\n',
  }));
  const owned = new Set(roots.map((file) => ts.sys.resolvePath(file).replace(/\\/g, '/')));
  for (const file of program.getSourceFiles().filter((file) => owned.has(file.fileName.replace(/\\/g, '/')))) {
    function inspect(node: ts.Node) {
      assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, `${file.fileName}不能引入any`);
      assert.ok(!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node) && !ts.isNonNullExpression(node),
        `${file.fileName}不能用类型断言跳过边界`);
      ts.forEachChild(node, inspect);
    }
    inspect(file);
  }
});
