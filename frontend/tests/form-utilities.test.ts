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
const { FormRow, FormGrid } = await import('../src/components/Form/index.tsx');
const { Field } = await import('../src/components/FormField/index.tsx');
const { Input } = await import('../src/components/Input/index.tsx');
const appSource = await readFile(new URL('../src/app/styles.css', import.meta.url), 'utf8');
const formSource = await readFile(new URL('../src/components/Form/styles.css', import.meta.url), 'utf8');
const compiler = await compile(appSource, {
  base: fileURLToPath(new URL('../src/app', import.meta.url)), onDependency() {},
});

/** 只核对普通工具类和旧无层规则的优先关系；条件查询不作虚拟窗口布局。 */
function computed(element: ReactElement, selector: string) {
  const markup = renderToStaticMarkup(element);
  const sample = new JSDOM(markup);
  const candidates = [...new Set([...sample.window.document.querySelectorAll('[class]')]
    .flatMap((entry) => [...entry.classList]))];
  sample.window.close();
  const parsed = postcss.parse(compiler.build(candidates));
  const utilities: string[] = [], unlayered: string[] = [];
  parsed.each((node) => {
    if (node.type === 'atrule' && node.name === 'layer' && node.params === 'utilities') {
      for (const child of node.nodes ?? []) utilities.push(child.toString());
    } else if (node.type === 'rule') unlayered.push(node.toString());
  });
  const rules = postcss.parse(`${utilities.join('\n')}\n${unlayered.join('\n')}\n${formSource}`);
  rules.walkAtRules((rule) => {
    if (rule.name === 'container' || rule.name === 'media') rule.remove();
  });
  const browser = new JSDOM(`<!doctype html><html><head><style>${rules.toString()}</style></head><body>${markup}</body></html>`);
  const target = browser.window.document.querySelector(selector);
  assert.ok(target);
  return { target, result: browser.window.getComputedStyle(target), generated: parsed,
    close: () => browser.window.close() };
}

test('调用方明确的表单列数、间距和外距不被公共旧样式覆盖', () => {
  const row = computed(createElement(FormRow, {
    label: '插件地址', className: 'grid-cols-[minmax(0,1fr)] gap-[5px] my-[2px]',
    children: createElement(Input, { defaultValue: '保持原输入' }),
  }), '.form-item');
  try {
    assert.match(row.result.gridTemplateColumns, /^minmax\(0(?:px)?,\s*1fr\)$/);
    assert.equal(row.result.gap, '5px');
    assert.equal(row.result.marginBlock, '2px');
    assert.equal(row.target.querySelector('input')?.value, '保持原输入');
  } finally { row.close(); }
});

test('公开表单网格允许插件覆盖列数和间距，不残留旧自动分列', () => {
  const grid = computed(createElement(FormGrid, {
    className: 'grid-cols-[minmax(0,1fr)] gap-[6px] my-[3px]',
    children: createElement(FormRow, {
      label: '网格内参数', children: createElement(Input, { defaultValue: '独立草稿' }),
    }),
  }), '.form-columns');
  try {
    assert.match(grid.result.gridTemplateColumns, /^minmax\(0(?:px)?,\s*1fr\)$/);
    assert.equal(grid.result.gap, '6px');
    assert.equal(grid.result.marginBlock, '3px');
    assert.equal(grid.target.querySelector('input')?.value, '独立草稿');
  } finally { grid.close(); }
});

test('默认标签列与双实例的输入、提示和错误关联保持原语义', () => {
  const labels = ['第一个服务地址', '第二个服务地址'];
  const form = computed(createElement('section', null, labels.map((label, index) =>
    createElement(FormRow, {
      key: label, label, hint: `${label}说明`, error: `${label}无效`, required: true,
      children: (props) => createElement(Input, { ...props, defaultValue: `draft-${index}` }),
    })), createElement(FormGrid, null, createElement('span', null, '网格字段'))), '.form-item');
  try {
    assert.match(form.result.gridTemplateColumns,
      /^(?:144px|minmax\(0(?:px)?,\s*144px\)) minmax\(0(?:px)?,\s*1fr\)$/);
    const document = form.target.ownerDocument;
    const rows = [...document.querySelectorAll('.form-item')];
    assert.equal(rows.length, 2);
    const inputIds = new Set<string>();
    for (const [index, row] of rows.entries()) {
      assert.equal(row.children.length, 2, '表单行保留原标签及内容两部分，不增加布局包装');
      const label = row.querySelector<HTMLLabelElement>(':scope > label');
      const input = row.querySelector<HTMLInputElement>(':scope > .form-item-content > input');
      const hint = row.querySelector<HTMLElement>('.form-hint');
      const error = row.querySelector<HTMLElement>('[role="alert"]');
      assert.ok(label && input && hint && error);
      assert.equal(input.value, `draft-${index}`);
      assert.equal(label.htmlFor, input.id);
      assert.ok(input.id);
      assert.equal(inputIds.has(input.id), false, '不同表单实例不能共用标签目标');
      inputIds.add(input.id);
      assert.equal(label.textContent, `${labels[index]} *`);
      assert.equal(label.querySelector('.form-required')?.getAttribute('aria-hidden'), 'true');
      assert.equal(input.getAttribute('aria-describedby'), `${hint.id} ${error.id}`);
      assert.equal(input.getAttribute('aria-invalid'), 'true');
      assert.equal(hint.textContent, `${labels[index]}说明`);
      assert.equal(error.textContent, `${labels[index]}无效`);
      assert.equal(document.getElementById(hint.id), hint);
      assert.equal(document.getElementById(error.id), error);
    }
    const containers = new Set<string>();
    form.generated.walkDecls('container-name', (declaration) => { containers.add(declaration.value); });
    assert.equal(containers.has('form-row'), true);
    assert.equal(containers.has('form-grid'), true);
    let stackedRow = false, stackedGridChildren = false;
    form.generated.walkAtRules('container', (condition) => {
      if (condition.params === 'form-row (width < 640px)') {
        condition.walkDecls('grid-column', (declaration) => {
          if (/^1\s*\/\s*-1$/.test(declaration.value)) stackedRow = true;
        });
      }
      if (condition.params === 'form-grid (width < 640px)') {
        condition.walkRules((rule) => {
          // 当前编译器可展开嵌套；两种输出都必须明确命中直接子项。
          if (!/^(?:&|\.[^\s]+)\s*>\s*\*$/.test(rule.selector)) return;
          rule.walkDecls('grid-column', (declaration) => {
            if (/^1\s*\/\s*-1$/.test(declaration.value)) stackedGridChildren = true;
          });
        });
      }
    });
    assert.equal(stackedRow, true, '标签和内容按所属表单行的宽度纵排');
    assert.equal(stackedGridChildren, true, '窄表单网格的查询只排列子项，不查询容器本体');
  } finally { form.close(); }
});

