import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

interface BrowserDriver {
  runBrowser(
    pageUrl: string,
    expression: string,
    profileDirectory: string,
    observeRuntime: (value: unknown) => void,
    options: { evidence: Record<string, unknown>; inProcessGpu: boolean },
  ): Promise<unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const driver = (value: unknown): value is BrowserDriver =>
  object(value) && typeof value['runBrowser'] === 'function';
const frontend = fileURLToPath(new URL('../', import.meta.url));
const project = resolve(frontend, '..');
const assetsDirectory = join(frontend, 'dist', 'assets');
const inputs: { path: string; bytes: number; sha256: string }[] = [];
const bytes = new Map<string, Buffer>();
const runId = randomUUID();
const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(),
  run_id: runId,
  passed: false,
  scope:
    '真实浏览器 DOM、生产构建组件与受控 API 夹具；不含 Rust 服务、真实设备、视觉审核或生产性能',
};
let temporary: string | null = null;
let stage = '冻结浏览器资产';
const server = await createServer({
  root: frontend,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
try {
  const files = (await readdir(assetsDirectory, { withFileTypes: true })).filter(
    (item) => item.isFile() && /\.(?:js|css)$/.test(item.name),
  );
  assert.ok(files.length > 0 && files.length <= 128, '生产构建资产数量无效');
  for (const file of files) {
    const path = join(assetsDirectory, file.name);
    const content = await readFile(path);
    assert.ok(content.length <= 8 * 1024 * 1024, '生产构建单资产超限');
    bytes.set(file.name, content);
    inputs.push({
      path,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  assert.ok(
    bytes.has('browser-product-harness.js'),
    '缺少 browser-product-harness 构建入口，请先构建',
  );
  report['inputs'] = inputs;
  server.middlewares.use('/assets', (request, response, next) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1);
    const content = bytes.get(path);
    if (!content) {
      next();
      return;
    }
    response.setHeader(
      'content-type',
      path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
    );
    response.end(content);
  });
  server.middlewares.use('/__product_verification__', (_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>产品页面行为验收</title><body></body></html>',
    );
  });
  stage = '启动本次浏览器资产服务';
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string', '资产服务端口缺失');
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-product-browser-'));
  const driverModule: unknown = await import(
    pathToFileURL(join(project, 'scripts', 'browser-theme-smoke', 'driver.mjs')).href
  );
  assert.ok(driver(driverModule), '既有浏览器驱动没有兼容入口');
  const processEvidence: Record<string, unknown> = {};
  report['browser_process'] = processEvidence;
  stage = '执行真实浏览器产品行为';
  const result = await driverModule.runBrowser(
    `http://127.0.0.1:${address.port}/__product_verification__`,
    '(async()=>{const harness=await import("/assets/browser-product-harness.js");return await harness.verifyProductPages();})()',
    join(temporary, 'browser-profile'),
    (value) => {
      report['browser_runtime'] = value;
    },
    { evidence: processEvidence, inProcessGpu: process.argv.includes('--in-process-gpu') },
  );
  report['browser'] = result;
  assert.ok(
    object(result) &&
      result['passed'] === true &&
      Array.isArray(result['checks']) &&
      result['checks'].length >= 22 &&
      result['checks'].every((check) => object(check) && check['passed'] === true),
    '浏览器产品行为未全部通过',
  );
  stage = '输入身份复核';
  for (const identity of inputs) {
    const current = await readFile(identity.path);
    assert.equal(
      createHash('sha256').update(current).digest('hex'),
      identity.sha256,
      `构建资产在验收期间变化：${basename(identity.path)}`,
    );
  }
  report['passed'] = true;
} catch (error) {
  report['failure_stage'] = stage;
  report['error'] = {
    name: error instanceof Error ? error.name : 'unknown',
    message: error instanceof Error ? error.message.slice(0, 1000) : '未知验证失败',
  };
  process.exitCode = 1;
} finally {
  const listener = server.httpServer;
  if (listener && 'closeAllConnections' in listener) listener.closeAllConnections();
  await server.close();
  if (temporary) {
    const normalized = resolve(temporary);
    const parent = resolve(tmpdir());
    const subpath = relative(parent, normalized);
    assert.ok(
      normalized.startsWith(parent + sep) &&
        !subpath.startsWith('..') &&
        basename(normalized).startsWith('deviceforge-product-browser-'),
      '临时目录清理边界无效',
    );
    await rm(normalized, { recursive: true, force: true });
    report['temporary_cleaned'] = true;
  }
  report['completed_at'] = new Date().toISOString();
  const outputDirectory = join(project, 'artifacts', `product-browser-${runId}`);
  await mkdir(outputDirectory, { recursive: true });
  const output = join(outputDirectory, 'report.json');
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(
    `产品页面浏览器验收：${report['passed'] === true ? '通过' : '未通过'}；证据：${output}`,
  );
}
