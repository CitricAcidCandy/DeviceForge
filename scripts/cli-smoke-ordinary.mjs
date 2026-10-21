// 真实 npx 普通业务补充验收：仅使用本轮部署配置、合成 HTTP 源与预构建 AI 夹具。
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { inside, regularFile } from '../cli/src/paths.mjs';
import { materializeManifest } from '../cli/src/plugin-package.mjs';
import {
  runtimeFeatureKey,
  runtimeModuleIds,
  verifyRuntimeFeatureNpx,
} from './cli-smoke-ordinary-feature.mjs';

const privateState = new WeakMap();
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const moduleId = 'fixture-tool';
const projectId = 'npx-fixture';
const answer = '合成模型固定回答';
const toolText = Buffer.from('设备工坊 npx 合成工具包\r\n固定文本字节：UTF-8\n', 'utf8');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (bytes) => ({ bytes: bytes.length, sha256: digest(bytes) });
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const same = (actual, expected, message) => ensure(isDeepStrictEqual(actual, expected), message);
const object = (value) => {
  ensure(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    '公开结果必须是对象',
  );
  return value;
};

function failure(error) {
  return {
    name: /^[A-Za-z][A-Za-z0-9]*$/.test(error?.name ?? '') ? error.name : 'Error',
    code: /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : null,
    message_sha256: digest(String(error?.message ?? '未知失败')),
  };
}
function auditedError(error, evidence, stage) {
  evidence.passed = false;
  evidence.failure = { stage, ...failure(error) };
  // 不透传断言差异、文件绝对路径、响应正文或请求头。
  const result = new Error(`npx 普通业务验收失败：${stage}`);
  result.ordinaryBusinessEvidence = evidence;
  return result;
}
async function bytesAt(path, limit = 65536) {
  const metadata = await lstat(path);
  ensure(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= limit,
    '验收文件类型或大小无效',
  );
  const bytes = await readFile(path);
  ensure(bytes.length <= limit, '验收文件读取超限');
  return bytes;
}
async function directoryAt(root, path) {
  const metadata = await lstat(path);
  const canonical = await realpath(path);
  ensure(
    metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      inside(root, canonical) &&
      root !== canonical,
    '普通业务目录必须位于本轮部署边界内',
  );
  return canonical;
}
async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

