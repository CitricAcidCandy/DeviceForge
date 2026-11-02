import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { compile } from 'tailwindcss';
import { createFileBrowser } from '../plugins/files/src/model/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const loader = registerCompositionStartupImports();
const { FilesView } = await import('../plugins/files/src/view.tsx');
const { installPublicUi } = await import('../src/app/public-ui.ts');
loader.dispose();

test('文件业务插件恢复原返回入口与内容，按实际容器而非宽窗口分栏', async () => {
  const release = installPublicUi();
  const browser = createFileBrowser({
    metadata: async () => ({
      data: {
        id: '12345678-1234-1234-1234-123456789abc', filename: '说明.txt', mediaType: 'text/plain',
        size: 12, sha256: 'a'.repeat(64), createdAt: 1,
      }, logId: null,
    }),
    entries: async () => { throw new Error('文本元数据不读取ZIP目录'); },
    remove: async () => { throw new Error('响应式单元不删除产物'); },
  });
  let page: JSDOM | undefined;
  try {
    await browser.select('12345678-1234-1234-1234-123456789abc', new AbortController().signal);
    page = new JSDOM(renderToStaticMarkup(createElement(FilesView, { browser })));
    const document = page.window.document;
    const root = document.querySelector('section');
    assert.ok(root?.classList.contains('@container/files'));
    assert.equal(document.querySelector('a')?.getAttribute('href'), '#/settings');
    assert.equal(document.querySelector('h1')?.textContent, '文件');
    assert.equal(document.body.textContent?.includes('文件插件'), false);
    const columns = [...document.querySelectorAll('div')].find((element) =>
      element.classList.contains('@3xl/files:grid-cols-[250px_minmax(0,1fr)]'));
    assert.ok(columns);
    assert.ok(document.querySelector('dl')?.classList.contains('@lg/files:grid-cols-2'));
    const compiler = await compile('@theme { --container-3xl: 48rem; --container-lg: 32rem; } @tailwind utilities;');
    const css = compiler.build(['@container/files', ...columns.classList, ...document.querySelector('dl')?.classList ?? []]);
    assert.match(css, /container-type: inline-size/);
    assert.match(css, /@container files \(width >= 48rem\)/);
    assert.match(css, /@container files \(width >= 32rem\)/);
    assert.doesNotMatch(css, /@media/);
  } finally {
    page?.window.close();
    browser.dispose();
    release();
  }
});
