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
