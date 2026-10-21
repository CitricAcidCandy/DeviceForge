import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  importRootConfiguration,
  initializeRootConfiguration,
  readRootConfiguration,
  readRootConfigurationFile,
  rootConfigurationPath,
} from '../src/root-config.mjs';
import { DEFAULT_MARKETPLACE_URL, parseOptions } from '../src/options.mjs';

const prefix = 'deviceforge-root-config-';
const executable = fileURLToPath(new URL('../bin/deviceforge.mjs', import.meta.url));
const defaults = {
  format_version: 1,
  server: { ip: '0.0.0.0', port: 7030, mcp_port: 7032 },
  marketplace: { sources: [{ name: '本地默认市场', url: DEFAULT_MARKETPLACE_URL }] },
};
const configured = {
  format_version: 1,
  server: { ip: '127.0.0.1', port: 17030, mcp_port: 17032 },
  marketplace: { sources: [{ name: '团队市场', url: 'http://127.0.0.1:17040' }] },
};

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    // 只回收本次 mkdtemp 创建且仍位于系统临时目录中的绝对路径。
    const target = await realpath(directory);
    const base = await realpath(tmpdir());
    const offset = relative(base, target);
    if (
      !isAbsolute(target) ||
      !offset ||
      isAbsolute(offset) ||
      offset === '..' ||
      offset.startsWith(`..${sep}`) ||
      !basename(target).startsWith(prefix)
    )
      throw new Error('根配置测试清理路径越界');
    await rm(target, { recursive: true, force: true });
  }
}

