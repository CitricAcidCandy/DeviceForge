import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from '@tailwindcss/node';
import postcss from 'postcss';
import { JSDOM } from 'jsdom';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const imports = registerCompositionStartupImports();
after(imports.dispose);
const { Tabs, TabsList, TabsTrigger, TabsContent } = await import('../src/components/Tabs/index.tsx');
const source = await readFile(new URL('../src/app/styles.css', import.meta.url), 'utf8');
const compiler = await compile(source, {
  base: fileURLToPath(new URL('../src/app', import.meta.url)), onDependency() {},
});

/** 仅解析真实主题长度；容器条件在下方按本用例指定值展开，不模拟浏览器几何。 */
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

function presentation(containerWidth: number, namedContainer = false, compact = false) {
  const markup = renderToStaticMarkup(createElement(Tabs, {
    defaultValue: 'summary', ...(namedContainer ? { className: '@container/package-analysis' } : {}),
  },
  createElement(TabsList, { 'aria-label': '分析结果',
    ...(compact ? { className: '@max-[640px]:min-h-[28px] @max-[640px]:gap-[3px]' } : {}),
  },
  createElement(TabsTrigger, { value: 'summary',
    ...(compact ? { className: '@max-[640px]:min-h-[28px]' } : {}),
  }, '概览'),
  createElement(TabsTrigger, { value: 'details' }, '详细结果')),
  createElement(TabsContent, { value: 'summary' }, '当前摘要')));
  const browser = new JSDOM(`<!doctype html><html><head></head><body>${markup}</body></html>`);
  const candidates = [...new Set([...browser.window.document.querySelectorAll('[class]')]
    .flatMap((element) => [...element.classList]))];
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
  // 无层旧规则始终放在工具层之后；不把媒体、supports或其他未知条件当作成立。
  const active = postcss.parse(`${utilities.join('\n')}\n${unlayered.join('\n')}`);
  active.walkAtRules((condition) => {
    const maximum = condition.name === 'container' ? /^\(width < (\d+)px\)$/.exec(condition.params) : null;
    if (maximum?.[1] && containerWidth < Number(maximum[1])) condition.replaceWith(...condition.nodes ?? []);
    else condition.remove();
  });
  active.walkDecls((declaration) => { declaration.value = resolveValue(declaration.value, variables); });
  // JSDOM无法可靠匹配任意变体的转义类名；只将同一真实类等价改名，不替换规则声明。
  const aliases = [...candidates].sort((left, right) => right.length - left.length).map((candidate, index) => {
    const alias = `tabs-test-class-${index}`;
    for (const element of browser.window.document.querySelectorAll('[class]')) {
      if (element.classList.contains(candidate)) element.classList.add(alias);
    }
    return { escaped: `.${candidate.replace(/[^a-zA-Z0-9_-]/g, '\\$&')}`, alias: `.${alias}` };
  });
  active.walkRules((rule) => {
    for (const { escaped, alias } of aliases) rule.selector = rule.selector.replaceAll(escaped, alias);
  });
  const stylesheet = browser.window.document.createElement('style');
  stylesheet.textContent = active.toString();
  browser.window.document.head.append(stylesheet);
  const style = (slot: string) => {
    const element = browser.window.document.querySelector(`[data-slot="${slot}"]`);
    assert.ok(element, `缺少原页签区域：${slot}`);
    return browser.window.getComputedStyle(element);
  };
  return { document: browser.window.document, style, close: () => browser.window.close() };
}

test('公共页签按自身窄容器恢复44px触控和原间距，保留命名容器及选中语义', () => {
  const narrow = presentation(480), named = presentation(480, true), wide = presentation(900), boundary = presentation(640);
  try {
    for (const result of [narrow, named]) {
      const list = result.style('tabs-list'), trigger = result.style('tabs-trigger');
      assert.equal(list.gap, '4px');
      assert.equal(list.minHeight, '44px');
      assert.equal(list.flexWrap, 'wrap');
      assert.equal(trigger.minHeight, '44px');
      assert.equal(trigger.flex, '1 0 auto');
      assert.equal(result.style('tabs').getPropertyValue('container-type'), 'inline-size');
      assert.equal(result.document.querySelector('[role="tablist"]')?.getAttribute('aria-label'), '分析结果');
      assert.equal(result.document.querySelector('[role="tab"][data-state="active"]')?.textContent, '概览');
      assert.equal(result.document.querySelector('[role="tab"][data-state="active"]')?.getAttribute('aria-selected'), 'true');
      assert.equal(result.document.querySelector('[role="tabpanel"]')?.textContent, '当前摘要');
    }
    assert.equal(named.style('tabs').getPropertyValue('container-name'), 'package-analysis', '公共默认不夺走业务声明的容器名');
    for (const result of [wide, boundary]) {
      assert.equal(result.style('tabs-list').gap, '16px');
      assert.notEqual(result.style('tabs-list').minHeight, '44px');
      assert.notEqual(result.style('tabs-trigger').minHeight, '44px');
    }
  } finally { for (const result of [narrow, named, wide, boundary]) result.close(); }
});

test('调用方相同窄容器条件可覆盖页签默认高度与间距', () => {
  const narrow = presentation(480, true, true), wide = presentation(900, true, true);
  try {
    assert.equal(narrow.style('tabs-list').minHeight, '28px');
    assert.equal(narrow.style('tabs-list').gap, '3px');
    assert.equal(narrow.style('tabs-trigger').minHeight, '28px');
    assert.equal(narrow.style('tabs').getPropertyValue('container-name'), 'package-analysis');
    assert.equal(wide.style('tabs-list').gap, '16px', '窄容器覆盖不影响宽区域');
    assert.notEqual(wide.style('tabs-list').minHeight, '28px');
  } finally { narrow.close(); wide.close(); }
});
