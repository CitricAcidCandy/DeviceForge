import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { MarketplaceEntry } from '../src/features/marketplace/index.ts';
import { createProductServices } from '../src/app/product/services.ts';
import { plugin, signal, success } from './fixtures.ts';
import { release } from './plugin-installations-fixture.ts';

test('市场清理警告不禁用操作，真正文件恢复故障仍禁用启用和更新（无服务）', async () => {
  const loader = registerHooks({ load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.tsx')) return {
      shortCircuit: true, format: 'module',
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: url, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
    if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
    return nextLoad(url, context);
  } });
  try {
    const { MarketplaceCard } = await import('../src/pages/marketplace/components/MarketplaceCard/index.tsx');
    const { useMarketplace } = await import('../src/pages/marketplace/use-marketplace.ts');
    const entry: MarketplaceEntry = {
      metadata_version: 1, id: 'example-release', name: '示例功能', kind: 'plugin', version: '2.0.0',
      summary: '完整功能', description: '', keywords: [], categories: [], applies_to: ['deviceforge'],
      supports_mcp: 'none', supports_agent: false, restart_policy: 'plugin_reload', platforms: [], architectures: [],
      details: { release_format: 1 }, source: 'http://market.test', sourceName: '测试市场', resource_id: 'a'.repeat(64),
    };
    for (const phase of ['component_cleanup', 'activation_cleanup', 'commit_rollback']) {
      const installation = { ...release(false), status: 'recovery_blocked' as const, failure: { phase, reason: '原始失败原因' } };
      const html = renderToStaticMarkup(createElement(MarketplaceCard, {
        entry, installation, installed: { version: '1.0.0' }, installedTab: true, busy: false,
        onDetail() {}, onDownload() {}, onInstall() {}, onRemove() {}, onConfigure() {}, onSetEnabled() {},
      }));
      const dom = new JSDOM(html);
      try {
        const button = (label: string) => {
          const value = [...dom.window.document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
          assert.ok(value, `缺少按钮：${label}`); return value;
        };
        assert.equal(button('启用').disabled, phase === 'commit_rollback');
        assert.equal(button('更新').disabled, phase === 'commit_rollback');
        assert.equal(button('卸载').disabled, false);
        assert.match(dom.window.document.body.textContent ?? '', phase !== 'commit_rollback' ? /上次组件操作告警，可重试.*原始失败原因/ : /恢复受阻/);
      } finally { dom.window.close(); }
    }
    const services = createProductServices({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
      transport: async () => success([plugin({ cleanup_failed: true })]) });
    try {
      await services.runtime.serverPlugins.refresh(signal());
      let observed = false;
      function Probe() {
        const market = useMarketplace(services, false, true);
        assert.equal(market.installedEntries[0]?.removeDisabled, false);
        assert.deepEqual(market.cleanupWarnings, ['example']);
        observed = true;
        return null;
      }
      renderToStaticMarkup(createElement(Probe));
      assert.equal(observed, true);
    } finally { await services.dispose(); }
  } finally { loader.deregister(); }
});