async function fixture(directory, name, value) {
  const path = join(directory, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return path;
}

function cli(args, directory, cwd = directory) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/.test(key)),
  );
  return spawnSync(process.execPath, [executable, ...args, '--data-dir', directory], {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
}

test('根配置缺失时返回默认值，读取与参数解析均不创建配置文件', async () => {
  await temporary(async (directory) => {
    assert.deepEqual(readRootConfiguration(directory), defaults);
    const options = parseOptions(['start', '--data-dir', directory], {});
    assert.equal(options.ip, defaults.server.ip);
    assert.equal(options.port, defaults.server.port);
    assert.equal(options.mcpPort, defaults.server.mcp_port);
    assert.deepEqual(options.marketplaceSources, defaults.marketplace.sources);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('两个实例目录分别保留配置，导入其中一个不会改变另一实例', async () => {
  await temporary(async (directory) => {
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    await initializeRootConfiguration(first);
    await initializeRootConfiguration(second);
    const retained = await readFile(rootConfigurationPath(second));
    const source = await fixture(directory, 'source.json', configured);
    await importRootConfiguration(first, source);
    assert.deepEqual(readRootConfiguration(first), configured);
    assert.deepEqual(readRootConfiguration(second), defaults);
    assert.deepEqual(await readFile(rootConfigurationPath(second)), retained);
  });
});

test('数据目录优先级为启动参数、环境变量、用户目录，默认路径查询不读写用户配置', async () => {
  await temporary(async (directory) => {
    const explicit = join(directory, 'explicit');
    const environment = join(directory, 'environment');
    assert.equal(
      parseOptions(['config', 'path', '--data-dir', explicit], {
        DEVICEFORGE_DATA_DIR: environment,
      }).dataDirectory,
      explicit,
    );
    assert.equal(
      parseOptions(['config', 'path'], { DEVICEFORGE_DATA_DIR: environment }).dataDirectory,
      environment,
    );
    assert.equal(
      parseOptions(['config', 'path'], {}).dataDirectory,
      resolve(homedir(), '.deviceforge'),
    );
    assert.deepEqual(await readdir(directory), []);
  });
});

test('切换工作目录后仍读取指定的绝对实例目录，不借用当前目录的配置', async () => {
  await temporary(async (directory) => {
    const data = join(directory, 'data');
    const other = join(directory, 'other');
    await mkdir(data);
    await mkdir(other);
    await fixture(data, 'config.json', configured);
    await fixture(other, 'config.json', {
      ...defaults,
      server: { ...defaults.server, port: 27030 },
    });
    const previous = process.cwd();
    try {
      process.chdir(other);
      const options = parseOptions(['start', '--data-dir', data], {});
      assert.equal(options.dataDirectory, data);
      assert.equal(options.port, configured.server.port);
      assert.deepEqual(readRootConfiguration(data), configured);
      assert.equal(rootConfigurationPath(data), join(data, 'config.json'));
    } finally {
      process.chdir(previous);
    }
  });
});

test('已保存启动偏好被读取，命令行覆盖仅作用于本次解析且不改写根配置', async () => {
  await temporary(async (directory) => {
    await fixture(directory, 'config.json', configured);
    const original = await readFile(rootConfigurationPath(directory));
    const saved = parseOptions(['start', '--data-dir', directory], {});
    assert.equal(saved.ip, configured.server.ip);
    assert.equal(saved.port, configured.server.port);
    assert.equal(saved.mcpPort, configured.server.mcp_port);
    assert.deepEqual(saved.marketplaceSources, configured.marketplace.sources);
    const overridden = parseOptions(
      [
        'start',
        '--ip',
        '::1',
        '--port',
        '18030',
        '--mcp-port',
        '18032',
        '--marketplace-url',
        'http://127.0.0.1:18040/',
        '--data-dir',
        directory,
      ],
      {},
    );
    assert.equal(overridden.ip, '::1');
    assert.equal(overridden.port, 18030);
    assert.equal(overridden.mcpPort, 18032);
    assert.deepEqual(overridden.marketplaceSources, [
      { name: '自定义市场', url: 'http://127.0.0.1:18040' },
    ]);
    assert.deepEqual(await readFile(rootConfigurationPath(directory)), original);
  });
});

test('首次初始化只保存默认配置，不持久化随后使用的临时启动覆盖', async () => {
  await temporary(async (directory) => {
    const overridden = parseOptions(['start', '--port', '19030', '--data-dir', directory], {});
    assert.equal(overridden.port, 19030);
    assert.equal(await initializeRootConfiguration(directory), rootConfigurationPath(directory));
    assert.deepEqual(readRootConfiguration(directory), defaults);
    const original = await readFile(rootConfigurationPath(directory));
    await initializeRootConfiguration(directory);
    assert.deepEqual(await readFile(rootConfigurationPath(directory)), original);
    assert.deepEqual(await readdir(directory), ['config.json']);
  });
});

test('初始化不覆盖已有配置，缺省服务与市场字段按默认值补齐', async () => {
  await temporary(async (directory) => {
    const text = `${JSON.stringify({ format_version: 1 }, null, 4)}\n\n`;
    await fixture(directory, 'config.json', text);
    await initializeRootConfiguration(directory);
    assert.equal(await readFile(rootConfigurationPath(directory), 'utf8'), text);
    assert.deepEqual(readRootConfiguration(directory), defaults);
    await fixture(directory, 'config.json', { format_version: 1, server: { port: 20030 } });
    assert.deepEqual(readRootConfiguration(directory), {
      ...defaults,
      server: { ...defaults.server, port: 20030 },
    });
  });
});

test('导入只替换根配置，完整保留插件、工具和来源文件', async () => {
  await temporary(async (directory) => {
    const data = join(directory, 'instance');
    const plugin = join(data, 'plugins', 'third-party', 'sentinel.txt');
    const tool = join(data, 'tools', 'third-party', 'sentinel.txt');
    await mkdir(join(data, 'plugins', 'third-party'), { recursive: true });
    await mkdir(join(data, 'tools', 'third-party'), { recursive: true });
    await writeFile(plugin, '第三方插件原件\n', 'utf8');
    await writeFile(tool, '第三方工具原件\n', 'utf8');
    await initializeRootConfiguration(data);
    const source = await fixture(directory, 'source.json', configured);
    const retained = await Promise.all([plugin, tool, source].map((path) => readFile(path)));
    assert.equal(await importRootConfiguration(data, source), rootConfigurationPath(data));
    assert.deepEqual(readRootConfiguration(data), configured);
    assert.deepEqual(
      await Promise.all([plugin, tool, source].map((path) => readFile(path))),
      retained,
    );
    assert.deepEqual((await readdir(data)).sort(), ['config.json', 'plugins', 'tools']);
  });
});

test('非法导入整批拒绝，旧配置保持原字节且不产生锁或暂存残留', async (context) => {
  const invalid = [
    ['损坏 JSON', '{"format_version":1,'],
    ['格式版本缺失', {}],
    ['格式版本不兼容', { format_version: 2 }],
    ['顶层数组', []],
    ['服务未知字段', { format_version: 1, server: { address: '127.0.0.1' } }],
    ['市场未知字段', { format_version: 1, marketplace: { providers: [] } }],
    ['非整数端口', { format_version: 1, server: { port: '7030' } }],
    ['端口越界', { format_version: 1, server: { port: 65536 } }],
    ['重复端口', { format_version: 1, server: { port: 7032 } }],
    ['非 IP 监听地址', { format_version: 1, server: { ip: 'example.com' } }],
    ['顶层令牌', { format_version: 1, APK_API_TOKEN: 'synthetic-secret-marker' }],
    ['服务令牌', { format_version: 1, server: { token: 'synthetic-secret-marker' } }],
    [
      '带凭据市场地址',
      {
        format_version: 1,
        marketplace: {
          sources: [{ name: '测试来源', url: 'https://user:synthetic-secret-marker@example.com' }],
        },
      },
    ],
  ];
  await temporary(async (directory) => {
    const data = join(directory, 'instance');
    await initializeRootConfiguration(data);
    const original = await readFile(rootConfigurationPath(data));
    for (const [name, value] of invalid) {
      await context.test(name, async () => {
        const source = await fixture(directory, 'invalid.json', value);
        await assert.rejects(importRootConfiguration(data, source), (error) => {
          assert.ok(!error.message.includes('synthetic-secret-marker'));
          assert.ok(!error.message.includes('"format_version"'));
          return true;
        });
        assert.deepEqual(await readFile(rootConfigurationPath(data)), original);
        assert.deepEqual(await readdir(data), ['config.json']);
      });
    }
  });
});

test('64 KiB 按真实文件字节限制，边界内可读，超限导入保留原配置', async () => {
  await temporary(async (directory) => {
    const data = join(directory, 'instance');
    await initializeRootConfiguration(data);
    const original = await readFile(rootConfigurationPath(data));
    const json = JSON.stringify(configured);
    const exact = `${json}${' '.repeat(65536 - Buffer.byteLength(json))}`;
    assert.equal(Buffer.byteLength(exact), 65536);
    const source = await fixture(directory, 'limit.json', exact);
    assert.deepEqual(readRootConfigurationFile(source), configured);
    await writeFile(source, `${exact} `, 'utf8');
    assert.throws(() => readRootConfigurationFile(source), /64 KiB/);
    await assert.rejects(importRootConfiguration(data, source), /64 KiB/);
    assert.deepEqual(await readFile(rootConfigurationPath(data)), original);
    assert.deepEqual(await readdir(data), ['config.json']);
  });
});

test('UTF-8 BOM 配置可读取并导入，配置内容保持一致', async () => {
  await temporary(async (directory) => {
    const data = join(directory, 'instance');
    const source = await fixture(directory, 'bom.json', `\uFEFF${JSON.stringify(configured)}`);
    assert.deepEqual(readRootConfigurationFile(source), configured);
    await importRootConfiguration(data, source);
    assert.deepEqual(readRootConfiguration(data), configured);
    assert.deepEqual(JSON.parse(await readFile(rootConfigurationPath(data), 'utf8')), configured);
  });
});

test('导入遇到占用锁时明确失败，原配置与原锁内容均保留', async () => {
  await temporary(async (directory) => {
    const data = join(directory, 'instance');
    await initializeRootConfiguration(data);
    const original = await readFile(rootConfigurationPath(data));
    const lock = `${rootConfigurationPath(data)}.lock`;
    await mkdir(lock);
    const owner = await fixture(lock, 'owner.txt', '其他写入者占用\n');
    const source = await fixture(directory, 'source.json', configured);
    await assert.rejects(importRootConfiguration(data, source), /正在写入|锁/);
    assert.deepEqual(await readFile(rootConfigurationPath(data)), original);
    assert.equal(await readFile(owner, 'utf8'), '其他写入者占用\n');
    assert.deepEqual(await readdir(lock), ['owner.txt']);
  });
});

test('首次初始化遇到占用锁时不写配置，也不清理其他写入者的锁', async () => {
  await temporary(async (directory) => {
    const lock = `${rootConfigurationPath(directory)}.lock`;
    await mkdir(lock);
    await assert.rejects(initializeRootConfiguration(directory), /正在写入|锁/);
    assert.deepEqual(await readdir(directory), ['config.json.lock']);
  });
});

test('损坏的现存配置不被初始化覆盖，修复入口仍可解析', async () => {
  await temporary(async (directory) => {
    const text = '{"format_version":1,"server":"synthetic-private-fragment"';
    await fixture(directory, 'config.json', text);
    await assert.rejects(initializeRootConfiguration(directory), (error) => {
      assert.ok(!error.message.includes('synthetic-private-fragment'));
      assert.ok(!error.message.includes('"format_version"'));
      return true;
    });
    assert.throws(() => parseOptions(['start', '--data-dir', directory], {}), /根配置/);
    assert.equal(
      parseOptions(['config', 'show', '--data-dir', directory], {}).command,
      'config.show',
    );
    assert.equal(
      parseOptions(['config', 'path', '--data-dir', directory], {}).command,
      'config.path',
    );
    assert.equal(
      parseOptions(['config', 'import', 'repair.json', '--data-dir', directory], {}).source,
      'repair.json',
    );
    assert.equal(await readFile(rootConfigurationPath(directory), 'utf8'), text);
  });
});

test('CLI 配置 path、show、import 可在无运行服务时独立完成且更换工作目录无影响', async () => {
  await temporary(async (directory) => {
    const data = join(directory, 'instance');
    const cwd = join(directory, 'elsewhere');
    await mkdir(cwd);
    const source = await fixture(directory, 'source.json', configured);
    const shownPath = cli(['config', 'path'], data, cwd);
    assert.equal(shownPath.error, undefined);
    assert.equal(shownPath.status, 0, shownPath.stderr);
    assert.equal(shownPath.stdout.trim(), rootConfigurationPath(data));
    const missing = cli(['config', 'show'], data, cwd);
    assert.equal(missing.error, undefined);
    assert.equal(missing.status, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), defaults);
    const imported = cli(['config', 'import', source], data, cwd);
    assert.equal(imported.error, undefined);
    assert.equal(imported.status, 0, imported.stderr);
    const shown = cli(['config', 'show'], data, cwd);
    assert.equal(shown.error, undefined);
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout), configured);
  });
});

test('CLI 配置错误只显示受控提示，不泄露损坏 JSON 片段或令牌内容', async () => {
  await temporary(async (directory) => {
    const data = join(directory, 'instance');
    await initializeRootConfiguration(data);
    const original = await readFile(rootConfigurationPath(data));
    const secret = 'synthetic-cli-private-fragment';
    for (const text of [
      `{"format_version":1,"token":"${secret}"}`,
      `{"format_version":1,"server":"${secret}"`,
    ]) {
      const source = await fixture(directory, 'invalid.json', text);
      const reply = cli(['config', 'import', source], data);
      assert.equal(reply.error, undefined);
      assert.notEqual(reply.status, 0);
      const output = `${reply.stdout}${reply.stderr}`;
      assert.match(output, /根配置/);
      assert.ok(!output.includes(secret));
      assert.ok(!output.includes(text));
      assert.deepEqual(await readFile(rootConfigurationPath(data)), original);
    }
  });
});
