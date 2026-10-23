import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * UI 政策门禁（硬性规则，进 npm run check）：
 *   T1 优先 Tailwind —— src/** 下不允许新增 CSS 文件；现存文件只减不增（清单即白名单）。
 *   T2 行内样式只允许图表几何 —— style={{}} 里的键必须全部落在几何白名单，
 *      其余一律用 Tailwind 工具类表达。
 *   R3 页面必须响应式 —— 页面入口必须声明弹性/视口高度（min-h-[…]、h-[calc(100vh…)、
 *      flex-1、h-full 之一），禁止写死三位数以上的宽高。
 * 设计稿 → 代码的顺序因此固定为：布局用 Tailwind 工具类，图表几何交给图表组件。
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = join(root, 'src');

const failures: string[] = [];

// T1：现存 CSS 文件快照。删一个就删一行；新增一律报错。
const CSS_ALLOWLIST = new Set([
  'app/product/layout.css',
  'app/product/workspace-tasks.css',
  'app/styles.css',
  'components/Badge/styles.css',
  'components/Card/styles.css',
  'components/DialogShell/styles.css',
  'components/FileDropzone/styles.css',
  'components/Form/styles.css',
  'components/Message/styles.css',
  'components/SchemaForm/styles.css',
  'components/SelectField/styles.css',
  'components/Stepper/styles.css',
  'pages/ai/workspace.css',
  'pages/analysis/workspace.css',
  'pages/automation/workspace.css',
  'pages/devices/apps/workspace.css',
  'pages/devices/screen/workspace.css',
  'pages/devices/workspace.css',
  'pages/files/workspace.css',
  'pages/frida/workspace.css',
  'pages/marketplace/components/LocalImportDialog/styles.css',
  'pages/marketplace/components/MarketplaceUploadContent/styles.css',
  'pages/marketplace/workspace.css',
  'pages/settings/workspace.css',
  'pages/tasks/workspace.css',
]);

// T2：行内样式只放图表几何（数据驱动的坐标、比例），其余交给 Tailwind。
const INLINE_STYLE_KEYS = new Set([
  'left',
  'top',
  'right',
  'bottom',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'aspectRatio',
  'opacity',
  'flexBasis',
  'flex',
]);

async function collectCss(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectCss(path);
      continue;
    }
    if (!entry.name.endsWith('.css')) continue;
    const portable = relative(sourceRoot, path).split('\\').join('/');
    if (!CSS_ALLOWLIST.has(portable)) {
      failures.push(
        `${portable}: 新增 CSS 文件违反「优先 Tailwind」——布局与状态样式一律用 Tailwind 工具类，几何才允许行内`,
      );
    }
  }
}

/** style={{ … }} 里的键，用 TS AST 拿，避免正则被嵌套表达式骗过。 */
function inlineStyleIssues(file: string, text: string): void {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'style' && node.initializer) {
      const expression = node.initializer;
      if (ts.isJsxExpression(expression) && expression.expression && ts.isObjectLiteralExpression(expression.expression)) {
        for (const property of expression.expression.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
          const key = property.name.getText();
          // 自定义属性是唯一允许的「行内主题/几何通道」：主题插件与拖拽尺寸都靠它传递。
          // 颜色、字号这类可读性项不接受行内写法，必须留在 CSS 类里。
          if (!INLINE_STYLE_KEYS.has(key) && !key.startsWith('--') && !isBaseline(file, `inline:${key}`)) {
            failures.push(`${file}:${property.getStart()}: 行内样式键 "${key}" 不在图表几何白名单，请改用 Tailwind 工具类`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** R3：页面入口必须声明弹性/视口高度，且禁止写死尺寸。 */
function pageResponsiveIssues(rawFile: string, text: string): void {
  const file = rawFile.split('\\').join('/');
  const responsive = ['min-h-[', 'h-[calc(100vh', 'flex-1', 'h-full'].some((token) => text.includes(token));
  if (!responsive && !isBaseline(file, 'responsive')) {
    failures.push(`${file}: 页面入口缺少弹性/视口高度（min-h-[…] / h-[calc(100vh…) / flex-1 / h-full 之一）`);
  }
  const fixed = text.match(/(?<![a-z-])(?:w|h)-\[\d{3,}px\]/g);
  if (fixed && !isBaseline(file, `fixed:${fixed.join(',')}`)) {
    failures.push(`${file}: 出现写死尺寸 ${fixed.join(' ')}，响应式请用比例、flex 或断点表达`);
  }
}

// 路由根只认 routes.ts 里登记的页面，避免把 components 下的 index.tsx 也当页面。
const routesSource = await readFile(join(sourceRoot, 'app/product/routes.ts'), 'utf8');
const routeRoots = new Set(
  [...routesSource.matchAll(/id: '([\w-]+)'/g)].map((match) => match[1]),
);
const pagesRoot = join(sourceRoot, 'pages');
const componentsRoot = join(sourceRoot, 'components');

async function scanTsx(directory: string, checkPage: boolean): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanTsx(path, checkPage);
      continue;
    }
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) continue;
    const text = await readFile(path, 'utf8');
    inlineStyleIssues(relative(sourceRoot, path).split('\\').join('/'), text);
    const isRouteRoot =
      checkPage &&
      entry.name === 'index.tsx' &&
      routeRoots.has(relative(directory, root).split('sep') ? relative(directory, root) : '');
    if (checkPage && entry.name === 'index.tsx') {
      const relativeDir = relative(pagesRoot, directory).split('\\').join('/');
      if (routeRoots.has(relativeDir)) pageResponsiveIssues(relative(sourceRoot, path), text);
    }
  }
}

/**
 * 存量基线：历史代码（旧版式页面、早期组件）在此豁免，只减不增。
 * 规则与 CSS 清单一致——改到哪条，哪条就从基线里删掉；新增一律失败。
 */
const BASELINE: Readonly<Record<string, readonly string[]>> = {
    "pages/ai/index.tsx": [
      "responsive"
    ],
    "pages/analysis/index.tsx": [
      "responsive"
    ],
    "pages/automation/index.tsx": [
      "responsive"
    ],
    "pages/devices/index.tsx": [
      "responsive"
    ],
    "pages/files/index.tsx": [
      "responsive"
    ],
    "pages/frida/index.tsx": [
      "responsive"
    ],
    "pages/performance/components/PerformanceReadings/index.tsx": [
      "inline:display"
    ],
    "pages/performance/components/ProfileArchiveView/index.tsx": [
      "inline:display"
    ],
    "pages/performance/components/ProfileFlamegraph/index.tsx": [
      "inline:background",
      "inline:border",
      "inline:borderRadius",
      "inline:display",
      "inline:flexWrap",
      "inline:gap",
      "inline:marginBlock",
      "inline:marginTop",
      "inline:overflow",
      "inline:overflowWrap",
      "inline:pointerEvents"
    ],
    "pages/performance/components/ProfileFrameView/index.tsx": [
      "inline:objectFit"
    ],
    "pages/performance/components/ProfileStackList/index.tsx": [
      "inline:display"
    ],
    "pages/performance/index.tsx": [
      "fixed:160px"
    ],
    "pages/settings/index.tsx": [
      "responsive"
    ],
    "pages/tasks/index.tsx": [
      "responsive"
    ],
    "components/Progress/index.tsx": [
      "inline:transform"
    ]
  };

const isBaseline = (file: string, signature: string): boolean =>
  (BASELINE[file] ?? []).includes(signature);

await collectCss(sourceRoot);
await scanTsx(pagesRoot, true);
await scanTsx(componentsRoot, false);

if (failures.length) {
  console.error(`UI 政策检查未通过（${failures.length} 条）：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('规则：布局一律 Tailwind 工具类；行内样式只允许图表几何；页面必须声明弹性/视口高度。');
  process.exit(1);
}
console.log(`UI 政策检查通过：Tailwind 优先、行内样式仅图表几何、页面均为弹性布局`);
