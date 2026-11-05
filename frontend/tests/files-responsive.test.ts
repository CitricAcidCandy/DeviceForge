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
      element.classList.contains('@min-[1051px]/files:grid-cols-[minmax(240px,280px)_minmax(0,1fr)]'));
    assert.ok(columns);
    assert.notEqual(columns, root, '容器查询应应用到外包装的子布局，不能查询容器本体');
    const source = document.querySelector('aside[aria-label="选择服务器文件"]');
    const content = document.querySelector('[aria-label="文件内容"]');
    assert.ok(source && content);
    for (const area of [source, content]) {
      assert.equal(area.classList.contains('rounded-xl'), false, '连续工作区不再拆成圆角卡片');
      assert.equal(area.classList.contains('bg-white'), false, '来源与内容不再各自铺白卡');
    }
    const metadata = document.querySelector('dl'); assert.ok(metadata);
    assert.ok([...metadata.classList].some((name) => name.startsWith('@min-[641px]/files:grid-cols-')));
    assert.deepEqual([...metadata.querySelectorAll('dt')].map((element) => element.textContent),
      ['产物 ID', '类型', '大小', '发布于', 'SHA-256']);
    assert.equal(metadata.querySelector('dd')?.textContent, '12345678-1234-1234-1234-123456789abc');
    assert.ok(metadata.lastElementChild?.classList.contains('col-span-full'), '末项SHA保留完整横向空间');
    const download = [...content.querySelectorAll('button')].find((element) => element.textContent === '下载原文件');
    const remove = [...content.querySelectorAll('button')].find((element) => element.textContent === '删除产物');
    assert.ok(download && remove);
    assert.ok(metadata.compareDocumentPosition(download) & page.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(metadata.compareDocumentPosition(remove) & page.window.Node.DOCUMENT_POSITION_FOLLOWING);
    const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;');
    const css = compiler.build(['@container/files', ...columns.classList, ...source.classList,
      ...content.classList, ...metadata.classList]);
    assert.match(css, /container-type: inline-size/);
    assert.match(css, /@container files \(width >= 1051px\)/);
    assert.match(css, /@container files \(width >= 641px\)/);
    assert.match(css, /grid-template-columns: minmax\(240px,\s*280px\) minmax\(0,\s*1fr\)/);
    assert.match(css, /grid-template-columns: repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(css, /max-width: 640px/);
    assert.match(css, /padding-right: 28px|padding-right: calc\(var\(--spacing\) \* 7\)/);
    assert.match(css, /border-right-style: var\(--tw-border-style\)/);
    assert.match(css, /border-bottom-style: var\(--tw-border-style\)/);
    assert.match(css, /gap: calc\(var\(--spacing\) \* 6\)/);
    assert.match(css, /gap: calc\(var\(--spacing\) \* 8\)/);
    assert.doesNotMatch(css, /@media/);
  } finally {
    page?.window.close();
    browser.dispose();
    release();
  }
});

test('两个文件业务实例的上传与产物标签只指向各自控件', () => {
  const release = installPublicUi();
  const browser = createFileBrowser({
    metadata: async () => { throw new Error('渲染表单不读取产物'); },
    entries: async () => { throw new Error('渲染表单不读取目录'); },
    remove: async () => { throw new Error('渲染表单不删除产物'); },
  });
  let page: JSDOM | undefined;
  try {
    page = new JSDOM(renderToStaticMarkup(createElement('div', null,
      createElement(FilesView, { browser }), createElement(FilesView, { browser }))));
    const document = page.window.document;
    const sections = [...document.querySelectorAll('section[aria-label="文件与产物"]')];
    assert.equal(sections.length, 2);
    const ids = [...document.querySelectorAll('input')].map((input) => input.id);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4);
    for (const section of sections) {
      const labels = [...section.querySelectorAll('label')];
      assert.equal(labels.length, 2);
      for (const label of labels) {
        const control = document.getElementById(label.htmlFor);
        assert.ok(control && section.contains(control), `${label.textContent}必须关联本实例控件`);
      }
      const empty = section.querySelector('[aria-label="文件内容"]'); assert.ok(empty);
      assert.equal(empty.querySelector('.text-center'), null, '原空状态按连续内容区左对齐');
    }
  } finally {
    page?.window.close();
    browser.dispose();
    release();
  }
});
