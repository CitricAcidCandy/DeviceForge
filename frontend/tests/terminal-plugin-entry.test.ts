import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { manifestPluginSources } from '../src/app/composition/manifest-sources.ts';

test('真实终端清单和工厂经原管理器激活工作区，无业务挂载或隐式网络请求', async () => {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../plugins/terminal/manifest.json', import.meta.url), 'utf8'));
  const directory = manifestPluginSources({ 'plugins/terminal/manifest.json': manifest }, {
    'plugins/terminal/src/index.ts': () => import('../plugins/terminal/src/index.ts'),
  });
  assert.deepEqual(directory.diagnostics, []);
  const source = directory.sources[0];
  assert.ok(source);
  assert.equal(source.id, 'deviceforge_terminal');
  let requests = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { requests++; throw new Error('登记目录不应执行业务'); },
  });
  try {
    runtime.bundledPlugins.register({ id: source.id, trusted: true, loader: source.loader });
    await runtime.webPlugins.load(source.id);
    assert.equal(runtime.webPlugins.diagnosticSnapshot().find((entry) => entry.id === source.id)?.state, 'loaded');
    const ui = runtime.host.ui;
    assert.ok(ui);
    const pages = ui.catalog().pages.filter((page) => page.route === '/terminal');
    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.pluginId, source.id);
    assert.equal(ui.snapshot().instances.filter((instance) =>
      instance.provider?.pluginId === source.id && instance.state === 'ready').length, 1);
    assert.equal(requests, 0);
    await runtime.webPlugins.unload(source.id);
    assert.equal(ui.catalog().pages.some((page) => page.route === '/terminal'), false);
    assert.equal(requests, 0);
  } finally { await runtime.dispose(); }
});

test('终端生产源码只消费本工程或公开包，不回导宿主业务私有实现', () => {
  const root = fileURLToPath(new URL('../plugins/terminal/src', import.meta.url));
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((entry) => /\.tsx?$/.test(entry))) {
    const file = resolve(root, entry), text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    function visit(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
        imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      if (specifier.startsWith('.')) {
        const path = relative(root, resolve(dirname(file), specifier));
        assert.ok(!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'),
          `${entry} 私有路径越界：${specifier}`);
      } else assert.ok([
        '@deviceforge/plugin-sdk', '@deviceforge/contracts/api', '@deviceforge/business-kit/api',
        '@deviceforge/business-kit/jobs', '@deviceforge/business-kit/react', '@deviceforge/business-kit/workspace',
        'react', 'react-dom/client', 'radix-ui', 'lucide-react', '@xterm/xterm', '@xterm/addon-fit',
        '@xterm/xterm/css/xterm.css',
      ].includes(specifier), `${entry} 未知公开依赖：${specifier}`);
    }
  }
});
