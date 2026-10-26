// 独立打包和进程监督只服务本次双缓存验收，不覆盖工作区 runtime。
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { npmCommand } from '../../cli/src/processes.mjs';
import { client } from './client.mjs';
import { assertView, check, digest, identity, poll, save, tree } from './evidence.mjs';
import { environment } from './host.mjs';
import { component, scriptArgs } from './fixtures.mjs';
import { belongsToRun, sameProcess } from './processes.mjs';
import { listenerReleased } from './source.mjs';

const executeFile = promisify(execFile);
const preparationHosts = new Set([
  '842e941990cd1097d16c4db6a58f76baf39a1a9d969bc920b536ba168e18dc30',
  '0ff827deb0a3bfda9a7b5c25dd450bd279b19bfb8e84692d47fec584f3b3e4de',
]);
export const osAuditRetries = [];
export const osAuditSnapshots = [];
const managedEntries = [];
const observedProcesses = new Map();

async function osQuery(operation, read) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 2) throw error;
      const backoff = [150, 500][attempt];
      osAuditRetries.push({
        operation,
        attempt: attempt + 1,
        backoff_ms: backoff,
        error: error.code ?? error.name,
        at: new Date().toISOString(),
      });
      await delay(backoff);
    }
  }
}

export async function listenerOwners(port) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  return osQuery('netstat-listener-owners', async () => {
    const { stdout } = await executeFile(
      join(process.env.SystemRoot, 'System32/netstat.exe'),
      ['-ano', '-p', 'tcp'],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
    );
    const owners = stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (fields) =>
          fields.length === 5 &&
          fields[0] === 'TCP' &&
          fields[3] === 'LISTENING' &&
          Number(fields[1].match(/:(\d+)$/)?.[1]) === port,
      )
      .map((fields) => Number(fields[4]));
    assert.ok(owners.every((pid) => Number.isSafeInteger(pid) && pid > 0));
    return [...new Set(owners)].sort((a, b) => a - b);
  });
}

// 在 JavaScript 中组装扁平祖先链，避免 PowerShell 对多层数组的 JSON 嵌套。
export function ownFromSnapshot(all, root, hosts = [], driver = process.pid) {
  const byId = new Map(all.map((item) => [item.ProcessId, item]));
  return all
    .filter((item) => item.ProcessId !== driver)
    .map((item) => {
      const chain = [],
        seen = new Set([item.ProcessId]);
      let current = item;
      while (chain.length < 64) {
        const parent = byId.get(current.ParentProcessId);
        if (
          !parent ||
          seen.has(parent.ProcessId) ||
          Date.parse(parent.CreatedAt) > Date.parse(current.CreatedAt)
        )
          break;
        chain.push(parent);
        seen.add(parent.ProcessId);
        current = parent;
      }
      return {
        ...item,
        Ancestry: chain.map(({ ProcessId, ParentProcessId, CreatedAt }) => ({
          ProcessId,
          ParentProcessId,
          CreatedAt,
        })),
      };
    })
    .filter((item) => belongsToRun(item, root, hosts, driver));
}

