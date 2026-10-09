import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

// 只生成小型、自包含 npm TGZ；不调用 npm/Cargo，不触发安装脚本或下载依赖。
function header(path, size) {
  assert.ok(Buffer.byteLength(path) < 100, '测试 TAR 条目名必须容纳在标准头中');
  const block = Buffer.alloc(512);
  block.write(path, 0, 100, 'utf8');
  for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, size], [136, 12, 0]]) {
    block.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  }
  block.fill(32, 148, 156);
  block.write('0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

export function npmTgz(files) {
  assert.ok(files.length > 0 && files.length <= 32, '夹具条目数必须有界');
  const blocks = [];
  for (const { path, bytes } of files) {
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    assert.ok(content.length <= 64 * 1024, '夹具单文件必须有界');
    blocks.push(header(`package/${path}`, content.length), content,
      Buffer.alloc((512 - content.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function descriptor(kind, id, runtime, entry) {
  return { name: `deviceforge-online-smoke-${id}`, version: '1.0.0', type: 'module',
    scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('INSTALL_SCRIPT_RAN','不应执行安装脚本')\"" },
    deviceforge: { kind, manifest: 'plugin.json', entrypoints: { any: { runtime, path: entry } } } };
}

export function serverFixture(protocol) {
  assert.ok([1, 2].includes(protocol));
  const id = `online_echo_v${protocol}`;
  const manifest = { id, version: '1.0.0', protocol_version: protocol, args: [],
    operations: [{ name: 'echo', title: `在线安装协议 ${protocol} 回显`,
      input_schema: { type: 'object', properties: { message: { type: 'string' }, value: { type: 'integer' } },
        required: ['message', 'value'], additionalProperties: false } }] };
  const source = `import { readFileSync, writeFileSync } from 'node:fs';
// 标记只写入本次插件部署目录，用于证明安装阶段没有执行入口。
const request = JSON.parse(readFileSync(0, 'utf8'));
if (request.protocol_version !== ${protocol} || request.operation !== 'echo') throw new Error('回显夹具协议无效');
if (process.env.APK_API_TOKEN) throw new Error('访问令牌不应传入插件');
writeFileSync(new URL('../ENTRY_RAN', import.meta.url), String(process.pid));
process.stdout.write(JSON.stringify({ protocol_version: ${protocol}, request_id: request.request_id, result: request.input }));
`;
  const files = [
    { path: 'package.json', bytes: json(descriptor('server', id, 'node', 'dist/index.mjs')) },
    { path: 'plugin.json', bytes: json(manifest) },
    { path: 'dist/index.mjs', bytes: source },
  ];
  return { id, kind: 'server', protocol, manifest, files, archive: npmTgz(files) };
}

export function browserFixture() {
  const id = 'online_browser_demo';
  const manifest = { id, version: '1.0.0', api_version: 2 };
  const module = Buffer.from(`// 在线安装静态模块夹具；本轮只核对资源，不在浏览器挂载界面。\r\nexport const settingsUrl = new URL('./settings.json', import.meta.url);\r\nexport default { id: '${id}', version: '1.0.0', apiVersion: 2, panels: [] };\r\n`, 'utf8');
  const settings = Buffer.from('{\r\n  "标题": "在线包相对资源",\r\n  "enabled": true,\r\n  "values": [1, 2, 3]\r\n}\r\n', 'utf8');
  const files = [
    { path: 'package.json', bytes: json(descriptor('browser', id, 'browser', 'dist/index.js')) },
    { path: 'plugin.json', bytes: json(manifest) },
    { path: 'dist/index.js', bytes: module },
    { path: 'dist/settings.json', bytes: settings },
  ];
  return { id, kind: 'browser', manifest, files, module, settings, archive: npmTgz(files) };
}

export function failedFixtures() {
  const server = serverFixture(1);
  const browser = browserFixture();
  return [
    { label: '服务器清单 JSON 损坏', kind: 'server', archive: npmTgz(server.files.map((file) =>
      file.path === 'plugin.json' ? { ...file, bytes: '{' } : file)) },
    { label: '服务器入口缺失', kind: 'server', status: 404, errorCode: 'not_found',
      archive: npmTgz(server.files.filter((file) => file.path !== 'dist/index.mjs')) },
    { label: '浏览器 API 版本不兼容', kind: 'browser', archive: npmTgz(browser.files.map((file) =>
      file.path === 'plugin.json' ? { ...file, bytes: json({ ...browser.manifest, api_version: 999 }) } : file)) },
    { label: '浏览器包传入服务器安装接口', kind: 'server', archive: browser.archive },
    { label: '归档重复路径', kind: 'browser', archive: npmTgz([...browser.files, browser.files[1]]) },
    { label: '归档路径越界', kind: 'server', archive: npmTgz([...server.files, { path: '../ESCAPED_FILE', bytes: '不得写到部署范围外' }]) },
    { label: 'GZIP 归档损坏', kind: 'browser', archive: Buffer.from('不是有效 GZIP', 'utf8') },
  ];
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 快照涵盖隐藏暂存与锁文件；安装失败后应与请求前完全相同。
export async function deploymentSnapshot(root) {
  const deadline = performance.now() + 5000;
  while (true) {
    try { return await readDeploymentSnapshot(root); }
    catch (error) {
      const location = typeof error.path === 'string' ? relative(root, error.path) : '';
      const temporary = location && !location.startsWith('..') && location.split(/[\\/]/)
        .some((part) => part.startsWith('.package-') || part.startsWith('.removed-'));
      // Windows 删除中的目录可能短暂返回 EPERM；必须重读完整快照，不跳过该目录。
      if (!(error.code === 'ENOENT' || (error.code === 'EPERM' && temporary)) || performance.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function readDeploymentSnapshot(root) {
  const records = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const location = relative(root, path).split('\\').join('/');
      assert.ok(!entry.isSymbolicLink(), '测试部署目录不得出现符号链接');
      if (entry.isDirectory()) { records.push({ path: location, kind: 'directory' }); await visit(path); }
      else {
        const metadata = await lstat(path);
        assert.ok(metadata.isFile(), '测试部署目录仅允许普通文件和目录');
        // 零字节部署锁无需读内容，避免 Windows 文件锁影响无残留快照。
        records.push({ path: location, kind: 'file', size: metadata.size,
          sha256: sha256(metadata.size === 0 ? Buffer.alloc(0) : await readFile(path)) });
      }
    }
  }
  await visit(root);
  return records.sort((left, right) => left.path.localeCompare(right.path));
}