// 单入口 stored ZIP，校验 CRC32、中央目录偏移及 UTF-8 标记；没有外部压缩依赖。
function toolArchive() {
  const name = Buffer.from('bundle/entry.txt');
  let crc = 0xffffffff;
  for (const byte of toolText) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(toolText.length, 18);
  local.writeUInt32LE(toolText.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(toolText.length, 20);
  central.writeUInt32LE(toolText.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + toolText.length, 16);
  return Buffer.concat([local, name, toolText, central, name, end]);
}

async function syntheticSource(evidence, archive) {
  let remoteValue = { label: '合成远端配置' };
  let catalog;
  const calls = evidence.source_calls;
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void (async () => {
      ensure(calls.length < 256, '合成源调用次数超限');
      const kind =
        {
          '/get_config/deviceInfo': 'remote.load',
          '/update_config/deviceInfo': 'remote.save',
          '/catalog': 'catalog',
          '/archive': 'archive',
        }[request.url] ?? 'unknown';
      const record = {
        kind,
        method: ['GET', 'POST'].includes(request.method) ? request.method : 'other',
        started_at: new Date().toISOString(),
        completed: false,
      };
      calls.push(record);
      response.on('close', () => {
        record.connection_closed = true;
      });
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        ensure(length <= 65536, '合成源输入超限');
        chunks.push(Buffer.from(chunk));
      }
      const input = Buffer.concat(chunks);
      record.input = identity(input);
      let status = 200;
      let contentType = 'application/json';
      let output;
      if (kind === 'remote.save' && request.method === 'POST') {
        remoteValue = object(JSON.parse(input.toString('utf8')));
      } else if (request.method !== 'GET' || kind === 'unknown' || kind === 'remote.save') {
        status = 404;
      }
      if (status !== 200) output = Buffer.from('{"success":false}');
      else if (kind === 'archive') {
        output = archive;
        contentType = 'application/zip';
      } else if (kind === 'catalog') output = Buffer.from(JSON.stringify(catalog));
      else
        output = Buffer.from(
          JSON.stringify({ status: 200, data: { success: true, data: remoteValue } }),
        );
      record.status = status;
      record.output = identity(output);
      response.once('finish', () => {
        record.completed = true;
      });
      response.writeHead(status, { 'content-type': contentType, 'content-length': output.length });
      response.end(output);
    })().catch((error) => {
      evidence.source_failures.push(failure(error));
      response.destroy();
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 8;
  await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('合成源监听超时'));
    }, 5000);
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timer);
      done();
    });
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  catalog = {
    manifestVersion: 'fixture-1.0.0',
    generatedAt: '2026-10-10',
    modules: [
      {
        name: moduleId,
        type: 'tool',
        version: '1.0.0',
        url: `${base}/archive`,
        sha256: digest(archive),
        size: archive.length,
        required: false,
        archiveRoot: 'bundle',
        entryFile: 'entry.txt',
        featureKey: runtimeFeatureKey,
      },
      ...runtimeModuleIds.map((name) => ({
        name,
        type: 'runtime',
        featureKey: runtimeFeatureKey,
        version: '1.0.0',
        url: `${base}/archive`,
        sha256: digest(archive),
        size: archive.length,
        required: false,
        archiveRoot: 'bundle',
        entryFile: 'entry.txt',
      })),
    ],
  };
  let closing;
  return {
    base,
    remote: () => remoteValue,
    close() {
      closing ??= (async () => {
        await new Promise((done, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else {
              evidence.source_closed = true;
              done();
            }
          });
          server.closeAllConnections();
        });
        // 在原地址和端口重新监听，确认源已经真正释放；不重试业务或端口检查。
        const probe = createServer();
        try {
          await new Promise((done, reject) => {
            probe.once('error', reject);
            probe.listen(port, '127.0.0.1', done);
          });
          evidence.source_port_released = true;
        } finally {
          if (probe.listening)
            await new Promise((done, reject) =>
              probe.close((error) => (error ? reject(error) : done())),
            );
        }
      })();
      return closing;
    },
  };
}