export async function ownedProcesses(root, hosts = []) {
  return osQuery('wmi-dcom-owned-processes', async () => {
    const previous = observedProcesses.get(root) ?? new Map();
    const starts = managedEntries.filter((entry) => inside(root, entry.cwd));
    const seeds = [
      ...new Set(
        [
          process.pid,
          ...starts.map((entry) => entry.pid),
          ...previous.keys(),
          ...hosts.flatMap((host) => [
            host.pid,
            ...(host.os_processes ?? []).map((item) => item.ProcessId),
          ]),
        ].filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      ),
    ];
    // CIM 传输实测取消，改用 DCOM 单 PID 查询；仍须完整成功且包含存活驱动。
    const script =
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $queue=[Collections.Generic.Queue[int]]::new(); foreach($id in ($env:DF_NPX_AUDIT_PIDS -split ',')){$queue.Enqueue([int]$id)}; $seen=@{}; $items=@{}; while($queue.Count -gt 0){$id=$queue.Dequeue(); if($seen.ContainsKey($id)){continue}; $seen[$id]=$true; if($seen.Count -gt 256){throw '本轮进程审计超过256个节点'}; $prefix='SELECT ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE '; $own=@(Get-WmiObject -Query ($prefix+\"ProcessId=$id\") -ErrorAction Stop); $children=@(Get-WmiObject -Query ($prefix+\"ParentProcessId=$id\") -ErrorAction Stop); foreach($item in @($own+$children)){if($item.ProcessId -eq $PID){continue}; $items[[int]$item.ProcessId]=$item; if(!$seen.ContainsKey([int]$item.ProcessId)){$queue.Enqueue([int]$item.ProcessId)}}}; ConvertTo-Json -Compress -Depth 3 -InputObject @($items.Values | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='CreatedAt';e={[Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate).ToUniversalTime().ToString('o')}})";
    const { stdout } = await executeFile(
      join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, DF_NPX_AUDIT_PIDS: seeds.join(',') },
      },
    );
    const all = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    assert.ok(
      Array.isArray(all) && all.some((item) => item.ProcessId === process.pid),
      'OS 进程快照未包含仍在运行的驱动，禁止把查询失败当作零残留',
    );
    const active = new Map(all.map((item) => [item.ProcessId, item]));
    const combined = new Map(previous);
    for (const item of all) combined.set(item.ProcessId, item);
    const owned = ownFromSnapshot([...combined.values()], root, hosts).filter(
      (item) => active.has(item.ProcessId) && sameProcess(active.get(item.ProcessId), item),
    );
    const remembered = new Map(previous);
    for (const item of owned) remembered.set(item.ProcessId, item);
    const driver = active.get(process.pid);
    remembered.set(process.pid, driver);
    observedProcesses.set(root, remembered);
    osAuditSnapshots.push({
      at: new Date().toISOString(),
      backend: 'wmi-dcom',
      root,
      seed_pids: seeds,
      driver_pid: process.pid,
      queried_processes: all.length,
      owned: owned.map((item) => ({
        pid: item.ProcessId,
        parent_pid: item.ParentProcessId,
        created_at: item.CreatedAt,
        executable: item.ExecutablePath,
        command: item.CommandLine,
      })),
    });
    return owned;
  });
}

export async function reclaim(root, report) {
  const survivors = (await ownedProcesses(root, report.hosts)).sort(
    (a, b) => b.Ancestry.length - a.Ancestry.length,
  );
  for (const candidate of survivors) {
    const current = (await ownedProcesses(root, report.hosts)).find(
      (item) => item.ProcessId === candidate.ProcessId,
    );
    if (!current) continue;
    assert.ok(sameProcess(current, candidate), '进程身份变化，拒绝按复用 PID 回收');
    const entry = {
      pid: candidate.ProcessId,
      command: candidate.CommandLine,
      created_at: candidate.CreatedAt,
      forced: true,
    };
    report.reclamation.push(entry);
    await executeFile(
      join(process.env.SystemRoot, 'System32/taskkill.exe'),
      ['/PID', String(candidate.ProcessId), '/F'],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    entry.reclaimed = true;
  }
  report.remaining_processes = await ownedProcesses(root, report.hosts);
  assert.deepEqual(report.remaining_processes, [], '本轮 npx 归属进程必须全部退出');
  return survivors.length;
}

export async function selectedNpxRuntime(
  { api, user, report, hostEntry, fixtures },
  fixture,
  execution,
) {
  const selected = await realpath(execution.helper),
    actual = await realpath(execution.runtime_executable);
  assert.equal(selected, actual, '脚本本体必须使用所选运行时，不能仅让 helper 使用它');
  assert.notEqual(actual, await realpath(process.execPath), '脚本不能偷用 npx 启动器的全局 Node');
  assert.equal((await identity(actual)).sha256, fixtures.node.sha256);
  assert.equal(execution.runtime_parent_pid, hostEntry.pid, '脚本必须直接属于本阶段真实宿主');
  assert.ok(Number.isInteger(execution.runtime_pid) && execution.runtime_pid > 0);
  const installation = await api.http(`/api/v2/plugin-installations/${fixture.target.id}`);
  const component = installation.components.find(
    (item) => item.kind === 'server' && item.id === fixture.component.id,
  );
  assert.ok(component && /^[a-f0-9]{64}$/.test(component.revision));
  assert.equal(component.entry_path, 'index.mjs');
  const directory = join(user, 'plugins', component.id, 'revisions', component.revision);
  assert.ok(
    inside(await realpath(user), await realpath(directory)),
    '组件必须位于同一用户根的真实修订目录',
  );
  assert.equal(await realpath(execution.runtime_argv[0]), selected);
  assert.equal(
    await realpath(execution.runtime_argv[1]),
    await realpath(join(directory, component.entry_path)),
  );
  assert.deepEqual(execution.runtime_argv.slice(2), scriptArgs);
  const markerPath = join(directory, '.deviceforge-runtime.json'),
    metadata = await lstat(markerPath);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 65536);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.deepEqual(marker, { format_version: 1, dependency: fixture.runtimeDependency });
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, component.id);
  assert.deepEqual(manifest.args.slice(1), scriptArgs);
  const evidence = {
    component: fixture.component,
    revision: component.revision,
    component_directory: directory,
    dependency: fixture.runtimeDependency,
    job_id: execution.job_id,
    selected,
    actual,
    pid: execution.runtime_pid,
    parent_pid: execution.runtime_parent_pid,
    argv: execution.runtime_argv,
    marker,
    persisted_manifest_executable: manifest.executable,
    effective_executable: actual,
    marker_identity: await identity(markerPath),
    program_identity: await identity(actual),
  };
  (report.runtime_executions ??= []).push(evidence);
  return evidence;
}

