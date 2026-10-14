import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createServer } from 'vite';
import react from '@vitejs/plugin-react';

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
const runId = randomUUID();
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-session-browser-'));
const outputDirectory = join(project, 'artifacts', `browser-session-${runId}`);
const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(),
  run_id: runId,
  passed: false,
  scope:
    '真实浏览器、真实React组件与ProductServices、独立生产模式构建、受控API；不含Rust服务器、真机、视觉审核或真实桌面输入',
};
const inputs: { path: string; bytes: number; sha256: string }[] = [];
const frozen = new Map<string, Buffer>();
let stage = '独立打包会话验收入口';
const aliases = { '@': join(frontend, 'src') };
const server = await createServer({
  root: frontend,
  configFile: false,
  resolve: { alias: aliases },
  appType: 'custom',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
try {
  // 独立输出到本次临时目录，避免并行门禁覆盖主代理 dist。
  const bundle = join(temporary, 'bundle');
  await build({
    root: frontend,
    configFile: false,
    resolve: { alias: aliases },
    plugins: [react()],
    logLevel: 'error',
    build: {
      outDir: bundle,
      emptyOutDir: true,
      sourcemap: true,
      rolldownOptions: {
        input: join(frontend, 'scripts', 'browser-session-harness.ts'),
        preserveEntrySignatures: 'strict',
        output: { entryFileNames: 'assets/browser-session-harness.js' },
      },
    },
  });
  const assets = join(bundle, 'assets');
  const files = (await readdir(assets, { withFileTypes: true })).filter(
    (file) => file.isFile() && /\.(js|css)$/.test(file.name),
  );
  assert.ok(files.length > 0 && files.length <= 128, '会话验收资产数量无效');
  for (const file of files) {
    const path = join(assets, file.name);
    const content = await readFile(path);
    assert.ok(content.length <= 8 * 1024 * 1024, '会话验收单资产超限');
    frozen.set(file.name, content);
    inputs.push({
      path,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  assert.ok(frozen.has('browser-session-harness.js'), '会话验收构建没有稳定入口');
  report['inputs'] = inputs;
  server.middlewares.use('/assets', (request, response, next) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1);
    const content = frozen.get(path);
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
  server.middlewares.use('/__session_verification__', (_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>会话类产品行为验收</title><body></body></html>',
    );
  });
  server.middlewares.use('/__session_result__', (request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!object(value)) throw new Error('会话报告形状无效');
        report['browser'] = value;
        response.end('已记录');
      } catch {
        response.statusCode = 400;
        response.end('报告无效');
      }
    });
  });
  stage = '启动独立验收资产服务';
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string', '会话验收服务端口缺失');
  const module: unknown = await import(
    pathToFileURL(join(project, 'scripts', 'browser-theme-smoke', 'driver.mjs')).href
  );
  assert.ok(driver(module), '既有真实浏览器驱动没有兼容入口');
  const processEvidence: Record<string, unknown> = {};
  report['browser_process'] = processEvidence;
  stage = '真实浏览器执行会话页面';
  const result = await module.runBrowser(
    `http://127.0.0.1:${address.port}/__session_verification__`,
    '(async()=>{const harness=await import("/assets/browser-session-harness.js");const result=await harness.verifySessionPages();await fetch("/__session_result__",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(result)});return result;})()',
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
      result['checks'].length >= 40 &&
      result['checks'].every((check) => object(check) && check['passed'] === true),
    '会话浏览器交互未全部通过',
  );
  stage = '冻结输入身份复核';
  for (const input of inputs)
    assert.equal(
      createHash('sha256')
        .update(await readFile(input.path))
        .digest('hex'),
      input.sha256,
      '会话验收资产运行期间变化',
    );
  report['passed'] = true;
} catch (error) {
  report['failure_stage'] = stage;
  report['error'] = {
    name: error instanceof Error ? error.name : 'unknown',
    message: error instanceof Error ? error.message.slice(0, 1500) : '未知会话验证失败',
  };
  process.exitCode = 1;
} finally {
  const listener = server.httpServer;
  if (listener && 'closeAllConnections' in listener) listener.closeAllConnections();
  await server.close();
  const normalized = resolve(temporary);
  const parent = resolve(tmpdir());
  const subpath = relative(parent, normalized);
  assert.ok(
    normalized.startsWith(parent + sep) &&
      !subpath.startsWith('..') &&
      basename(normalized).startsWith('deviceforge-session-browser-'),
    '会话临时目录清理边界无效',
  );
  await rm(normalized, { recursive: true, force: true });
  report['temporary_cleaned'] = true;
  report['completed_at'] = new Date().toISOString();
  await mkdir(outputDirectory, { recursive: true });
  const output = join(outputDirectory, 'report.json');
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(
    `会话产品浏览器验收：${report['passed'] === true ? '通过' : '未通过'}；证据：${output}`,
  );
}
