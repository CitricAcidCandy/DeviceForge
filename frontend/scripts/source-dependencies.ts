import ts from 'typescript';

interface SourceDependency { readonly value: string; readonly line: number }
interface SourceInspection { readonly dependencies: SourceDependency[]; readonly issues: string[] }

// 使用语言解析器读取导入与网络边界，字符串和注释不会被误判为代码。
export function inspectSource(source: string, filename: string): SourceInspection {
  const dependencies: SourceDependency[] = [];
  const issues: string[] = [];
  const network = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);
    const root = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
      filename.endsWith('.tsx') ? ts.ScriptKind.TSX : undefined);
    const line = (node: ts.Node) => root.getLineAndCharacterOfPosition(node.getStart(root)).line + 1;
    function visit(node: ts.Node): void {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      if (specifier && ts.isStringLiteralLike(specifier)) dependencies.push({ value: specifier.text, line: line(node) });
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const value = node.arguments[0];
        if (value && ts.isStringLiteralLike(value)) dependencies.push({ value: value.text, line: line(node) });
        else issues.push('动态导入必须使用可检查的字面量');
      }
      if (node.kind === ts.SyntaxKind.AnyKeyword) issues.push('不得使用 any 绕过类型边界');
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        if (name === 'require') issues.push('浏览器源码不得使用 require');
        if (name !== undefined && network.has(name)) issues.push('network');
      }
      ts.forEachChild(node, visit);
    }
    visit(root);
  return { dependencies, issues };
}