export const help = `插件依赖双缓存 npx 验收（只消费已冻结输入，不编译）
  node scripts/plugin-dependencies-npx-smoke.mjs --self-test
  node scripts/plugin-dependencies-npx-smoke.mjs --binary-directory 冻结目录 --profile debug|release [--cli-snapshot-directory CLI快照根] [--dist-directory 网页目录] [--output-directory 新证据目录]
  02 新宿主可显式追加 --dependency-preparation --initial-cli；旧宿主不得声明新 capability。
冻结目录必须包含 apk-server.exe 与 validate-plugin.exe。
profile 是调用者声明的实际构建档位，必须显式指定；不按目录名猜测。
未提供冻结目录时禁止完整执行；不默认消费 target 或 workspace runtime。`;

export function options(args) {
  const result = {},
    seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    assert.ok(!seen.has(key), `参数重复：${key}`);
    seen.add(key);
    if (key === '--help' || key === '--self-test') result[key.slice(2)] = true;
    else if (key === '--dependency-preparation') result.dependencyPreparation = true;
    else if (key === '--initial-cli') result.initialCli = true;
    else {
      const field = {
        '--binary-directory': 'binaryDirectory',
        '--profile': 'profile',
        '--dist-directory': 'distDirectory',
        '--cli-snapshot-directory': 'cliSnapshotDirectory',
        '--output-directory': 'outputDirectory',
      }[key];
      assert.ok(field, `未知参数：${key}`);
      const value = args[++index];
      assert.ok(value && !value.startsWith('--'), `参数缺值：${key}`);
      result[field] = field === 'profile' ? value : resolve(value);
    }
  }
  if (result.help || result['self-test']) {
    assert.equal(args.length, 1, '说明或自检不得混入执行参数');
    return result;
  }
  assert.ok(result.binaryDirectory, '等待主代理提供 --binary-directory，禁止推导共享 target');
  assert.ok(['debug', 'release'].includes(result.profile), '--profile 必须显式为 debug 或 release');
  assert.ok(
    !result.initialCli || result.dependencyPreparation,
    '初始 CLI 验收要求显式启用02依赖准备能力',
  );
  assert.ok(
    !result.dependencyPreparation || result.cliSnapshotDirectory,
    '02能力包必须使用明确 CLI 快照',
  );
  return result;
}

export function inside(root, path) {
  const offset = relative(resolve(root), resolve(path));
  return (
    offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))
  );
}

export function allowedMember(path) {
  if (path.includes('\\') || path.split('/').some((part) => ['', '.', '..'].includes(part)))
    return false;
  return (
    [
      'package.json',
      'README.md',
      'cli/README.md',
      'runtime/manifest.json',
      'runtime/win32-x64/apk-server.exe',
      'runtime/win32-x64/validate-plugin.exe',
    ].includes(path) ||
    path.startsWith('cli/bin/') ||
    path.startsWith('cli/src/') ||
    path.startsWith('runtime/web/')
  );
}

export function runtimeManifest(profile, version, host, validator, dependencyPreparation = false) {
  assert.ok(['debug', 'release'].includes(profile), '不接受隐含 release 档位');
  return {
    format_version: 1,
    version,
    profile,
    ...(dependencyPreparation ? { capabilities: ['plugin_dependencies_v1'] } : {}),
    web: 'web',
    platforms: [
      {
        platform: 'win32',
        arch: 'x64',
        backend: 'win32-x64/apk-server.exe',
        validator: 'win32-x64/validate-plugin.exe',
        sha256: host.sha256,
        validator_sha256: validator.sha256,
      },
    ],
  };
}

export function cleanEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(APK_|DEVICEFORGE_|DF_DEPENDENCY_|NPM_|NODE_OPTIONS$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(
          key,
        ),
    ),
  );
}

function npmEnvironment(cache, config) {
  return {
    ...cleanEnvironment(),
    npm_config_cache: cache,
    npm_config_userconfig: config,
    npm_config_globalconfig: `${config}.global`,
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_progress: 'false',
  };
}

