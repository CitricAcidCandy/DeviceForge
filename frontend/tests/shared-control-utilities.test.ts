import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from '@tailwindcss/node';
import { transform } from 'lightningcss';
import postcss from 'postcss';
import type { Container } from 'postcss';
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
const { Checkbox } = await import('../src/components/Checkbox/index.tsx');
const { DialogHeader } = await import('../src/components/Dialog/index.tsx');
const { SheetHeader } = await import('../src/components/Sheet/index.tsx');
const { DropdownMenuItem } = await import('../src/components/DropdownMenu/index.tsx');
const { DropdownMenu: DropdownMenuPrimitive } = await import('radix-ui');
const source = await readFile(new URL('../src/app/styles.css', import.meta.url), 'utf8');
const entrypoint = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'));
const bodyClassName = entrypoint.window.document.body.className;
entrypoint.window.close();
const compiler = await compile(source, {
  base: fileURLToPath(new URL('../src/app', import.meta.url)), onDependency() {},
});

/** 只展开用例明确给定宽度的已知媒体条件，保留原所在级联层并忽略未验证的其他条件。 */
function expandKnownMedia(container: Container, viewportWidth: number) {
  for (const node of [...container.nodes ?? []]) {
    if (node.type === 'atrule' && node.name === 'media') {
      const inclusive = /^\(max-width:\s*(\d+)px\)$/.exec(node.params)
        ?? /^\(width\s*<=\s*(\d+)px\)$/.exec(node.params);
      const exclusive = /^\(width\s*<\s*(\d+)px\)$/.exec(node.params)
        ?? /^not\s*\((?:min-width:\s*|width\s*>=\s*)(\d+)px\)$/.exec(node.params);
      const matches = inclusive ? viewportWidth <= Number(inclusive[1])
        : exclusive ? viewportWidth < Number(exclusive[1]) : false;
      if (matches) { expandKnownMedia(node, viewportWidth); node.replaceWith(...node.nodes ?? []); }
      else node.remove();
    } else if (node.type === 'atrule' && node.name === 'layer' || node.type === 'rule') {
      expandKnownMedia(node, viewportWidth);
    } else if (node.type === 'atrule') node.remove();
  }
}

