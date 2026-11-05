import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from '@tailwindcss/node';
import postcss from 'postcss';
import type { ChildNode, Document, Root } from 'postcss';
import { JSDOM } from 'jsdom';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const imports = registerCompositionStartupImports();
after(imports.dispose);
const { PageTitle } = await import('../src/components/PageTitle/index.tsx');
const { EmptyState } = await import('../src/components/EmptyState/index.tsx');
const { Button } = await import('../src/components/Button/index.tsx');
const source = await readFile(new URL('../src/app/styles.css', import.meta.url), 'utf8');
const compiler = await compile(source, {
  base: fileURLToPath(new URL('../src/app', import.meta.url)), onDependency() {},
});

/** 只解析实际主题令牌和简单长度，不把条件查询或样式计算当成窗口布局。 */
function resolveValue(value: string, variables: ReadonlyMap<string, string>): string {
  let result = value;
  for (let step = 0; step < 8 && /var\(/.test(result); step++) {
    result = result.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g,
      (match, name: string, fallback: string | undefined) => variables.get(name) ?? fallback ?? match);
  }
  result = result.replace(/(-?\d*\.?\d+)rem\b/g, (_match, count: string) => `${Number(count) * 16}px`);
  return result.replace(/calc\(\s*(-?\d*\.?\d+)px\s*\*\s*(-?\d*\.?\d+)\s*\)/g,
    (_match, length: string, count: string) => `${Number(length) * Number(count)}px`);
}

function presentation() {
  const markup = renderToStaticMarkup(createElement('main', null,
    createElement(PageTitle, { title: '文件', description: '读取、检查和下载服务器文件。',
      children: createElement(Button, null, '刷新目录') }),
    createElement(EmptyState, { title: '暂无文件', description: '选择服务器产物后查看内容。' })));
  const sample = new JSDOM(markup);
  const candidates = [...new Set([...sample.window.document.querySelectorAll('[class]')]
    .flatMap((entry) => [...entry.classList]))];
  sample.window.close();
  const generated = postcss.parse(compiler.build(candidates));
  const variables = new Map<string, string>();
  generated.walkRules((rule) => {
    if (!/^:root(?:,\s*:host)?$/.test(rule.selector)) return;
    rule.walkDecls((declaration) => {
      if (declaration.prop.startsWith('--')) variables.set(declaration.prop, declaration.value);
    });
  });
  const utilities: string[] = [], unlayered: string[] = [];
  generated.each((node) => {
    if (node.type === 'atrule' && node.name === 'layer' && node.params === 'utilities') {
      for (const child of node.nodes ?? []) utilities.push(child.toString());
    } else if (node.type === 'rule') unlayered.push(node.toString());
  });
  // JSDOM不实现级联层；降低工具层选择器权重，确保真实无层兼容规则优先于工具类。
  const utilityLayer = postcss.parse(utilities.join('\n'));
  utilityLayer.walkRules((rule) => { rule.selector = `:where(${rule.selector})`; });
  const unconditional = postcss.parse(`${utilityLayer.toString()}\n${unlayered.join('\n')}`);
  unconditional.walkAtRules((rule) => {
    if (rule.name === 'container' || rule.name === 'media' || rule.name === 'supports') rule.remove();
  });
  unconditional.walkDecls((declaration) => { declaration.value = resolveValue(declaration.value, variables); });
  const page = new JSDOM(`<!doctype html><html><head><style>${unconditional.toString()}</style></head><body>${markup}</body></html>`);
  const document = page.window.document;
  const style = (selector: string) => {
    const element = document.querySelector(selector); assert.ok(element, `缺少展示区域：${selector}`);
    return page.window.getComputedStyle(element);
  };
  return { document, generated, variables, style, close: () => page.window.close() };
}