function managed(command, args, { cwd, env, log, report, label }) {
  const streams = ['stdout', 'stderr'].map((name) =>
    createWriteStream(`${log}.${name}.log`, { flags: 'wx' }),
  );
  const entry = { label, command, args, cwd, started_at: new Date().toISOString() };
  (report.commands ??= []).push(entry);
  managedEntries.push(entry);
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  entry.pid = child.pid;
  child.stdout.pipe(streams[0]);
  child.stderr.pipe(streams[1]);
  let failure;
  child.once('error', (error) => {
    failure = error;
    entry.error = error.message;
  });
  child.once('exit', (code, signal) => {
    entry.exit = { code, signal, at: new Date().toISOString() };
  });
  const closed = new Promise((done) =>
    child.once('close', (code, signal) => {
      entry.close = { code, signal, at: new Date().toISOString() };
      done(entry.close);
    }),
  );
  return {
    child,
    closed,
    entry,
    get failure() {
      return failure;
    },
    async finish(timeout = 120000) {
      const result = await Promise.race([closed, delay(timeout, undefined, { ref: false })]);
      assert.ok(result, `${label} 退出超时`);
      await Promise.all(
        streams.map((stream) => finished(stream, { signal: AbortSignal.timeout(5000) })),
      );
      if (failure) throw failure;
      assert.equal(result.code, 0, `${label} 失败，查看 ${log}.stderr.log`);
      assert.equal(result.signal, null);
      return readFile(`${log}.stdout.log`, 'utf8');
    },
  };
}

export async function packNpx({
  repository,
  root,
  binaryDirectory,
  distDirectory,
  profile,
  dependencyPreparation = false,
  report,
  signal,
}) {
  const staging = join(root, 'npm-source'),
    output = join(root, 'npm-package');
  await mkdir(join(staging, 'runtime/win32-x64'), { recursive: true });
  await mkdir(output);
  const host = await identity(join(binaryDirectory, 'apk-server.exe'));
  const validator = await identity(join(binaryDirectory, 'validate-plugin.exe'));
  if (dependencyPreparation)
    assert.ok(
      preparationHosts.has(host.sha256),
      '仅明确批准的02/03宿主字节可声明 plugin_dependencies_v1',
    );
  const web = await tree(distDirectory);
  assert.ok(
    web.some((file) => file.path === 'index.html'),
    '必须提供真实已构建 dist',
  );
  const cli = {
    bin: await tree(join(repository, 'cli/bin')),
    src: await tree(join(repository, 'cli/src')),
  };
  await cp(join(repository, 'cli/bin'), join(staging, 'cli/bin'), { recursive: true });
  await cp(join(repository, 'cli/src'), join(staging, 'cli/src'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'cli/README.md'])
    await copyFile(join(repository, file), join(staging, file));
  await copyFile(host.path, join(staging, 'runtime/win32-x64/apk-server.exe'));
  await copyFile(validator.path, join(staging, 'runtime/win32-x64/validate-plugin.exe'));
  await cp(distDirectory, join(staging, 'runtime/web'), { recursive: true });
  assert.deepEqual(await tree(join(staging, 'cli/bin')), cli.bin, 'CLI bin 复制期间发生变化');
  assert.deepEqual(await tree(join(staging, 'cli/src')), cli.src, 'CLI src 复制期间发生变化');
  assert.deepEqual(await tree(join(staging, 'runtime/web')), web, 'dist 复制期间发生变化');
  assert.equal(
    (await identity(join(staging, 'runtime/win32-x64/apk-server.exe'))).sha256,
    host.sha256,
  );
  assert.equal(
    (await identity(join(staging, 'runtime/win32-x64/validate-plugin.exe'))).sha256,
    validator.sha256,
  );
  const pkg = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@deviceforge/cli');
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, '此离线主包不允许额外 npm 依赖');
  const manifest = runtimeManifest(profile, pkg.version, host, validator, dependencyPreparation);
  await save(join(staging, 'runtime/manifest.json'), manifest);
  const config = join(root, 'empty.npmrc');
  await writeFile(config, '', { flag: 'wx' });
  await writeFile(`${config}.global`, '', { flag: 'wx' });
  const before = await tree(staging),
    npm = npmCommand(cleanEnvironment());
  assert.equal(
    npm.command,
    process.execPath,
    'Windows 必须使用明确 npm-cli.js，不经过字符串 shell',
  );
  const npx = join(dirname(npm.prefix[0]), 'npx-cli.js');
  await identity(npx);
  signal?.throwIfAborted();
  const command = managed(
    npm.command,
    [...npm.prefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', output],
    {
      cwd: staging,
      env: npmEnvironment(join(root, 'pack-cache'), config),
      log: join(root, 'npm-pack'),
      report,
      label: 'npm pack',
    },
  );
  const [packed] = JSON.parse(await command.finish());
  assert.ok(
    packed.files.length > 0 && packed.files.every((file) => allowedMember(file.path)),
    'npm 主包只能包含 CLI、host、validator、dist 和包说明',
  );
  for (const required of [
    'cli/bin/deviceforge.mjs',
    'runtime/manifest.json',
    'runtime/web/index.html',
    'runtime/win32-x64/apk-server.exe',
    'runtime/win32-x64/validate-plugin.exe',
  ])
    assert.ok(
      packed.files.some((file) => file.path === required),
      `主包缺少 ${required}`,
    );
  assert.deepEqual(await tree(staging), before, 'npm pack 不得改变冻结快照');
  const archive = await identity(join(output, packed.filename));
  await save(join(root, 'npm-pack-files.json'), packed);
  const result = {
    ...archive,
    archive: archive.path,
    profile,
    profile_source: '调用者显式声明，未从 PE 反推构建档位',
    host,
    validator,
    manifest,
    staging,
    staging_files: before,
    web,
    cli,
    cli_source_directory: repository,
    npx,
    config,
  };
  report.package = result;
  return result;
}