/** 编译真实入口及组件类；只展开CSS嵌套，不替未知媒体或特性条件作肯定判断。 */
function computed(element: ReactElement, selector: string, viewportWidth = Infinity) {
  const markup = renderToStaticMarkup(element);
  const sample = new JSDOM(markup);
  sample.window.document.body.className = bodyClassName;
  const candidates = [...new Set([...sample.window.document.querySelectorAll('[class]')]
    .flatMap((entry) => [...entry.classList]))];
  sample.window.close();
  const parsed = postcss.parse(transform({ filename: '共享控件内存样式.css',
    code: Buffer.from(compiler.build(candidates)), targets: { chrome: 100 << 16 },
  }).code.toString());
  // JSDOM不能匹配任意变体中的多组转义方括号；等价别名保持:where及原选择器权重、关系与声明。
  const aliases = [...candidates].sort((left, right) => right.length - left.length).map((candidate, index) => ({
    candidate, alias: `shared-control-class-${index}`,
    escaped: `.${candidate.replace(/[^a-zA-Z0-9_-]/g, '\\$&')}`,
  }));
  parsed.walkRules((rule) => {
    for (const { escaped, alias } of aliases) rule.selector = rule.selector.replaceAll(escaped, `.${alias}`);
  });
  const active = parsed.clone();
  expandKnownMedia(active, viewportWidth);
  const layered: string[] = [], unlayered: string[] = [];
  active.each((node) => {
    if (node.type === 'atrule' && node.name === 'layer' && node.params === 'utilities') {
      for (const child of node.nodes ?? []) layered.push(child.toString());
    } else if (node.type === 'rule') unlayered.push(node.toString());
  });
  // JSDOM不实现级联层。仅给实际无层规则加统一高权重，保留工具层内原选择器权重及声明。
  const legacy = postcss.parse(unlayered.join('\n'));
  legacy.walkRules((rule) => { rule.selector = `:is(${rule.selector}):not(#shared-control-layer-sentinel)`; });
  const styles = `${layered.join('\n')}\n${legacy.toString()}`;
  const browser = new JSDOM(`<!doctype html><html><head><style>${styles}</style></head><body>${markup}</body></html>`);
  browser.window.document.body.className = bodyClassName;
  for (const element of browser.window.document.querySelectorAll('[class]')) {
    for (const { candidate, alias } of aliases) if (element.classList.contains(candidate)) element.classList.add(alias);
  }
  const target = browser.window.document.querySelector(selector);
  assert.ok(target);
  const result = browser.window.getComputedStyle(target);
  return { target, result, parsed, close: () => browser.window.close() };
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

test('窄窗复选框的明确尺寸不被640px旧媒体规则强制撑为44px', () => {
  for (const width of [480, 640, 641]) {
    const value = computed(createElement(Checkbox, { className: 'size-[18px] min-w-[18px] min-h-[18px]' }),
      '[data-slot="checkbox"]', width);
    try {
      assert.equal(value.result.minWidth, '18px', `${width}px窗口不能覆盖调用方最小宽度`);
      assert.equal(value.result.minHeight, '18px', `${width}px窗口不能覆盖调用方最小高度`);
      assert.equal(value.result.width, '18px'); assert.equal(value.result.height, '18px');
    } finally { value.close(); }
  }
});

test('原生披露的插件后代工具类可指定紧凑高度、内距和展开间距', () => {
  const value = computed(createElement('section', {
    className: '[&_details>summary]:min-h-[24px] [&_details>summary]:py-[2px] [&_details>summary]:text-[12px] [&_details>summary]:font-[500] [&_details[open]>summary]:mb-[8px]',
  }, createElement('details', { open: true }, createElement('summary', null, '插件说明'),
    createElement('p', null, '当前插件的详细说明'))), 'details > summary');
  try {
    assert.equal(value.result.minHeight, '24px', '插件显式高度不能被原生披露默认32px覆盖');
    assert.equal(value.result.getPropertyValue('padding-block'), '2px');
    assert.equal(value.result.marginBottom, '8px');
    assert.equal(value.result.fontSize, '12px');
    assert.equal(value.result.fontWeight, '500');
    assert.equal(value.target.textContent, '插件说明');
    assert.equal(value.target.parentElement?.hasAttribute('open'), true);
  } finally { value.close(); }
});

test('原生披露未指定尺寸时保留32px高度、原间距和键盘焦点轮廓规则', () => {
  const value = computed(createElement('details', { open: true }, createElement('summary', null, '默认说明'),
    createElement('p', null, '保留原生披露内容')), 'details > summary');
  try {
    assert.equal(value.result.minHeight, '32px');
    assert.equal(value.result.getPropertyValue('padding-block'), '4px');
    assert.equal(value.result.marginBottom, '12px');
    assert.equal(value.result.fontSize, '14px');
    assert.equal(value.result.fontWeight, '550');
    assert.equal(value.target.tagName, 'SUMMARY');
    assert.equal(value.target.parentElement?.tagName, 'DETAILS');
    assert.notEqual(value.target.getAttribute('tabindex'), '-1', '默认保留原生summary键盘入口');
    const view = value.target.ownerDocument.defaultView; assert.ok(view);
    assert.ok(value.target instanceof view.HTMLElement);
    value.target.focus();
    // JSDOM未完整实现原生summary的焦点行为，因此只按实际编译selector验证focus-visible样式。
    let width = false, solid = false, offset = false;
    value.parsed.walkRules((rule) => {
      if (!rule.selector.includes('summary:focus-visible')) return;
      rule.walkDecls((declaration) => {
        if (declaration.prop === 'outline' && /^2px\s+solid\b/.test(declaration.value)) {
          width = true; solid = true;
        }
        if (declaration.prop === 'outline-width' && declaration.value === '2px') width = true;
        if (declaration.prop === 'outline-style' && declaration.value === 'solid') solid = true;
        if (declaration.prop === 'outline-offset' && declaration.value === '3px') offset = true;
      });
    });
    assert.equal(width, true, '原生披露focus-visible轮廓宽度仍为2px');
    assert.equal(solid, true, '原生披露focus-visible轮廓仍为实线');
    assert.equal(offset, true, '原生披露focus-visible轮廓偏移仍为3px');
  } finally { value.close(); }
});

test('弹层标题的插件右内距不被旧窄窗口规则覆盖，保留原始标题内容', () => {
  for (const width of [480, 940]) {
    const dialog = computed(createElement('div', { 'data-slot': 'dialog-content' },
      createElement(DialogHeader, { className: 'pr-[48px]' },
        createElement('h2', null, '当前任务详情'))), '[data-slot="dialog-header"]', width);
    const sheet = computed(createElement('div', { 'data-slot': 'sheet-content' },
      createElement(SheetHeader, { className: 'pr-[48px]' },
        createElement('h2', null, '当前工作区任务'))), '[data-slot="sheet-header"]', width);
    try {
      assert.deepEqual([dialog.result.paddingRight, sheet.result.paddingRight], ['48px', '48px'],
        `${width}px窗口不能用旧36px标题留白替换插件显式48px右内距`);
      assert.equal(dialog.target.querySelector('h2')?.textContent, '当前任务详情');
      assert.equal(sheet.target.querySelector('h2')?.textContent, '当前工作区任务');
      assert.equal(dialog.target.getAttribute('data-slot'), 'dialog-header');
      assert.equal(sheet.target.getAttribute('data-slot'), 'sheet-header');
    } finally { dialog.close(); sheet.close(); }
  }
});

/** 保留真实Radix菜单上下文，仅将其Content内联渲染，避免Portal与浏览器交互超出样式单元范围。 */
function nativeMenuItem(className?: string) {
  return createElement(DropdownMenuPrimitive.Root, { open: true },
    createElement(DropdownMenuPrimitive.Content, { forceMount: true },
      createElement(DropdownMenuItem, className ? { className } : {}, '查看详情')));
}

test('窄窗图标按钮和菜单项的显式工具类保留紧凑尺寸与可收缩设置', () => {
  for (const width of [480, 940]) {
    const icon = computed(createElement(Button, { size: 'icon', type: 'button', 'aria-label': '刷新应用',
      className: 'min-w-[24px] shrink' }, '刷新'), 'button', width);
    const item = computed(nativeMenuItem('min-h-[24px]'), '[data-slot="dropdown-menu-item"]', width);
    try {
      assert.deepEqual([icon.result.minWidth, icon.result.flexShrink, item.result.minHeight], ['24px', '1', '24px'],
        `${width}px窗口不能用全局44px触控默认覆盖插件的显式尺寸或收缩设置`);
      assert.equal(icon.target.getAttribute('aria-label'), '刷新应用');
      assert.equal(icon.target.getAttribute('type'), 'button');
      assert.equal(item.target.getAttribute('role'), 'menuitem');
      assert.equal(item.target.textContent, '查看详情');
    } finally { icon.close(); item.close(); }
  }
});

test('未显式覆盖的图标按钮与菜单项保留窄窗44px默认和宽窗原语义', () => {
  for (const width of [480, 940]) {
    const icon = computed(createElement(Button, { size: 'icon', type: 'button', 'aria-label': '刷新应用' }, '刷新'),
      'button', width);
    const item = computed(nativeMenuItem(), '[data-slot="dropdown-menu-item"]', width);
    try {
      if (width === 480) {
        assert.equal(icon.result.minWidth, '44px');
        assert.equal(item.result.minHeight, '44px');
      } else {
        assert.notEqual(icon.result.minWidth, '44px', '宽窗不套用窄窗图标触控默认');
        assert.notEqual(item.result.minHeight, '44px', '宽窗不套用窄窗菜单触控默认');
      }
      assert.equal(icon.result.flexShrink, '0', '未显式覆盖时保留图标按钮不收缩默认');
      assert.equal(icon.target.getAttribute('aria-label'), '刷新应用');
      assert.equal(icon.target.textContent, '刷新');
      assert.equal(item.target.getAttribute('role'), 'menuitem');
      assert.equal(item.target.textContent, '查看详情');
      assert.ok(item.target.closest('[role="menu"]'), '真实菜单项保留Radix菜单语义上下文');
    } finally { icon.close(); item.close(); }
  }
});