test('公共页标题和空态保留主分支字号、字重与原内容', () => {
  const result = presentation();
  try {
    const heading = result.style('.page-heading h1'), emptyTitle = result.style('.empty-state h3');
    assert.equal(heading.fontSize, '24px');
    assert.equal(heading.fontWeight, '600');
    assert.equal(heading.lineHeight, '1.35');
    assert.match(heading.letterSpacing, /^0(?:px)?$/);
    assert.equal(emptyTitle.fontSize, '15px');
    assert.equal(emptyTitle.fontWeight, '600');
    assert.equal(result.document.querySelector('.page-heading h1')?.textContent, '文件');
    assert.equal(result.document.querySelector('.page-help button')?.textContent, '使用说明');
    assert.equal(result.document.querySelector('.page-description')?.textContent, '读取、检查和下载服务器文件。');
    assert.equal(result.document.querySelector('.page-heading [data-slot="button"]')?.textContent, '刷新目录');
    assert.equal(result.document.querySelector('.empty-state h3')?.textContent, '暂无文件');
    assert.equal(result.document.querySelector('.empty-state p')?.textContent, '选择服务器产物后查看内容。');
  } finally { result.close(); }
});

test('页标题和空态保持原间距，动作区按自身容器宽度排列', () => {
  const result = presentation();
  try {
    const header = result.style('.page-heading'), empty = result.style('.empty-state');
    assert.equal(header.columnGap || header.gap, '20px');
    assert.equal(header.paddingBottom, '16px');
    assert.equal(header.marginBottom, '24px');
    assert.equal(result.style('.page-help button').minHeight, '24px', '原页说明入口不被通用details规则撑为32px');
    assert.equal(result.style('.page-help').fontSize, '13px');
    // JSDOM不把逻辑方向映射成物理方向，直接核对Tailwind实际输出的上下轴属性。
    assert.equal(empty.getPropertyValue('padding-block'), '24px');
    assert.equal(empty.getPropertyValue('margin-block'), '8px');
    const description = result.style('.empty-state p');
    assert.equal(description.fontSize, '14px');
    assert.equal(description.maxWidth, '490px');
    const action = result.document.querySelector('.page-heading [data-slot="button"]')?.parentElement;
    assert.ok(action);
    assert.equal(action.classList.contains('page-actions'), false,
      '公开标题动作不再受旧裸消费者page-actions最小高度规则控制');
    let named = false, fullWidthAction = false, touchButton = false;
    let defaultButtonMinimum = '';
    // JSDOM无法匹配含多组转义方括号的任意变体，按DOM实际类名核对真实直接子项声明。
    const defaultSelectors = [...action.classList].map((candidate) =>
      `.${candidate.replace(/[^a-zA-Z0-9_-]/g, '\\$&')} > [data-slot=button]`);
    result.generated.walkRules((rule) => {
      if (!defaultSelectors.includes(rule.selector)) return;
      let parent: ChildNode | Document | Root | undefined = rule.parent;
      while (parent) {
        if (parent.type === 'atrule' && parent.name !== 'layer') return;
        parent = parent.parent;
      }
      rule.walkDecls('min-height', (declaration) => {
        defaultButtonMinimum = resolveValue(declaration.value, result.variables);
      });
    });
    assert.equal(defaultButtonMinimum, '36px', '默认直接按钮高度仍来自真实无条件工具规则');
    result.generated.walkDecls('container-name', (declaration) => {
      if (declaration.value === 'page-title') named = true;
    });
    result.generated.walkAtRules('container', (condition) => {
      if (condition.params !== 'page-title (width < 640px)') return;
      condition.walkDecls((declaration) => {
        const value = resolveValue(declaration.value, result.variables);
        let parent: ChildNode | Document | Root | undefined = declaration.parent;
        let selector = '';
        while (parent && parent !== condition.parent) {
          if (parent.type === 'rule') selector = `${parent.selector} ${selector}`;
          parent = parent.parent;
        }
        if (declaration.prop === 'width' && value === '100%') fullWidthAction = true;
        if (declaration.prop === 'min-height' && value === '44px' && /data-slot.*button/.test(selector)) touchButton = true;
      });
    });
    assert.equal(named, true, '标题宽度由自身命名容器提供');
    assert.equal(fullWidthAction, true, '窄标题内动作区独占下一行');
    assert.equal(touchButton, true, '窄标题内直接按钮保留原44px触控高度');
  } finally { result.close(); }
});
