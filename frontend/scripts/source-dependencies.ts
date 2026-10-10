import ts from 'typescript';
import { parse } from 'svelte/compiler';

interface SourceDependency { readonly value: string; readonly line: number }
interface SourceInspection { readonly dependencies: SourceDependency[]; readonly issues: string[] }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sourceLine(node: Record<string, unknown>): number {
  const location = node['loc'];
  const start = record(location) ? location['start'] : undefined;
  return record(start) && typeof start['line'] === 'number' ? start['line'] : 1;
}

// 使用语言解析器读取导入与网络边界，字符串和注释不会被误判为代码。
export function inspectSource(source: string, filename: string): SourceInspection {
  const dependencies: SourceDependency[] = [];
  const issues: string[] = [];
  const network = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);
  if (filename.endsWith('.svelte')) {
    const root = parse(source, { modern: true });
    function visit(node: unknown): void {
      if (!record(node)) return;
      const type = node['type'];
      const source = node['source'];
      if (typeof type === 'string' && ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(type)
        && record(source) && typeof source['value'] === 'string') {
        dependencies.push({ value: source['value'], line: sourceLine(node) });
      }
      if (type === 'ImportExpression') {
        if (record(source) && typeof source['value'] === 'string') dependencies.push({ value: source['value'], line: sourceLine(node) });
        else issues.push('动态导入必须使用可检查的字面量');
      }
      if (type === 'TSAnyKeyword') issues.push('不得使用 any 绕过类型边界');
      if (type === 'CallExpression' || type === 'NewExpression') {
        const callee = node['callee'];
        if (record(callee)) {
          if (callee['type'] === 'Identifier' && callee['name'] === 'require') issues.push('浏览器源码不得使用 require');
          const property = callee['property'];
          const name = callee['name'] ?? (record(property) ? property['name'] : undefined);
          if (typeof name === 'string' && network.has(name)) issues.push('network');
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') continue;
        if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
      }
    }
    // 同时覆盖模板事件表达式及实例 / 模块脚本。
    visit(root);
  } else {
    const root = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
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
  }
  return { dependencies, issues };
}