test('公开Field恢复原网格布局，普通FormRow与手写纵排字段保持原语义', () => {
  const entries = [
    { label: '采样间隔', value: '1500', hint: '单位为毫秒', error: '请输入有效间隔' },
    { label: '插件地址', value: 'https://plugin.invalid/', hint: '独立插件配置', error: '请核对插件地址' },
  ];
  const fields = entries.map((entry, index) => createElement('div', {
    key: entry.label, className: index === 0 ? 'form-row' : 'grid grid-cols-2',
    'data-field-case': index === 0 ? '原表单行' : '插件网格',
  }, createElement(Field, { ...entry, required: true, onChange: () => {} })));
  const form = computed(createElement('section', null, ...fields, createElement('div', {
    className: 'form-field flex', 'data-handwritten-field': '',
  }, createElement('label', { htmlFor: 'handwritten-field' }, '手写字段'),
  createElement(Input, { id: 'handwritten-field', defaultValue: '手写字段草稿' })), createElement(FormRow, {
    label: '普通行标签', children: createElement(Input, { defaultValue: '保持左右布局' }),
  })), 'section');
  try {
    const document = form.target.ownerDocument;
    const view = document.defaultView;
    assert.ok(view);
    const fieldContainers = [...document.querySelectorAll('[data-field-case]')];
    assert.equal(fieldContainers.length, 2);
    const inputIds = new Set<string>();
    const displays: string[] = [];
    for (const [index, container] of fieldContainers.entries()) {
      const entry = entries[index]; assert.ok(entry);
      const field = container.firstElementChild; assert.ok(field);
      const label = field.querySelector<HTMLLabelElement>(':scope > label');
      const input = field.querySelector<HTMLInputElement>('input');
      const hint = field.querySelector<HTMLElement>('.form-hint');
      const error = field.querySelector<HTMLElement>('[role="alert"]');
      assert.ok(label && input && hint && error);
      assert.equal(input.value, entry.value, '两个受控字段保留各自值');
      assert.ok(input.id);
      assert.equal(inputIds.has(input.id), false, '嵌入不同布局的字段仍生成独立关联');
      inputIds.add(input.id);
      assert.equal(label.htmlFor, input.id);
      assert.equal(label.textContent, `${entry.label} *`);
      assert.equal(input.getAttribute('aria-describedby'), `${hint.id} ${error.id}`);
      assert.equal(input.getAttribute('aria-invalid'), 'true');
      assert.equal(input.required, true);
      assert.equal(hint.textContent, entry.hint);
      assert.equal(error.textContent, entry.error);
      assert.equal(document.getElementById(hint.id), hint);
      assert.equal(document.getElementById(error.id), error);
      const style: CSSStyleDeclaration = view.getComputedStyle(field);
      displays.push(style.display);
      assert.equal(style.alignItems, 'flex-start', '网格字段保留原顶部对齐');
    }
    const handwritten = document.querySelector('[data-handwritten-field]'); assert.ok(handwritten);
    const handwrittenStyle = view.getComputedStyle(handwritten);
    assert.equal(handwrittenStyle.display, 'flex', '手写字段继续显式使用纵排布局');
    assert.equal(handwrittenStyle.flexDirection, 'column');
    assert.equal(handwrittenStyle.gap, '7px');
    assert.equal(handwritten.querySelector('input')?.value, '手写字段草稿');
    const row = form.target.lastElementChild; assert.ok(row);
    const rowStyle = view.getComputedStyle(row);
    assert.equal(rowStyle.display, 'grid', '普通FormRow仍为标签和内容两列');
    assert.match(rowStyle.gridTemplateColumns,
      /^(?:144px|minmax\(0(?:px)?,\s*144px\)) minmax\(0(?:px)?,\s*1fr\)$/);
    assert.equal(rowStyle.alignItems, 'flex-start', '普通左右表单行保持原顶部对齐');
    assert.equal(row.querySelector('input')?.value, '保持左右布局');
    assert.deepEqual(displays, ['grid', 'grid'], '公开Field继承原FormRow网格，不被旧纵排字段样式覆盖');
  } finally { form.close(); }
});
