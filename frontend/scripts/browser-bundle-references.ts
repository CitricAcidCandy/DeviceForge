import ts from 'typescript';

export interface BrowserReferences {
  readonly modules: readonly string[];
  readonly assets: readonly string[];
  readonly workers: readonly string[];
  readonly computed: readonly number[];
}
function importMetaBase(node: ts.Node | undefined, source: ts.SourceFile): boolean {
  return node?.getText(source) === 'import.meta.url' || Boolean(node && ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteral(node.left) &&
    node.left.text === '' && node.right.getText(source) === 'import.meta.url');
}
function urlLiteral(node: ts.Node | undefined, source: ts.SourceFile, depth = 0): string | null {
  if (depth > 3) return null;
  if (!node || !ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'URL') return null;
  const [argument, base] = node.arguments ?? [];
  if (!importMetaBase(base, source)) return null;
  if (argument && ts.isStringLiteralLike(argument)) return argument.text;
  // Vite 的 Worker 产物会用同一模块基址再包一层静态 URL.href。
  return argument && ts.isPropertyAccessExpression(argument) && argument.name.text === 'href'
    ? urlLiteral(argument.expression, source, depth + 1) : null;
}
export function javascriptReferences(file: string, text: string): BrowserReferences {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const modules: string[] = [], assets: string[] = [], workers: string[] = [], computed: number[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) modules.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) modules.push(argument.text);
      else computed.push(node.getStart(source));
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
        ['Worker', 'SharedWorker'].includes(node.expression.text)) {
      const path = urlLiteral(node.arguments?.[0], source);
      if (path === null) throw new Error('Worker 入口没有静态 import.meta.url，无法确认资源闭包');
      workers.push(path);
    }
    const asset = urlLiteral(node, source);
    if (asset !== null) assets.push(asset);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { modules, assets, workers, computed };
}

/** 只认可静态 CSS URL；无法确认的转义或变量引用不当作闭包通过。 */
export function cssReferences(text: string): readonly string[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//gu, '');
  const assets: string[] = [];
  for (const match of css.matchAll(/@import\s+([^;]+);/giu)) {
    const value = match[1]?.trim() ?? '';
    const quoted = /^(["'])(.*?)\1/u.exec(value);
    if (quoted?.[2]) assets.push(quoted[2]);
    else if (!/^url\(/iu.test(value)) throw new Error('CSS 导入不是可以确认的静态资源');
  }
  for (const match of css.matchAll(/url\(\s*(?:(["'])([\s\S]*?)\1|([^)]*))\s*\)/giu)) {
    const path = (match[2] ?? match[3] ?? '').trim();
    if (!path || (!path.startsWith('data:') && /[\\()]/u.test(path)))
      throw new Error('CSS URL 包含无法确认的动态或转义引用');
    assets.push(path);
  }
  return assets;
}