async function reservePort(excluded = []) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const server = createServer();
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const port = server.address().port;
    await new Promise((done) => server.close(done));
    if (![7031, 5173, 5186, ...excluded].includes(port)) return port;
  }
  throw new Error('无法分配独占随机端口');
}

async function cachedPackage(cache, packed) {
  const candidates = [];
  for (const name of await readdir(join(cache, '_npx'))) {
    const path = join(cache, '_npx', name, 'node_modules/@deviceforge/cli');
    try {
      await readFile(join(path, 'package.json'));
      candidates.push(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  assert.equal(candidates.length, 1, '新缓存中必须且只能有一个被测主包');
  const path = await realpath(candidates[0]);
  assert.ok(inside(await realpath(cache), path), '实际 npm 包必须落在本阶段独占缓存');
  const files = await tree(path);
  assert.deepEqual(files, packed.staging_files, '实际 npx 安装字节必须逐文件等于冻结打包快照');
  return { path, files };
}

export async function launchNpxHost({
  root,
  phaseRoot,
  cache,
  cwd,
  user,
  packed,
  source,
  envProgram,
  report,
  signal,
}) {
  const port = await reservePort(),
    mcpPort = await reservePort([port]);
  for (const path of [
    cache,
    cwd,
    join(phaseRoot, 'data/server-plugins'),
    join(phaseRoot, 'data/browser-plugins'),
    join(phaseRoot, 'responses/http'),
    join(phaseRoot, 'responses/mcp'),
    join(phaseRoot, 'responses/cli'),
  ])
    await mkdir(path, { recursive: true });
  assert.deepEqual(await readdir(cache), [], '每阶段开始前 npm 缓存必须为空');
  assert.deepEqual(await readdir(cwd), [], '每阶段必须使用新的空 cwd');
  assert.deepEqual(
    await ownedProcesses(root, report.hosts),
    [],
    '开始新阶段前上一阶段归属进程必须已退出',
  );
  const base = `http://127.0.0.1:${port}`,
    mcpBase = `http://127.0.0.1:${mcpPort}`;
  const phaseEnv = environment(phaseRoot, port, source, envProgram);
  const env = {
    ...npmEnvironment(cache, packed.config),
    ...Object.fromEntries(
      Object.entries(phaseEnv).filter(([key]) => /^(APK_|DEVICEFORGE_|DF_DEPENDENCY_)/.test(key)),
    ),
    DEVICEFORGE_USER_DIR: user,
  };
  const prefix = [packed.npx, '--yes', '--package', packed.archive, 'deviceforge'];
  const args = [
    ...prefix,
    'start',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--mcp-port',
    String(mcpPort),
    '--data-dir',
    join(phaseRoot, 'data'),
    '--marketplace-url',
    source,
  ];
  signal?.throwIfAborted();
  const processEntry = managed(process.execPath, args, {
    cwd,
    env,
    log: join(phaseRoot, 'npx-start'),
    report,
    label: 'npx start',
  });
  const launcher = processEntry.entry;
  report.hosts.push(launcher);
  const api = client(base, join(phaseRoot, 'responses/http'), report, signal);
  const mcp = client(mcpBase, join(phaseRoot, 'responses/mcp'), report, signal);
  const entry = {
    port,
    mcp_port: mcpPort,
    cache,
    cwd,
    user_root: user,
    data_root: join(phaseRoot, 'data'),
    started_at: launcher.started_at,
    bootstrap_node: 'npx 启动器自带 Node；插件本体另核所选依赖',
  };
  report.hosts.push(entry);
  let stopped = false,
    webOwner,
    mcpOwner;
  async function stop() {
    if (stopped) return;
    let failure;
    try {
      if (!launcher.exit && !processEntry.failure) {
        const owned = await ownedProcesses(root, report.hosts);
        const owners = await listenerOwners(port);
        assert.equal(owners.length, 1, '关机前必须有唯一前端监听者');
        assert.ok(
          owned.some((item) => item.ProcessId === owners[0]),
          '禁止向非本轮端口发关机请求',
        );
        assert.deepEqual(await listenerOwners(mcpPort), owners, '前端与 MCP 应属于同一个 CLI 进程');
        if (webOwner) assert.deepEqual(owners, [webOwner]);
        assert.equal(
          (await api.http('/api/v2/system/shutdown', { method: 'POST' })).stopping,
          true,
        );
        entry.shutdown_requested = true;
      }
      await processEntry.finish(15000);
      entry.exit = {
        ...launcher.exit,
        observation: 'npx 已收到并等待后端退出；此处记录监督链关闭上界',
      };
      entry.graceful = true;
    } catch (error) {
      failure = error;
    }
    try {
      const forced = await reclaim(root, report);
      assert.equal(forced, 0, '需要强制回收时不得记为正常通过');
    } catch (error) {
      failure ??= error;
    }
    try {
      await processEntry.finish(5000);
      await listenerReleased(port);
      await listenerReleased(mcpPort);
      entry.listener_released = true;
      assert.equal((await identity(packed.archive)).sha256, packed.sha256);
      if (entry.binary)
        assert.equal((await identity(entry.binary.path)).sha256, packed.host.sha256);
      stopped = true;
      for (const process of entry.os_processes ?? [])
        report.reclamation.push({
          pid: process.ProcessId,
          command: process.CommandLine,
          created_at: process.CreatedAt,
          reclaimed: true,
          graceful: Boolean(entry.graceful),
        });
      report.reclamation.push({
        pid: launcher.pid,
        command: `${launcher.command} ${launcher.args.join(' ')}`,
        reclaimed: true,
        graceful: Boolean(entry.graceful),
        exit: launcher.exit,
      });
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }
  try {
    await poll(
      async () => {
        signal?.throwIfAborted();
        if (processEntry.failure) throw processEntry.failure;
        if (launcher.exit) throw new Error('npx 就绪前退出，查看 npx-start.stderr.log');
        try {
          return (await api.http('/api/v2/health')).status === 'ok';
        } catch {
          return false;
        }
      },
      Boolean,
      'npx 真实宿主就绪',
      180000,
    );
    const cached = await cachedPackage(cache, packed);
    entry.package_root = cached.path;
    entry.binary = await identity(join(cached.path, 'runtime/win32-x64/apk-server.exe'));
    const processes = await ownedProcesses(root, report.hosts);
    const hosts = processes.filter(
      (item) => item.ExecutablePath?.toLowerCase() === entry.binary.path.toLowerCase(),
    );
    assert.equal(hosts.length, 1, '必须只有一个实际从本缓存运行的冻结宿主');
    entry.pid = hosts[0].ProcessId;
    entry.os_identity = hosts[0];
    entry.os_processes = processes;
    [webOwner] = await listenerOwners(port);
    [mcpOwner] = await listenerOwners(mcpPort);
    assert.ok(processes.some((item) => item.ProcessId === webOwner));
    assert.deepEqual(await listenerOwners(port), [webOwner]);
    assert.deepEqual(await listenerOwners(mcpPort), [webOwner]);
    assert.equal(mcpOwner, webOwner);
    await save(join(phaseRoot, 'cached-package.json'), cached);
    const index = await fetch(`${base}/`, { signal: AbortSignal.timeout(10000) });
    assert.equal(index.status, 200);
    const indexBytes = Buffer.from(await index.arrayBuffer());
    assert.equal(
      digest(indexBytes),
      packed.web.find((file) => file.path === 'index.html').sha256,
      '必须由新 npm 包提供实际 dist',
    );
    await save(join(phaseRoot, 'served-web.json'), {
      status: index.status,
      size: indexBytes.length,
      sha256: digest(indexBytes),
    });
    return { api, mcp, base, mcpBase, entry, stop, cache, cwd, env, prefix, phaseRoot, root };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      (report.cleanup_errors ??= []).push({ phase: phaseRoot, error: cleanup.stack });
    }
    throw error;
  }
}

// CLI 原样请求经记录代理转发给真实宿主，不伪造业务响应或绕过受信来源。
export async function runCli(host, args, report, signal) {
  let number = 0;
  const requests = [],
    tasks = new Set();
  const server = httpServer((incoming, outgoing) => {
    const task = (async () => {
      const record = {
        method: incoming.method,
        path: incoming.url,
        base: host.base,
        transport: 'npx-cli',
        started_at: new Date().toISOString(),
      };
      requests.push(record);
      report.requests.push(record);
      try {
        assert.ok(
          incoming.url.startsWith('/') && !incoming.url.startsWith('//'),
          'CLI 仅允许本站相对接口',
        );
        const chunks = [];
        let size = 0;
        for await (const chunk of incoming) {
          size += chunk.length;
          assert.ok(size <= 131072);
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        const response = await fetch(host.base + incoming.url, {
          method: incoming.method,
          headers: { 'content-type': 'application/json', origin: host.base },
          ...(body.length ? { body } : {}),
          signal: AbortSignal.timeout(20000),
        });
        const text = await response.text();
        record.status = response.status;
        record.log_id = response.headers.get('x-deviceforge-log-id');
        record.finished_at = new Date().toISOString();
        record.evidence = join(
          host.phaseRoot,
          'responses/cli',
          `http-${String(++number).padStart(5, '0')}.json`,
        );
        await save(record.evidence, {
          request: {
            method: incoming.method,
            path: incoming.url,
            ...(body.length ? { input: JSON.parse(body.toString('utf8')) } : {}),
          },
          status: response.status,
          log_id: record.log_id,
          body: text,
        });
        outgoing
          .writeHead(response.status, {
            'content-type': 'application/json',
            ...(record.log_id ? { 'x-deviceforge-log-id': record.log_id } : {}),
          })
          .end(text);
      } catch (error) {
        record.error = error.message;
        outgoing.writeHead(502).end(JSON.stringify({ error: 'CLI 证据转发失败' }));
      }
    })();
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  const record = { pid: process.pid, port, owner: '驱动内 CLI 请求记录器' };
  (report.recorders ??= []).push(record);
  try {
    signal?.throwIfAborted();
    const command = managed(
      process.execPath,
      [...host.prefix, ...args, '--api-url', `http://127.0.0.1:${port}`],
      {
        cwd: host.cwd,
        env: host.env,
        log: join(host.phaseRoot, 'npx-cli'),
        report,
        label: 'npx plugin dependencies scan',
      },
    );
    const text = await command.finish(90000),
      output = JSON.parse(text);
    assert.ok(requests.length > 0 && requests.every((request) => !request.error && request.log_id));
    return { output, requests, pid: command.entry.pid };
  } finally {
    server.closeAllConnections();
    await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
    await Promise.allSettled([...tasks]);
    await listenerReleased(port);
    record.closed_at = new Date().toISOString();
    record.listener_released = true;
  }
}

// 初始 CLI 用新依赖标识，先核其自动持久化结果，再独立复核 helper；不能借后一步修复前一步。
export async function initialCliCases({
  root,
  user,
  packed,
  fixtures,
  source,
  report,
  cache,
  signal,
}) {
  assert.deepEqual(packed.manifest.capabilities, ['plugin_dependencies_v1']);
  assert.ok(preparationHosts.has(packed.host.sha256));
  assert.deepEqual(
    await ownedProcesses(root, report.hosts),
    [],
    '初始 CLI 用例执行时不得保留 HTTP 宿主',
  );
  const cached = await cachedPackage(cache, packed),
    directory = join(root, 'initial-cli');
  await mkdir(directory);
  const port = await reservePort(),
    env = {
      ...npmEnvironment(cache, packed.config),
      ...Object.fromEntries(
        Object.entries(environment(directory, port, source.base, fixtures.envProgram)).filter(
          ([key]) => /^(APK_|DEVICEFORGE_|DF_DEPENDENCY_)/.test(key),
        ),
      ),
      DEVICEFORGE_USER_DIR: user,
    };
  for (const key of ['APK_DATA_DIR', 'APK_PLUGIN_DIR', 'APK_BROWSER_PLUGIN_DIR'])
    await mkdir(env[key], { recursive: true });
  const prefix = [packed.npx, '--yes', '--package', packed.archive, 'deviceforge'];
  report.initial_cli_cases = [];
  for (const name of ['environment', 'user']) {
    signal?.throwIfAborted();
    const template = fixtures.components[name],
      declaration = structuredClone(template.dependencies.dependencies[0]);
    declaration.id += '_initial';
    const fixture = component('server', `${template.target.id}_initial`, [declaration], {
      runtimeDependency: { id: declaration.id, entry: 'main' },
    });
    const archive = join(directory, `${name}.tgz`);
    await writeFile(archive, fixture.archive, { flag: 'wx' });
    const archiveIdentity = await identity(archive),
      offset = source.snapshot();
    const indexPath = join(user, 'plugin-dependencies/index', `server-${fixture.target.id}.json`);
    await assert.rejects(
      readFile(indexPath),
      { code: 'ENOENT' },
      '新标识不能复用先前已经就绪的目标状态',
    );
    const cli = managed(
      process.execPath,
      [...prefix, 'plugin', 'install-legacy', archive, '--data-dir', env.APK_DATA_DIR],
      {
        cwd: directory,
        env,
        log: join(directory, `${name}-cli-install`),
        report,
        label: `npx 初始组件安装 ${name}`,
      },
    );
    const output = await cli.finish(300000);
    assert.ok(output.includes(`插件 ${fixture.target.id}@1.0.0 安装完成`));
    const stderr = await readFile(join(directory, `${name}-cli-install.stderr.log`), 'utf8');
    assert.ok(
      !/本次未检测或下载|无法自动准备|依赖准备失败/.test(stderr),
      '初始安装不能仅部署后报告宿主待准备',
    );
    // 复核 helper 启动前，真实 CLI 自己就必须已完成发现、探测、选择和绑定。
    const initialIndex = JSON.parse(await readFile(indexPath, 'utf8'));
    const selected = initialIndex.selected[declaration.id],
      expectedSource = name === 'environment' ? 'environment' : 'local';
    assert.ok(selected, 'CLI 初始安装必须自己创建就绪选择，不能由随后复核补做');
    assert.equal(selected.origin, expectedSource);
    assert.equal(selected.version, process.versions.node);
    const expectedProgram = name === 'environment' ? fixtures.envProgram : fixtures.userProgram;
    assert.equal(await realpath(selected.entries.main), await realpath(expectedProgram));
    assert.equal((await identity(selected.entries.main)).sha256, fixtures.node.sha256);
    assert.ok(
      !initialIndex.observations?.[declaration.id] ||
        initialIndex.observations[declaration.id] === 'ready',
    );
    const deployment = join(env.APK_PLUGIN_DIR, fixture.target.id);
    const marker = JSON.parse(
      await readFile(join(deployment, '.deviceforge-runtime.json'), 'utf8'),
    );
    assert.deepEqual(marker, {
      format_version: 1,
      dependency: { id: declaration.id, entry: 'main' },
    });
    const bindingsRoot = join(user, 'plugin-dependencies/bindings/server', fixture.target.id);
    const bindingsFiles = (await tree(bindingsRoot)).filter((file) => file.path.endsWith('.json'));
    assert.ok(bindingsFiles.length > 0, 'CLI 初始安装必须已保存执行绑定');
    const binding = JSON.parse(
      await readFile(join(bindingsRoot, bindingsFiles.at(-1).path), 'utf8'),
    );
    assert.equal(
      await realpath(binding.tools[declaration.id].entries.main),
      await realpath(expectedProgram),
    );
    const helper = managed(
      join(cached.path, 'runtime/win32-x64/apk-server.exe'),
      ['--prepare-plugin-dependencies', 'server', fixture.target.id],
      {
        cwd: env.APK_DATA_DIR,
        env,
        log: join(directory, `${name}-helper-review`),
        report,
        label: `冻结宿主 helper 复核 ${name}`,
      },
    );
    const view = assertView(JSON.parse(await helper.finish(120000)), fixture.target);
    assert.equal(view.ready, true);
    assert.equal(view.dependencies.length, 1);
    assert.equal(view.dependencies[0].id, declaration.id);
    assert.equal(view.dependencies[0].status, 'ready');
    assert.equal(view.dependencies[0].source, expectedSource);
    assert.equal(source.snapshot(), offset, '初始 CLI 发现和 helper 复核均不得请求下载源');
    assert.deepEqual(await identity(archive), archiveIdentity);
    assert.deepEqual(await listenerOwners(port), [], '初始依赖准备命令结束后不得留下 HTTP 监听');
    await listenerReleased(port);
    assert.deepEqual(
      await ownedProcesses(root, report.hosts),
      [],
      '初始 CLI 和 helper 的进程必须全部结束',
    );
    const evidence = {
      name,
      target: fixture.target,
      dependency: declaration.id,
      archive: archiveIdentity,
      cli_pid: cli.entry.pid,
      helper_review_pid: helper.entry.pid,
      cli_output: output,
      cli_initial_index: initialIndex,
      cli_initial_binding: binding,
      marker,
      expected_program: await identity(expectedProgram),
      review: view,
      source_requests: 0,
      listener_released: true,
      plugin_business_execution: false,
    };
    report.initial_cli_cases.push(evidence);
    await save(join(directory, `${name}.json`), evidence);
    check(
      report,
      `初始 CLI TGZ 安装已自动${name === 'environment' ? '从环境' : '从用户目录'}发现并持久化就绪绑定，原 helper 复核 ready 且零下载`,
      {
        target: fixture.target,
        cli_pid: cli.entry.pid,
        helper_review_pid: helper.entry.pid,
        source_requests: 0,
      },
    );
  }
}
