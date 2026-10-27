import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeBinary } from '../smoke-binaries.mjs';
import { createApi } from './api.mjs';
import { exited, markers, poll, save, sha256 } from './common.mjs';
import { createHost } from './host.mjs';
import { runMatrix } from './matrix.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const backend = join(root, 'backend');
const inputNames = ['apk-server', 'deviceforge-service-normalize', 'deviceforge-service-compose'];

async function freezeInputs(context) {
  const files = inputNames.map((name) => ({ name, path: context.binary(name), kind: 'binary' }));
  for (const kind of ['normalize', 'compose']) {
    for (const name of ['Cargo.toml', 'package.json', 'manifest.json', 'src/main.rs', 'src/diagnostics.rs']) {
      files.push({ name: `server-service-${kind}/${name}`, path: join(root, 'examples', `server-service-${kind}`, name), kind: 'source' });
    }
  }
  for (const name of await readdir(join(backend, 'scripts', 'service-composition'))) {
    if (name.endsWith('.mjs')) files.push({ name, path: join(backend, 'scripts', 'service-composition', name), kind: 'harness' });
  }
  files.push({ name: 'service-composition-smoke.mjs', path: join(backend, 'scripts', 'service-composition-smoke.mjs'), kind: 'harness' });
  for (const file of files) {
    const metadata = await stat(file.path);
    assert.ok(metadata.isFile() && metadata.size <= 256 * 1024 * 1024, `缺少或超过限额：${file.name}`);
    context.report.inputs.push({ ...file, size: metadata.size, sha256: sha256(await readFile(file.path)) });
  }
}

async function verifyInputs(context) {
  for (const input of context.report.inputs) {
    assert.equal(sha256(await readFile(input.path)), input.sha256, `运行中输入发生漂移：${input.name}`);
  }
  context.report.inputs_unchanged = true;
}

async function collectProcesses(context) {
  const records = [];
  for (const kind of ['compose', 'normalize']) {
    const starts = await markers(context.directories[kind], 'started', true);
    const endings = await markers(context.directories[kind], 'finished', true);
    for (const start of starts) {
      const ending = endings.find((item) => item.request_id === start.request_id && item.pid === start.pid);
      records.push({ plugin: kind, ...start, handler_finished: Boolean(ending), cancelled: ending?.cancelled });
    }
  }
  context.report.processes = records;
  try {
    await poll(async () => records.every((item) => exited(item.pid)), Boolean, '所有已观察原生进程退出', 5000);
  } finally {
    for (const item of records) item.process_exited = exited(item.pid);
  }
  assert.ok(records.every((item) => item.handler_finished), '存在未确认处理器结束的调用');
  context.report.all_observed_processes_exited = true;
}

async function collectLogs(context) {
  const directory = join(context.evidence, 'data', 'logs');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'));
  assert.ok(names.length > 0 && names.length <= 64, '宿主应写入有界日志');
  const records = [];
  let size = 0;
  for (const name of names) {
    size += (await stat(join(directory, name))).size;
    assert.ok(size <= 32 * 1024 * 1024, '日志证据超过验收限额');
    const text = await readFile(join(directory, name), 'utf8');
    assert.ok(!text.includes(context.token), '宿主日志不得含访问令牌');
    for (const line of text.split('\n').filter((line) => line.trim())) records.push(JSON.parse(line));
  }
  const nested = records.filter((record) => record.fields?.message === '服务子调用结束');
  const field = (record, name) => record.fields?.[name] ?? record.span?.[name]
    ?? record.spans?.findLast((span) => span[name] !== undefined)?.[name];
  context.report.logs = { files: names, bytes: size, records: records.length,
    nested_calls: nested.map((record) => ({ service_id: field(record, 'service_id'),
      service_version: field(record, 'service_version'), depth: field(record, 'depth'),
      code: field(record, 'code'), job_id: field(record, 'job_id'), log_id: field(record, 'log_id') })) };
  if (context.report.jobs.some((job) => job.operation === 'plugin.service-compose.compose' && job.status === 'succeeded')) {
    assert.ok(nested.some((record) => field(record, 'service_id') === 'example.text.normalize'
      && field(record, 'service_version') === '1.0' && field(record, 'code') === 'ok'), '缺少真实反向子调用成功日志');
  }
  assert.ok(records.some((record) => record.fields?.message === '宿主运行已结束'), '缺少正常退出日志');
}

