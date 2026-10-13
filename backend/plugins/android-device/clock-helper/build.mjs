import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('./src/', import.meta.url));
const defaultOutput = fileURLToPath(new URL('./build/', import.meta.url));
const outputLimit = 1024 * 1024;
const commandTimeoutMs = 120000;
const buildTimeoutMs = 300000;
const help = [
  '设备时钟助手构建（Node 22 以上）',
  '用法：node build.mjs [--sdk SDK目录] [--jdk JDK目录] [--platform android-XX] [--build-tools 版本] [--out 输出目录]',
  '默认 SDK 来自 ANDROID_SDK_ROOT，JDK 来自 JAVA_HOME。',
  '未指定 platform/build-tools 时选择已安装的最高稳定数字版本；最低 Android API 为 21。',
  '输出固定为 profile-clock.jar；仅包含用于 app_process 的 classes.dex，不自动部署到设备。',
].join('\n') + '\n';

function argumentsFrom(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === '--help' || name === '-h') return null;
    if (!['--sdk', '--jdk', '--platform', '--build-tools', '--out'].includes(name) || Object.hasOwn(options, name)) throw new Error('参数未知或重复：' + String(name));
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error('参数缺少值：' + name);
    options[name] = value; index += 1;
  }
  return options;
}
async function directory(path, label) {
  if (!path) throw new Error(label + '未配置，请通过 CLI 或对应环境变量提供');
  const actual = await realpath(resolve(path));
  if (!(await stat(actual)).isDirectory()) throw new Error(label + '必须为目录');
  return actual;
}
async function file(path, label) {
  if (!(await stat(path)).isFile()) throw new Error(label + '必须为文件');
  return path;
}
async function installed(root, pattern) {
  return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => entry.name);
}
function greatest(names, prefix = '') {
  if (names.length === 0) throw new Error('没有符合要求的已安装 Android SDK 版本');
  return [...names].sort((left, right) => {
    const a = left.slice(prefix.length).split('.').map(Number); const b = right.slice(prefix.length).split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const difference = (a[index] ?? 0) - (b[index] ?? 0); if (difference !== 0) return difference;
    }
    return left.localeCompare(right);
  }).at(-1);
}
async function configuration(options) {
  const sdk = await directory(options['--sdk'] ?? process.env.ANDROID_SDK_ROOT, 'Android SDK');
  const jdk = await directory(options['--jdk'] ?? process.env.JAVA_HOME, 'JDK');
  const platformValue = options['--platform'];
  const platform = platformValue === undefined ? greatest(await installed(join(sdk, 'platforms'), /^android-[0-9]+$/), 'android-')
    : /^android-[0-9]+$/.test(platformValue) ? platformValue : /^[0-9]+$/.test(platformValue) ? 'android-' + platformValue : null;
  if (platform === null || Number(platform.slice(8)) < 21) throw new Error('platform 须为已安装且 API 不低于 21 的 android-XX 或数字');
  const buildTools = options['--build-tools'] ?? greatest(await installed(join(sdk, 'build-tools'), /^[0-9]+\.[0-9]+\.[0-9]+$/));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(buildTools)) throw new Error('build-tools 须为精确的稳定数字版本，例如 35.0.0');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const tools = {};
  for (const name of ['java', 'javac', 'jar']) tools[name] = await file(join(jdk, 'bin', name + suffix), 'JDK ' + name);
  return { ...tools, platform, buildTools, androidJar: await file(join(sdk, 'platforms', platform, 'android.jar'), '平台 android.jar'),
    d8Jar: await file(join(sdk, 'build-tools', buildTools, 'lib', 'd8.jar'), 'D8 lib/d8.jar'), output: resolve(options['--out'] ?? defaultOutput) };
}
// 固定参数数组执行，不使用 shell；输出超量或超时杀死当前拥有的直接工具并等退出。
async function runCommand(executable, args, deadline, signal) {
  const remaining = Math.min(commandTimeoutMs, deadline - Date.now());
  if (remaining <= 0 || signal.aborted) throw new Error('构建已取消或超过总截止点');
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = []; let length = 0; let failure = null;
    const stop = (message) => { if (failure === null) failure = new Error(message); child.kill('SIGKILL'); };
    const abort = () => stop('构建已取消');
    const timer = setTimeout(() => stop(basename(executable) + '超过执行期限'), remaining);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const collect = (bytes) => {
      if (failure !== null) return;
      length += bytes.length;
      if (length > outputLimit) { stop(basename(executable) + '输出超过 1 MiB'); return; }
      output.push(bytes);
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', (error) => { if (failure === null) failure = error; });
    child.once('close', (code, termination) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      const text = Buffer.concat(output).toString('utf8');
      if (text.length > 0) process.stderr.write(text.endsWith('\n') ? text : text + '\n');
      if (failure !== null) reject(failure);
      else if (code !== 0) reject(new Error(basename(executable) + '退出失败：' + String(code ?? termination)));
      else accept();
    });
  });
}

