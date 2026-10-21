import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  help,
  parseOptions as rawParseOptions,
  readApiToken,
  readMarketplaceConfig,
  DEFAULT_MARKETPLACE_URL,
} from '../src/options.mjs';
import { networkConfig, authority } from '../src/network.mjs';
import { validateRegistrySource } from '../src/plugin-package.mjs';
import { packagePath } from '../src/paths.mjs';

// 旧参数用例共用独占实例，避免真实用户根配置影响默认值断言。
const testDirectory = mkdtempSync(join(tmpdir(), 'deviceforge-options-'));
function parseOptions(args, environment = {}) {
  return rawParseOptions(args, { DEVICEFORGE_DATA_DIR: testDirectory, ...environment });
}

after(() => {
  const target = realpathSync(testDirectory);
  const base = realpathSync(tmpdir());
  const offset = relative(base, target);
  if (
    !isAbsolute(target) ||
    !offset ||
    isAbsolute(offset) ||
    offset === '..' ||
    offset.startsWith(`..${sep}`) ||
    !basename(target).startsWith('deviceforge-options-')
  )
    throw new Error('参数测试清理路径越界');
  rmSync(target, { recursive: true, force: true });
});

test('默认局域网、分离 MCP 端口，并允许配置 IPv4/IPv6', () => {
  const defaults = parseOptions(['start'], {});
  assert.equal(defaults.ip, '0.0.0.0');
  assert.equal(defaults.port, 7030);
  assert.equal(defaults.mcpPort, 7032);
  assert.deepEqual(defaults.marketplaceSources, [
    { name: '本地默认市场', url: DEFAULT_MARKETPLACE_URL },
  ]);
  const custom = parseOptions(['start', '--ip', '::1', '--port', '8080', '--mcp-port', '8081'], {});
  assert.equal(custom.ip, '::1');
  assert.equal(authority(custom.ip, custom.port), '[::1]:8080');
  for (const args of [
    ['start', '--port', '0'],
    ['start', '--port', '7032'],
    ['start', '--ip', 'example.com'],
    ['start', '--port', '1', '--port', '2'],
    ['plugin', 'list', '--mcp-port', '1'],
  ])
    assert.throws(() => parseOptions(args, {}));
});

test('市场来源支持独立配置并拒绝不安全地址', () => {
  const file = fileURLToPath(new URL('./fixtures/marketplace.json', import.meta.url));
  assert.deepEqual(readMarketplaceConfig(file), [
    { name: '团队市场', url: 'https://market.example.com' },
    { name: '本地市场', url: 'http://127.0.0.1:7040' },
  ]);
  assert.throws(() => readMarketplaceConfigFromValue(), /市场配置读取失败/);
  assert.deepEqual(
    parseOptions(['start', '--marketplace-config', file], {}).marketplaceSources,
    readMarketplaceConfig(file),
  );
});

test('市场地址可直接覆盖且与来源文件互斥', () => {
  const custom = parseOptions(['start', '--marketplace-url', 'http://192.168.1.8:7040/'], {});
  assert.deepEqual(custom.marketplaceSources, [
    { name: '自定义市场', url: 'http://192.168.1.8:7040' },
  ]);
  assert.equal(custom.marketplaceConfigPath, null);
  for (const url of [
    'invalid',
    'file:///market',
    'https://user:password@example.com',
    'https://example.com/?key=value',
    'https://example.com/#fragment',
  ]) {
    assert.throws(() => parseOptions(['start', '--marketplace-url', url], {}), /市场地址/);
  }
  const file = fileURLToPath(new URL('./fixtures/marketplace.json', import.meta.url));
  for (const args of [
    ['--marketplace-url', 'http://127.0.0.1:7040', '--marketplace-config', file],
    ['--marketplace-config', file, '--marketplace-url', 'http://127.0.0.1:7040'],
  ]) {
    assert.throws(() => parseOptions(['start', ...args], {}), /不能同时使用/);
  }
  assert.throws(
    () => parseOptions(['plugin', 'list', '--marketplace-url', 'http://127.0.0.1:7040'], {}),
    /只用于启动命令/,
  );
});

function readMarketplaceConfigFromValue() {
  return readMarketplaceConfig('missing-marketplace-config.json');
}
test('本地和局域网默认免令牌，显式空令牌同样保持免鉴权', () => {
  for (const environment of [{}, { APK_API_TOKEN: '' }]) {
    assert.equal(readApiToken(environment), '');
    for (const ip of ['127.0.0.1', '::1', '0.0.0.0', '192.168.1.8']) {
      assert.equal(parseOptions(['start', '--ip', ip], environment).ip, ip);
    }
  }
  assert.match(help, /本地和局域网默认免鉴权/);
  assert.match(help, /不自动生成随机令牌/);
});
test('可选令牌原样保留且拒绝空白，参数结果不携带令牌', () => {
  const token = 'optional-token-regression';
  const environment = { APK_API_TOKEN: token };
  assert.equal(readApiToken(environment), token);
  const options = parseOptions(['start'], environment);
  assert.ok(!JSON.stringify(options).includes(token));
  for (const token of [' ', '\t', '\n', 'token with-space', ' token', 'token\r']) {
    assert.throws(() => readApiToken({ APK_API_TOKEN: token }), /APK_API_TOKEN/);
    assert.throws(() => parseOptions(['start'], { APK_API_TOKEN: token }), /APK_API_TOKEN/);
  }
});
test('网络 Host/Origin 列表由监听地址与网卡生成，DNS 名称不自动放行', () => {
  const config = networkConfig('0.0.0.0', 7030, 7032, {
    ethernet: [{ address: '192.168.1.8', family: 'IPv4', internal: false }],
  });
  assert.ok(config.hosts.includes('192.168.1.8:7030'));
  assert.ok(config.hosts.includes('192.168.1.8:7032'));
  assert.ok(config.origins.includes('http://192.168.1.8:7030'));
  assert.equal(config.external, true);
  assert.deepEqual(networkConfig('192.168.1.8', 1, 2, {}).hosts, [
    '192.168.1.8:1',
    '192.168.1.8:2',
  ]);
});
test('在线来源与包内入口拒绝 URL、shell、绝对和越界路径', () => {
  assert.equal(validateRegistrySource('@example/plugin@1.2.3'), '@example/plugin@1.2.3');
  for (const value of [
    'https://example.com/file',
    'git+https://example.com/repo',
    '--unsafe',
    'a;run',
    'a$(run)',
  ])
    assert.throws(() => validateRegistrySource(value));
  for (const value of ['../escape', 'C:/bin', '/bin', 'bin\\plugin', 'bin/../plugin'])
    assert.throws(() => packagePath(process.cwd(), value));
});