export async function run(arguments_) {
  const profile = arguments_.includes('--release') ? 'release' : 'debug';
  const runId = randomUUID();
  const evidence = resolve(root, 'artifacts', `service-composition-smoke-${profile}-${runId}`);
  const report = { run_id: runId, started_at: new Date().toISOString(), profile,
    platform: process.platform, architecture: process.arch, passed: false,
    scope: '本机预构建Rust宿主与两个真实独立Rust协议6插件；在线TGZ安装、HTTP/MCP共享Job、入口依赖、版本/代际/schema、父取消及退出；无设备、浏览器、性能或正式分发结论',
    inputs: [], packages: [], requests: [], submissions: [], jobs: [], scenarios: [], cleanup_errors: [],
    retained_evidence: evidence,
    build_provenance: '记录本轮消费的二进制与示例源码各自SHA-256；构建命令由主代理执行，摘要本身不证明二进制由同份源码构建',
  };
  const token = randomBytes(32).toString('hex');
  const context = { root, backend, evidence, report, token, plugins: join(evidence, 'plugins'),
    directories: { normalize: join(evidence, 'markers', 'normalize'), compose: join(evidence, 'markers', 'compose') },
    binary: (name) => smokeBinary(name, profile) };
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error('验收被用户中断'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const timer = setTimeout(() => abort.abort(new Error('组合smoke超过五分钟总期限')), 300000);
  timer.unref();
  let host;
  let matrixFinished = false;
  const redact = (error) => String(error?.stack ?? error).replaceAll(token, '[已脱敏]').slice(0, 2500);
  await mkdir(evidence, { recursive: true });
  try {
    assert.ok(arguments_.length <= 1 && arguments_.every((argument) => argument === '--release'), '仅支持单个 --release 参数');
    for (const directory of [context.plugins, ...Object.values(context.directories)]) await mkdir(directory, { recursive: true });
    await freezeInputs(context);
    await save(join(evidence, 'inputs.json'), report.inputs);
    host = await createHost(context);
    context.api = createApi(host.base, token, report, abort.signal);
    await host.ready();
    await runMatrix(context);
    matrixFinished = true;
  } catch (error) {
    report.error = redact(error);
  } finally {
    if (host) {
      try { await host.stop(); }
      catch (error) { report.cleanup_errors.push(redact(error)); }
      if (context.shutdownProof) {
        try { await context.shutdownProof(); }
        catch (error) { report.cleanup_errors.push(redact(error)); }
      }
      try { await collectProcesses(context); }
      catch (error) { report.cleanup_errors.push(redact(error)); }
      try { await collectLogs(context); }
      catch (error) { report.cleanup_errors.push(redact(error)); }
    }
    try { await verifyInputs(context); }
    catch (error) { report.cleanup_errors.push(redact(error)); }
    clearTimeout(timer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    report.completed_at = new Date().toISOString();
    report.passed = matrixFinished && !report.error && report.cleanup_errors.length === 0
      && report.scenarios.every((scenario) => scenario.passed);
    await save(join(evidence, 'report.json'), report);
    console.log(JSON.stringify({ run_id: runId, profile, passed: report.passed,
      scenarios: report.scenarios.filter((item) => item.passed).length,
      report: join(evidence, 'report.json'), error: report.error?.split('\n')[0],
      cleanup_errors: report.cleanup_errors.map((error) => error.split('\n')[0]) }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}
