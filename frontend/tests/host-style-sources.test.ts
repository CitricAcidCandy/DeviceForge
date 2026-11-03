import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const styles = fileURLToPath(new URL('../src/app/styles.css', import.meta.url));
function within(directory: string, file: string) {
  const path = relative(resolve(directory), resolve(file));
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

test('宿主样式只扫描实际界面入口，保留独立插件和调试器而不打入测试资源', async () => {
  const result = await compile(await readFile(styles, 'utf8'), { base: dirname(styles), onDependency() {} });
  const sources = [...result.sources];
  if (result.root !== 'none') sources.push({
    base: result.root?.base ?? frontend, pattern: result.root?.pattern ?? '**/*', negated: false,
  });
  const scanner = new Scanner({ sources });
  const css = result.build(scanner.scan());
  assert.equal(css.includes('icon.svg'), false, '独立构建单元的测试图片不能进入宿主样式或产生运行时资源请求');
  assert.ok(/\.min-h-\\\[54px\\\]/u.test(css), '真实外壳高度工具类仍须生成');
  const scanned = scanner.files;
  assert.ok(scanned.some((file) => within(resolve(frontend, 'src/components'), file)));
  assert.ok(scanned.some((file) => within(resolve(frontend, 'plugins/default-shell/src'), file)));
  assert.ok(scanned.some((file) => within(resolve(frontend, '../examples/browser-debugger/src'), file)));
  for (const directory of ['tests', 'artifacts', 'docs']) {
    assert.equal(scanned.some((file) => within(resolve(frontend, directory), file)), false,
      `${directory}不是产品样式输入，不能由开发目录大小决定生产CSS`);
  }
});
