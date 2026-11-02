import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from '@tailwindcss/node';
import postcss from 'postcss';
import { JSDOM } from 'jsdom';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const imports = registerCompositionStartupImports();
after(imports.dispose);
const { Button } = await import('../src/components/Button/index.tsx');
const { Input } = await import('../src/components/Input/index.tsx');
const { Textarea } = await import('../src/components/Textarea/index.tsx');
const { Select, SelectTrigger, SelectValue } = await import('../src/components/Select/index.tsx');
const { Table, TableBody, TableRow, TableCell } = await import('../src/components/Table/index.tsx');
const { Tabs, TabsList, TabsTrigger } = await import('../src/components/Tabs/index.tsx');
const source = await readFile(new URL('../src/app/styles.css', import.meta.url), 'utf8');
const compiler = await compile(source, {
  base: fileURLToPath(new URL('../src/app', import.meta.url)), onDependency() {},
});

/** 只比较普通工具类与旧无层规则；后者在浏览器始终高于工具层，以同序交给DOM计算。 */
function computed(element: ReactElement, selector: string) {
  const markup = renderToStaticMarkup(element);
  const sample = new JSDOM(markup);
  const candidates = [...new Set([...sample.window.document.querySelectorAll('[class]')]
    .flatMap((entry) => [...entry.classList]))];
  sample.window.close();
  const parsed = postcss.parse(compiler.build(candidates));
  const layered: string[] = [], unlayered: string[] = [];
  parsed.each((node) => {
    if (node.type === 'atrule' && node.name === 'layer' && node.params === 'utilities') {
      for (const child of node.nodes ?? []) layered.push(child.toString());
    } else if (node.type === 'rule') unlayered.push(node.toString());
  });
  const browser = new JSDOM(`<!doctype html><html><head><style>${layered.join('\n')}\n${unlayered.join('\n')}</style></head><body>${markup}</body></html>`);
  const target = browser.window.document.querySelector(selector);
  assert.ok(target);
  const result = browser.window.getComputedStyle(target);
  return { target, result, close: () => browser.window.close() };
}

test('紧凑输入及小号选择器不被旧全局36px最小高度撑开', () => {
  const input = computed(createElement(Input, { className: 'h-[28px]' }), 'input');
  const select = computed(createElement(Select, null,
    createElement(SelectTrigger, { size: 'sm', className: 'data-[size=sm]:h-[28px]' },
      createElement(SelectValue, { placeholder: '选择目标' }))), '[data-slot="select-trigger"]');
  try {
    for (const entry of [input, select]) {
      assert.equal(entry.result.height, '28px');
      assert.notEqual(entry.result.minHeight, '36px', '控件最小高度不能抵消插件声明的紧凑高度');
    }
  } finally { input.close(); select.close(); }
});

test('按钮由调用方指定的圆角与文字色不被全局slot规则替换', () => {
  const value = computed(createElement(Button, { className: 'rounded-[15px] text-[#123456]' }, '插件操作'), 'button');
  try {
    assert.equal(value.result.borderRadius, '15px');
    assert.equal(value.result.color, 'rgb(18, 52, 86)');
  } finally { value.close(); }
});

test('输入和多行输入的业务底色不被旧全局白底替换', () => {
  const elements = [createElement(Input, { className: 'bg-[#123456]' }),
    createElement(Textarea, { className: 'bg-[#123456]' })];
  for (const element of elements) {
    const value = computed(element, '[data-slot]');
    try { assert.equal(value.result.backgroundColor, 'rgb(18, 52, 86)'); }
    finally { value.close(); }
  }
});

test('紧凑业务表格的单元格内边距不被全局12px替换', () => {
  const value = computed(createElement(Table, null,
    createElement(TableBody, null, createElement(TableRow, null,
      createElement(TableCell, { className: 'p-[2px]' }, '业务结果')))), 'td');
  try { assert.equal(value.result.padding, '2px'); }
  finally { value.close(); }
});

test('插件页签的紧凑高度、间距与背景不被旧全局页签规则替换', () => {
  const value = computed(createElement(Tabs, { defaultValue: 'first' },
    createElement(TabsList, { className: 'h-[28px] gap-[3px] mb-[6px] rounded-[9px] bg-[#123456] p-[2px]' },
      createElement(TabsTrigger, { value: 'first' }, '工作区'))), '[data-slot="tabs-list"]');
  try {
    assert.equal(value.result.height, '28px');
    assert.equal(value.result.gap, '3px');
    assert.equal(value.result.marginBottom, '6px');
    assert.equal(value.result.borderRadius, '9px');
    assert.equal(value.result.backgroundColor, 'rgb(18, 52, 86)');
    assert.equal(value.result.padding, '2px');
  } finally { value.close(); }
});

test('插件页签按钮的圆角和紧凑内边距不被全局slot选择器覆盖', () => {
  const value = computed(createElement(Tabs, { defaultValue: 'first' },
    createElement(TabsList, null, createElement(TabsTrigger, { value: 'first' }, '当前'),
      createElement(TabsTrigger, { value: 'second', className: 'rounded-[9px] px-[3px] py-[2px]' }, '另一项'))), '[value="second"], [data-state="inactive"]');
  try {
    assert.equal(value.result.borderRadius, '9px');
    assert.equal(value.result.getPropertyValue('padding-block'), '2px');
    assert.equal(value.result.getPropertyValue('padding-inline'), '3px');
  } finally { value.close(); }
});
