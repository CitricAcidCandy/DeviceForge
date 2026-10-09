import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions } from '../src/options.mjs';
import { networkConfig, authority } from '../src/network.mjs';
import { validateRegistrySource } from '../src/plugin-package.mjs';
import { packagePath } from '../src/paths.mjs';

test('默认局域网、分离 MCP 端口，并允许配置 IPv4/IPv6', () => {
  const defaults = parseOptions(['start'], {});
  assert.equal(defaults.ip, '0.0.0.0'); assert.equal(defaults.port, 7030); assert.equal(defaults.mcpPort, 7032);
  const custom = parseOptions(['start','--ip','::1','--port','8080','--mcp-port','8081'], {});
  assert.equal(custom.ip, '::1'); assert.equal(authority(custom.ip, custom.port), '[::1]:8080');
  for (const args of [['start','--port','0'],['start','--port','7032'],['start','--ip','example.com'],['start','--port','1','--port','2'],['plugin','list','--mcp-port','1']]) assert.throws(() => parseOptions(args, {}));
});
test('网络 Host/Origin 列表由监听地址与网卡生成，DNS 名称不自动放行', () => {
  const config = networkConfig('0.0.0.0', 7030, 7032, { ethernet: [{ address:'192.168.1.8', family:'IPv4', internal:false }] });
  assert.ok(config.hosts.includes('192.168.1.8:7030')); assert.ok(config.hosts.includes('192.168.1.8:7032'));
  assert.ok(config.origins.includes('http://192.168.1.8:7030')); assert.equal(config.external, true);
  assert.deepEqual(networkConfig('192.168.1.8', 1, 2, {}).hosts, ['192.168.1.8:1','192.168.1.8:2']);
});
test('在线来源与包内入口拒绝 URL、shell、绝对和越界路径', () => {
  assert.equal(validateRegistrySource('@example/plugin@1.2.3'), '@example/plugin@1.2.3');
  for (const value of ['https://example.com/file','git+https://example.com/repo','--unsafe','a;run','a$(run)']) assert.throws(() => validateRegistrySource(value));
  for (const value of ['../escape','C:/bin','/bin','bin\\plugin','bin/../plugin']) assert.throws(() => packagePath(process.cwd(), value));
});