async function installedPackage(pluginDirectory, id, evidence) {
  const directory = await directoryAt(pluginDirectory, join(pluginDirectory, id));
  const manifestBytes = await bytesAt(await regularFile(directory, 'manifest.json'));
  const manifest = object(JSON.parse(manifestBytes.toString('utf8')));
  ensure(manifest.id === id && manifest.protocol_version === 4, '安装包身份或公开协议不符');
  same(manifest.args, [], '本轮包应使用默认旁置配置，不改变启动参数');
  ensure(typeof manifest.executable === 'string', '安装包缺少可执行入口');
  const executable = isAbsolute(manifest.executable)
    ? manifest.executable
    : resolve(directory, manifest.executable);
  const entry = relative(directory, executable).replaceAll('\\', '/');
  const executablePath = await regularFile(directory, entry);
  // CLI 部署根只保存物化清单，实际 npm 包保留在该部署的 node_modules 内。
  const bin = await directoryAt(directory, dirname(executablePath));
  ensure(basename(bin) === 'bin', '原生入口必须位于本轮 npm 包的 bin 目录');
  const packageRoot = await directoryAt(directory, dirname(bin));
  same(
    await materializeManifest(packageRoot, packageRoot),
    manifest,
    '部署清单须由当前安装包原清单与入口物化',
  );
  const names = manifest.operations?.map((operation) => operation.name);
  const required = {
    settings: ['set', 'get', 'remote.save'],
    'ai-assistant': ['cli.turn', 'session.get', 'session.close'],
    'tool-supply': [
      'catalog',
      'install',
      'import',
      'remove',
      'runtime_feature.status',
      'runtime_feature.prepare',
    ],
  }[id];
  ensure(
    Array.isArray(names) && required.every((name) => names.includes(name)),
    '安装包缺少普通业务公开操作',
  );
  if (id === 'ai-assistant') {
    ensure(!names.includes('session.create'), 'AI 首轮应直接提交 cli.turn');
    const single = manifest.operations.find((operation) => operation.name === 'cli.single');
    ensure(
      single && !Object.hasOwn(single.input_schema?.properties ?? {}, 'thread_id'),
      '单次 AI 清单仍允许旧线程',
    );
  }
  const files = [{ path: `${id}/manifest.json`, ...identity(manifestBytes) }];
  const packageEntry = relative(packageRoot, executablePath).replaceAll('\\', '/');
  for (const path of ['package.json', 'plugin.json', 'README.md', packageEntry]) {
    const actual = await regularFile(packageRoot, path);
    const bytes = await bytesAt(actual, path === packageEntry ? 128 * 1024 * 1024 : 1024 * 1024);
    files.push({
      path: relative(pluginDirectory, actual).replaceAll('\\', '/'),
      ...identity(bytes),
    });
  }
  const templatePath = `bin/${id}.config.example.json`;
  const template = await regularFile(packageRoot, templatePath);
  const templateBytes = await bytesAt(template);
  const configuration = object(JSON.parse(templateBytes.toString('utf8')));
  if (id === 'settings')
    ensure(
      configuration.format_version === 1 && typeof configuration.storage_root === 'string',
      '配置示例格式无效',
    );
  if (id === 'ai-assistant')
    ensure(
      configuration.format_version === 1 &&
        typeof configuration.executable === 'string' &&
        Array.isArray(configuration.args) &&
        configuration.projects &&
        configuration.environment,
      'AI 示例格式无效',
    );
  if (id === 'tool-supply')
    ensure(
      typeof configuration.install_root === 'string' &&
        typeof configuration.local_manifest === 'string' &&
        configuration.allow_http === false,
      '工具供应示例格式无效',
    );
  evidence.packages.push({
    id,
    version: manifest.version,
    files,
    package_root: relative(pluginDirectory, packageRoot).replaceAll('\\', '/'),
    template: {
      path: relative(pluginDirectory, template).replaceAll('\\', '/'),
      ...identity(templateBytes),
    },
  });
  return { id, bin };
}