async function collectFiles(root, extension, maximum, maximumBytes, depth = 0) {
  if (depth > 16) throw new Error('源码或中间产物目录嵌套过深');
  const paths = []; let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('源码或中间产物不得包含符号链接');
    if (entry.isDirectory()) paths.push(...await collectFiles(path, extension, maximum, maximumBytes, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(extension)) paths.push(path);
    if (paths.length > maximum) throw new Error('源码或中间产物数量超限');
  }
  for (const path of paths) {
    bytes += (await stat(path)).size;
    if (bytes > maximumBytes) throw new Error('源码或中间产物字节数超限');
  }
  return paths.sort();
}
async function checkSize(path, maximum, label) {
  const size = (await stat(path)).size;
  if (size < 1 || size > maximum) throw new Error(label + '为空或超过字节上限');
}
async function removeOwnedWork(work, temporaryRoot) {
  const actual = await realpath(work);
  if (resolve(actual) !== resolve(work) || dirname(actual) !== temporaryRoot || !basename(actual).startsWith('deviceforge-clock-helper-')) throw new Error('临时目录归属核对失败，未删除目录');
  await rm(actual, { recursive: true, force: true });
}
async function build(config, signal) {
  const deadline = Date.now() + buildTimeoutMs;
  const sources = await collectFiles(sourceRoot, '.java', 16, 1024 * 1024);
  if (sources.length === 0) throw new Error('设备时钟助手没有 Java 源码');
  const temporaryRoot = await realpath(tmpdir());
  const work = await mkdtemp(join(temporaryRoot, 'deviceforge-clock-helper-'));
  let staging = null;
  try {
    const classes = join(work, 'classes'); const dex = join(work, 'dex'); const jar = join(work, 'profile-clock.jar');
    await mkdir(classes); await mkdir(dex);
    await runCommand(config.javac, ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-bootclasspath', config.androidJar, '-d', classes, ...sources], deadline, signal);
    const classFiles = await collectFiles(classes, '.class', 64, 1024 * 1024);
    if (classFiles.length === 0) throw new Error('javac 未产生 class 文件');
    await runCommand(config.java, ['-cp', config.d8Jar, 'com.android.tools.r8.D8', '--release', '--min-api', '21', '--lib', config.androidJar, '--output', dex, ...classFiles], deadline, signal);
    const dexFiles = await readdir(dex);
    if (dexFiles.length !== 1 || dexFiles[0] !== 'classes.dex') throw new Error('D8 必须只产生一个 classes.dex');
    await checkSize(join(dex, 'classes.dex'), 1024 * 1024, 'classes.dex');
    await runCommand(config.jar, ['cfM', jar, '-C', dex, 'classes.dex'], deadline, signal);
    await checkSize(jar, 2 * 1024 * 1024, 'profile-clock.jar');
    if (signal.aborted || Date.now() >= deadline) throw new Error('构建已取消或超过总截止点');
    await mkdir(config.output, { recursive: true });
    const output = await realpath(config.output); const target = join(output, 'profile-clock.jar');
    const existing = await lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('输出目标必须为普通文件或尚不存在');
    staging = join(output, '.profile-clock-' + basename(work) + '.jar');
    await copyFile(jar, staging, constants.COPYFILE_EXCL);
    if (signal.aborted || Date.now() >= deadline) throw new Error('构建已取消或超过总截止点');
    await rename(staging, target); staging = null;
    process.stdout.write('设备时钟助手已构建：' + target + '\n');
    process.stdout.write('Android ' + config.platform + '，build-tools ' + config.buildTools + '，D8 min-api 21\n');
  } finally {
    const cleanup = await Promise.allSettled([staging === null ? Promise.resolve() : rm(staging, { force: true }), removeOwnedWork(work, temporaryRoot)]);
    const failures = cleanup.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason);
    if (failures.length > 0) throw new AggregateError(failures, '构建临时资源清理失败');
  }
}
async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options === null) { process.stdout.write(help); return; }
  const config = await configuration(options);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try { await build(config, controller.signal); }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
try { await main(); }
catch (error) {
  process.stderr.write('设备时钟助手构建失败：' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
