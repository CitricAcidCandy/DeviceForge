import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archive } from '../device-provider/fixtures.mjs';
import { fixture } from '../unified-discovery/fixtures.mjs';
import { writeBindings } from './bindings.mjs';
import { fileIdentity, packageIdentity } from './evidence.mjs';

async function widenDiscovery(item) {
  // 仅改变公开manifest，验证较宽schema不能绕过统一发现的严格{}准入。
  item.manifest.operations[0].input_schema = { type: 'object' };
  const descriptor = {
    name: `deviceforge-unified-discovery-${item.id}`,
    version: '1.0.0',
    type: 'module',
    deviceforge: {
      kind: 'server',
      manifest: 'plugin.json',
      entrypoints: { any: { runtime: 'node', path: 'dist/index.mjs' } },
    },
  };
  const config = {
    id: item.id,
    protocol: item.protocol,
    devicesApiVersion: item.devicesApiVersion,
    platform: item.platform,
    directory: item.controlDirectory,
    localId: item.localId,
    otherId: item.otherId,
  };
  item.archive = item.tgz = archive([
    ['package.json', JSON.stringify(descriptor)],
    ['plugin.json', JSON.stringify(item.manifest)],
    [
      'dist/index.mjs',
      await readFile(new URL('../unified-discovery/node-provider.mjs', import.meta.url), 'utf8'),
    ],
    ['dist/fixture.json', JSON.stringify(config)],
  ]);
  item.sha256 = packageIdentity(item).sha256;
}

export async function inputs(directory, report) {
  const markers = join(directory, 'markers'),
    packages = join(directory, 'packages');
  await mkdir(packages);
  const items = [];
  for (const protocol of [2, 3])
    for (const api of [1, 2, 3]) {
      const item = await fixture(`raw_p${protocol}_a${api}`, markers, {
        protocol,
        devicesApiVersion: api,
        platform: protocol === 2 ? 'android' : 'harmony',
        ...(api > 1 ? { executionTimeoutMs: 120000 } : {}),
      });
      item.alias =
        api === 3
          ? protocol === 2
            ? 'android.devices'
            : 'harmony.devices'
          : `legacy.discovery_${item.id}`;
      item.legacy = api === 3;
      items.push(item);
    }
  // 协议1独立验证Json来源，不进入只接受协议2/3宿主包装的既有成功矩阵。
  const protocolOne = await fixture('raw_p1_a3', markers, {
    protocol: 1,
    devicesApiVersion: 3,
    platform: 'synthetic_raw_protocol_one',
  });
  protocolOne.alias = 'legacy.discovery_raw_p1_a3';
  protocolOne.legacy = true;
  const wide = await fixture('raw_wide_schema', markers, {
    protocol: 3,
    devicesApiVersion: 3,
    platform: 'synthetic_raw',
  });
  wide.alias = 'legacy.discovery_wide';
  wide.legacy = true;
  await widenDiscovery(wide);
  const profiles = [
    await fixture('raw_profile_api2', markers, {
      protocol: 2,
      devicesApiVersion: 2,
      platform: 'android',
    }),
    await fixture('raw_profile_platform', markers, {
      protocol: 3,
      devicesApiVersion: 3,
      platform: 'android',
    }),
  ];
  for (const item of profiles) {
    item.alias = `legacy.discovery_${item.id}`;
    item.legacy = true;
  }
  const invalid = await fixture('raw_invalid_package', markers, {
    protocol: 3,
    devicesApiVersion: 3,
  });
  const all = [...items, wide, protocolOne, ...profiles];
  const declarations = all.map((item) => ({
    operation: item.alias,
    pluginId: item.id,
    legacy: item.legacy,
    platform: item === profiles[1] ? 'harmony' : item.platform,
  }));
  const path = join(directory, 'operation-bindings.json');
  const config = await writeBindings(path, declarations);
  report.bindings = {
    ...(await fileIdentity(path)),
    format_version: config.format_version,
    count: config.bindings.length,
  };
  report.packages = [];
  for (const item of all) {
    const packagePath = join(packages, `${item.id}.tgz`);
    await writeFile(packagePath, item.archive);
    report.packages.push({
      ...packageIdentity(item),
      path: packagePath,
      role:
        item === protocolOne
          ? 'protocol_one_compatibility'
          : profiles.includes(item)
            ? 'profile_load_rejection'
            : 'valid',
    });
  }
  report.invalid_packages = [];
  for (const [name, bytes] of Object.entries(invalid.invalidArchives)) {
    const packagePath = join(packages, `invalid-${name}.tgz`);
    await writeFile(packagePath, bytes);
    report.invalid_packages.push({
      case: name,
      plugin_id: invalid.id,
      ...(await fileIdentity(packagePath)),
    });
  }
  return { items, wide, protocolOne, profiles, invalid, all, path, config };
}