export async function configureOrdinaryNpx({ root, temporary, pluginDirectory }) {
  const evidence = {
    format_version: 1,
    synthetic_only: true,
    packages: [],
    configurations: [],
    source_calls: [],
    source_failures: [],
    source_closed: false,
  };
  let source;
  try {
    const temporaryRoot = await realpath(temporary);
    ensure(temporaryRoot !== (await realpath(root)), '本轮临时目录不得是工程根目录');
    pluginDirectory = await directoryAt(temporaryRoot, pluginDirectory);
    const packages = {};
    for (const id of ['settings', 'ai-assistant', 'tool-supply']) {
      packages[id] = await installedPackage(pluginDirectory, id, evidence);
    }
    // 所有配置、项目、线程、工具内容与门闩只写入本次安装的部署目录。
    const work = await mkdtemp(join(packages['ai-assistant'].bin, 'ordinary-npx-'));
    await directoryAt(pluginDirectory, work);
    const fixtureRoot = join(work, 'cli');
    const project = join(work, 'project');
    const storageRoot = join(work, 'settings');
    const stateRoot = join(work, 'ai-state');
    const installRoot = join(work, 'tools');
    for (const path of [fixtureRoot, project, storageRoot, stateRoot, installRoot])
      await mkdir(path);
    const fixtureSource = await regularFile(
      root,
      'backend/target/test-fixtures/ai-cli-fixture.exe',
    );
    const fixtureBytes = await bytesAt(fixtureSource, 16 * 1024 * 1024);
    const fixturePath = join(fixtureRoot, 'ai-cli-fixture.exe');
    await writeFile(fixturePath, fixtureBytes, { flag: 'wx' });
    const copied = await bytesAt(fixturePath, 16 * 1024 * 1024);
    same(copied, fixtureBytes, 'AI 夹具必须保留预构建原字节');
    evidence.ai_fixture = {
      source: {
        path: 'backend/target/test-fixtures/ai-cli-fixture.exe',
        ...identity(fixtureBytes),
      },
      deployed: {
        path: relative(pluginDirectory, fixturePath).replaceAll('\\', '/'),
        ...identity(copied),
      },
    };
    const archive = toolArchive();
    evidence.synthetic_archive = identity(archive);
    evidence.synthetic_entry = identity(toolText);
    source = await syntheticSource(evidence, archive);
    // 只复制公开模板的已知版本语义，不继承未知字段或任何部署者凭据。
    const configurations = {
      settings: {
        format_version: 1,
        storage_root: storageRoot,
        remote: { base_url: `${source.base}/`, headers: {} },
      },
      'ai-assistant': {
        format_version: 1,
        executable: fixturePath,
        args: ['--fixture'],
        projects: { [projectId]: project },
        environment: {},
        state_root: stateRoot,
      },
      'tool-supply': {
        manifest_url: `${source.base}/catalog`,
        install_root: installRoot,
        allow_http: true,
        download_limit_bytes: 8 * 1024 * 1024,
        extracted_limit_bytes: 8 * 1024 * 1024,
        file_limit: 100,
      },
    };
    for (const [id, configuration] of Object.entries(configurations)) {
      const path = join(packages[id].bin, `${id}.config.json`);
      const bytes = Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`, 'utf8');
      // wx 拒绝覆盖已有配置；不读取本轮安装之外的实际配置。
      await writeFile(path, bytes, { flag: 'wx' });
      same(await bytesAt(path), bytes, '默认旁置配置须与本轮写入字节一致');
      evidence.configurations.push({
        id,
        path: relative(pluginDirectory, path).replaceAll('\\', '/'),
        ...identity(bytes),
      });
    }
    const state = {
      source,
      fixtureRoot,
      storageRoot,
      stateRoot,
      installRoot,
      archive,
      runIndex: 0,
      callIndex: 0,
      busy: false,
      closed: false,
    };
    const ordinary = {
      evidence,
      async close() {
        state.closed = true;
        await source.close();
      },
    };
    privateState.set(ordinary, state);
    return ordinary;
  } catch (error) {
    if (source) {
      try {
        await source.close();
      } catch (closeError) {
        evidence.source_close_failure = failure(closeError);
      }
    }
    throw auditedError(error, evidence, '合成部署配置');
  }
}

async function responseBytes(response) {
  const limit = 2 * 1024 * 1024;
  const declared = response.headers.get('content-length');
  ensure(declared === null || Number(declared) <= limit, '公开响应大小超限');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    ensure(length <= limit, '公开响应读取超限');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function businessClient({ base, mcp, headers, evidence }) {
  let rpcId = 9300;
  const common = new Headers(headers);
  common.set('content-type', 'application/json');
  async function send(transport, action, url, options, jobId = null) {
    ensure(evidence.requests.length < 2048, '普通业务请求数量超限');
    const record = {
      transport,
      action,
      job_id: jobId,
      method: options.method ?? 'GET',
      status: null,
      log_id: null,
      correlated: false,
    };
    evidence.requests.push(record);
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      ...options,
    });
    record.status = response.status;
    const logId = response.headers.get('x-deviceforge-log-id');
    ensure(uuid.test(logId ?? ''), '公开响应缺少合法日志 ID');
    record.log_id = logId;
    const bytes = await responseBytes(response);
    record.response = identity(bytes);
    return { response, body: object(JSON.parse(bytes.toString('utf8'))), record };
  }
  async function http(path, input, status = 200, jobId = null, timeout = 10000) {
    const options = { headers: common, signal: AbortSignal.timeout(timeout) };
    if (input !== undefined)
      Object.assign(options, { method: 'POST', body: JSON.stringify(input) });
    const reply = await send(
      'http',
      jobId ? '/api/v2/jobs/:id' : path,
      `${base}${path}`,
      options,
      jobId,
    );
    ensure(reply.response.status === status, 'HTTP 普通业务状态不符');
    ensure(reply.body.log_id === reply.record.log_id, 'HTTP 封套与日志关联头不一致');
    reply.record.correlated = true;
    ensure(
      reply.body.error === undefined && Object.hasOwn(reply.body, 'data'),
      'HTTP 普通业务返回错误',
    );
    return { value: reply.body.data, record: reply.record };
  }
  async function tool(name, input, jobId = null) {
    const id = ++rpcId;
    const selected = new Headers(common);
    selected.set('accept', 'application/json, text/event-stream');
    selected.set('origin', base);
    const reply = await send(
      'mcp',
      name,
      mcp,
      {
        method: 'POST',
        headers: selected,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: input },
        }),
      },
      jobId,
    );
    ensure(
      reply.response.status === 200 && reply.body.id === id && reply.body.error === undefined,
      '独立 MCP 响应无效',
    );
    const result = object(reply.body.result);
    ensure(
      result._meta?.['deviceforge/log_id'] === reply.record.log_id,
      'MCP 元数据与日志关联头不一致',
    );
    reply.record.correlated = true;
    ensure(result.isError === false, 'MCP 普通业务返回错误');
    return { value: result.structuredContent, record: reply.record };
  }
  async function submit(operation, input, transport = 'http') {
    const reply =
      transport === 'http'
        ? await http('/api/v2/jobs', { operation, input }, 202)
        : await tool(operation, input);
    const job = object(reply.value);
    ensure(uuid.test(job.id ?? '') && job.operation === operation, '公开提交必须返回匹配的 Job');
    reply.record.job_id = job.id;
    const summary = {
      id: job.id,
      operation,
      transport,
      submission_log_id: reply.record.log_id,
      status: job.status,
      shared_job: false,
    };
    evidence.jobs.push(summary);
    return summary;
  }
  async function finished(summary) {
    const end = Date.now() + 15000;
    let reply;
    while (Date.now() < end) {
      reply = await http(
        `/api/v2/jobs/${summary.id}`,
        undefined,
        200,
        summary.id,
        Math.min(10000, Math.max(1, end - Date.now())),
      );
      const job = object(reply.value);
      ensure(
        job.id === summary.id && job.operation === summary.operation,
        '轮询返回了不同的业务 Job',
      );
      summary.status = job.status;
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        const other = await tool('deviceforge.get_job', { id: job.id }, job.id);
        same(other.value, job, 'HTTP 与独立 MCP 必须读取同一终态 Job');
        Object.assign(summary, {
          shared_job: true,
          terminal_http_log_id: reply.record.log_id,
          terminal_mcp_log_id: other.record.log_id,
          result: identity(Buffer.from(JSON.stringify(job.result ?? null))),
          error_sha256: job.error === null ? null : digest(String(job.error)),
        });
        ensure(job.status === 'succeeded', '普通业务 Job 未实际成功');
        const result = object(job.result);
        same(result.artifacts, [], '本轮普通业务不应产生意外产物');
        return object(result.result);
      }
      await delay(25);
    }
    throw new Error('普通业务 Job 等待超时');
  }
  return {
    submit,
    finished,
    async run(operation, input, transport) {
      return finished(await submit(operation, input, transport));
    },
  };
}

async function waitFile(path) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      return await bytesAt(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error('AI 固定门闩未在期限内就绪');
}
function fixtureArgs(bytes) {
  ensure(bytes.length >= 4, 'AI 夹具参数证据截断');
  const count = bytes.readUInt32LE();
  ensure(count <= 8, 'AI 参数数量超限');
  const args = [];
  let offset = 4;
  for (let index = 0; index < count; index++) {
    ensure(offset + 4 <= bytes.length, 'AI 参数长度证据截断');
    const length = bytes.readUInt32LE(offset);
    offset += 4;
    ensure(length <= 128 && offset + length <= bytes.length, 'AI 参数内容证据截断');
    args.push(bytes.subarray(offset, offset + length).toString('utf8'));
    offset += length;
  }
  ensure(offset === bytes.length, 'AI 参数证据含额外字节');
  return args;
}
async function exited(pid) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(25);
  }
  throw new Error('AI 夹具实际进程退出未确认');
}

export async function verifyOrdinaryNpx({ base, mcp, headers, ordinary }) {
  const evidence = {
    format_version: 1,
    synthetic_only: true,
    started_at: new Date().toISOString(),
    passed: false,
    checks: [],
    jobs: [],
    requests: [],
    ai_tools: [],
    source_calls: [],
  };
  const state = privateState.get(ordinary);
  let active = '普通业务参数';
  let acquired = false;
  let sourceStart = 0;
  async function check(name, execute) {
    active = name;
    const start = Date.now();
    try {
      await execute();
      evidence.checks.push({ name, passed: true, elapsed_ms: Date.now() - start });
    } catch (error) {
      evidence.checks.push({
        name,
        passed: false,
        elapsed_ms: Date.now() - start,
        failure: failure(error),
      });
      throw error;
    }
  }
  try {
    ensure(state && !state.closed && !state.busy, '普通业务句柄须有效且串行使用');
    const httpUrl = new URL(base);
    const mcpUrl = new URL(mcp);
    for (const url of [httpUrl, mcpUrl]) {
      ensure(
        url.protocol === 'http:' &&
          url.hostname === '127.0.0.1' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash,
        '普通业务仅调用本轮本地宿主',
      );
    }
    ensure(
      httpUrl.pathname === '/' && mcpUrl.pathname === '/mcp' && httpUrl.origin !== mcpUrl.origin,
      '必须使用 HTTP v2 与独立 MCP 监听器',
    );
    state.busy = true;
    acquired = true;
    sourceStart = ordinary.evidence.source_calls.length;
    const index = ++state.runIndex;
    evidence.run_index = index;
    evidence.phase = new Headers(headers).has('authorization') ? '显式令牌' : '默认免令牌';
    const ownerId = `npx-${randomUUID().replaceAll('-', '')}`;
    const threadId = randomUUID();
    evidence.namespace = { owner_id: ownerId, thread_id: threadId };
    const client = businessClient({ base: httpUrl.origin, mcp: mcpUrl.href, headers, evidence });
    const localInput = { scope: 'user', owner_id: ownerId, section: 'theme' };
    const theme = { mode: 'synthetic' };
    await check('配置 set/get 实际成功', async () => {
      const written = await client.run('plugin.settings.set', {
        ...localInput,
        expected_revision: '0',
        value: theme,
      });
      ensure(written.format_version === 1 && written.revision === '1', '配置写入修订不符');
      same(written.sections.theme, theme, '配置写入内容不符');
      const read = await client.run('plugin.settings.get', localInput, 'mcp');
      ensure(read.revision === '1' && read.section === 'theme', '配置读取修订不符');
      same(read.value, theme, '配置读取内容不符');
    });
    await check('远端保存及本地备份实际成功', async () => {
      const value = { label: '本轮合成远端配置', round: index };
      const input = { scope: 'user', owner_id: ownerId, section: 'deviceInfo' };
      const saved = await client.run(
        'plugin.settings.remote.save',
        { ...input, expected_revision: '1', value },
        'mcp',
      );
      ensure(
        saved.revision === '2' &&
          saved.source === 'remote' &&
          saved.remote_committed === true &&
          saved.backup_updated === true,
        '远端保存与备份状态不符',
      );
      same(saved.value, value, '远端保存返回内容不符');
      same(state.source.remote(), value, '合成旧服务未收到实际配置内容');
      const backup = await client.run('plugin.settings.get', input);
      ensure(backup.revision === '2', '远端保存备份修订不符');
      same(backup.value, value, '远端保存备份内容不符');
      const calls = ordinary.evidence.source_calls
        .slice(sourceStart)
        .filter((call) => call.kind === 'remote.save');
      ensure(
        calls.length === 1 &&
          calls[0].method === 'POST' &&
          calls[0].status === 200 &&
          calls[0].completed &&
          calls[0].input.bytes > 0,
        '本轮远端保存须实际请求一次',
      );
      evidence.remote_save = {
        revision: saved.revision,
        remote_committed: true,
        backup_updated: true,
        input: calls[0].input,
      };
    });
    await check('AI 首次 cli.turn 与实际进程退出', async () => {
      const callIndex = ++state.callIndex;
      ensure(callIndex <= 64, 'AI 固定门闩调用数超限');
      const call = join(state.fixtureRoot, `call-${String(callIndex).padStart(2, '0')}`);
      const events = [
        { type: 'thread.started', thread_id: threadId },
        { type: 'item.completed', item: { type: 'agent_message', text: answer } },
        { type: 'turn.completed' },
      ];
      await writeFile(
        join(state.fixtureRoot, `stdout-${callIndex}`),
        events.map((event) => JSON.stringify(event)).join('\n') + '\n',
        { flag: 'wx' },
      );
      await writeFile(join(state.fixtureRoot, `code-${callIndex}`), '0', { flag: 'wx' });
      const prompt = `设备工坊合成提示/npx-${index}`;
      const summary = {
        call_index: callIndex,
        ready: false,
        release_written: false,
        exited: false,
      };
      evidence.ai_tools.push(summary);
      // 首次 turn 不传 thread_id，不调用不存在的 session.create。
      let job;
      try {
        // 提交响应也可能在宿主接受任务后失败，必须纳入同一门闩回收范围。
        job = await client.submit('plugin.ai-assistant.cli.turn', {
          project_id: projectId,
          prompt,
        });
        summary.job_id = job.id;
        same((await waitFile(join(call, 'ready'))).toString('utf8'), '1', 'AI 夹具就绪门闩不符');
        summary.ready = true;
        const args = await bytesAt(join(call, 'argv.bin'));
        same(fixtureArgs(args), ['exec', '--json', '--fixture', '-'], 'AI 首轮 argv 不符');
        summary.argv = identity(args);
        summary.argv_validated = true;
        const pid = Number((await bytesAt(join(call, 'pid'))).toString('utf8'));
        ensure(Number.isSafeInteger(pid) && pid > 0, 'AI 实际进程 PID 无效');
        summary.pid = pid;
        const inputBytes = Number((await bytesAt(join(call, 'input-bytes'))).toString('utf8'));
        ensure(inputBytes === Buffer.byteLength(prompt), 'AI stdin 实际字节数不符');
        summary.input_bytes = inputBytes;
        same(
          (await bytesAt(join(call, 'host-token-inherited'))).toString('utf8'),
          'false',
          'AI 夹具继承了宿主令牌',
        );
        summary.host_token_inherited = false;
      } finally {
        // 断言失败也释放本次门闩，允许主代理正常关闭宿主；不重放业务。
        await writeFile(join(state.fixtureRoot, `release-${callIndex}`), '1', { flag: 'wx' });
        summary.release_written = true;
      }
      const result = await client.finished(job);
      ensure(
        result.project_id === projectId && result.thread_id === threadId,
        'AI 首轮线程归属不符',
      );
      same(result.text, answer, 'AI 合成回答不符');
      same(result.events, events, 'AI 合成事件不符');
      summary.answer = identity(Buffer.from(result.text));
      summary.event_count = result.events.length;
      same((await bytesAt(join(call, 'normal-exit'))).toString('utf8'), '0', 'AI 夹具未正常退出');
      summary.normal_exit = 0;
      await exited(summary.pid);
      summary.exited = true;
    });
    await check('AI 持久线程 get/close', async () => {
      const input = { project_id: projectId, thread_id: threadId };
      const snapshot = await client.run('plugin.ai-assistant.session.get', input, 'mcp');
      same(
        snapshot,
        { ...input, turns: '1', closed: false, uncertain: false },
        'AI 持久首轮状态不符',
      );
      const closed = await client.run('plugin.ai-assistant.session.close', input);
      same(closed, { ...input, turns: '1', closed: true, uncertain: false }, 'AI 线程关闭状态不符');
      const path = await regularFile(state.stateRoot, `threads/${threadId}.json`);
      const bytes = await bytesAt(path);
      const persisted = object(JSON.parse(bytes.toString('utf8')));
      ensure(
        persisted.thread_id === threadId &&
          persisted.project_id === projectId &&
          persisted.turns === 1 &&
          persisted.closed === true &&
          persisted.uncertain === false,
        'AI 关闭必须实际持久化',
      );
      evidence.ai_session = {
        thread_id: threadId,
        turns: '1',
        closed: true,
        uncertain: false,
        state: identity(bytes),
      };
    });
    const target = join(state.installRoot, moduleId);
    const transaction = join(state.installRoot, '.transactions', moduleId);
    await check('工具 catalog/install 与安装原字节', async () => {
      ensure(await absent(target), '本轮工具目标须为空，避免复用旧安装结果');
      const catalog = await client.run('plugin.tool-supply.catalog', {});
      ensure(catalog.source_error === null && catalog.modules?.length === 3, '工具清单来源不符');
      const row = catalog.modules[0];
      ensure(row.module_id === moduleId && row.action === 'install', '工具清单安装资格不符');
      const installed = await client.run(
        'plugin.tool-supply.install',
        { module_id: moduleId },
        'mcp',
      );
      ensure(
        installed.module_id === moduleId &&
          installed.version === '1.0.0' &&
          installed.changed === true &&
          installed.sha256 === digest(state.archive),
        '工具实际下载校验结果不符',
      );
      const bytes = await bytesAt(await regularFile(target, 'entry.txt'));
      same(bytes, toolText, '工具安装文本必须与 ZIP 原字节一致');
      const stateBytes = await bytesAt(await regularFile(target, '.tool-supply-state.json'));
      const installedState = object(JSON.parse(stateBytes.toString('utf8')));
      ensure(
        installedState.module_id === moduleId &&
          installedState.version === '1.0.0' &&
          installedState.sha256 === digest(state.archive) &&
          installedState.archive_root === 'bundle' &&
          installedState.entry_file === 'entry.txt',
        '工具持久安装资格不符',
      );
      ensure(await absent(transaction), '工具安装后事务目录仍残留');
      const downloads = ordinary.evidence.source_calls
        .slice(sourceStart)
        .filter((call) => call.kind === 'archive');
      ensure(
        downloads.length === 1 &&
          downloads[0].completed &&
          downloads[0].status === 200 &&
          downloads[0].output.sha256 === installed.sha256,
        '须实际下载本轮合成 ZIP 一次',
      );
      evidence.tool_install = {
        module_id: moduleId,
        changed: true,
        archive: identity(state.archive),
        entry: identity(bytes),
        state: identity(stateBytes),
        transaction_absent: true,
      };
    });
    await check('工具 remove 与固定清理', async () => {
      const removed = await client.run('plugin.tool-supply.remove', { module_id: moduleId });
      ensure(removed.module_id === moduleId && removed.removed === true, '工具实际移除结果不符');
      ensure((await absent(target)) && (await absent(transaction)), '工具移除后目标或事务目录残留');
      evidence.tool_remove = {
        module_id: moduleId,
        removed: true,
        target_absent: true,
        transaction_absent: true,
      };
    });
    await check('运行时功能单快照、多模块准备及重复准备无下载', async () => {
      evidence.runtime_feature = await verifyRuntimeFeatureNpx({
        client,
        installRoot: state.installRoot,
        checksum: digest(state.archive),
        bytes: state.archive.length,
        entryBytes: toolText,
        sourceCalls: ordinary.evidence.source_calls,
        bytesAt,
        absent,
        identity,
      });
    });
    ensure(
      evidence.requests.every((request) => request.correlated),
      '存在未确认的 HTTP/MCP 日志关联',
    );
    evidence.log_correlation = {
      requests: evidence.requests.length,
      correlated: evidence.requests.length,
      unique_log_ids: new Set(evidence.requests.map((request) => request.log_id)).size,
      shared_jobs: evidence.jobs.filter((job) => job.shared_job).length,
    };
    evidence.passed = true;
    return evidence;
  } catch (error) {
    throw auditedError(error, evidence, active);
  } finally {
    evidence.completed_at = new Date().toISOString();
    if (acquired) {
      evidence.source_calls = ordinary.evidence.source_calls.slice(sourceStart);
      state.busy = false;
    }
  }
}
