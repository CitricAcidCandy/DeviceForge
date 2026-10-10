import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { archive } from '../device-provider/fixtures.mjs';

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['case_id'],
  properties: {
    case_id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_-]{1,80}$' },
  },
};

// 报告由验收驱动统一维护；这里只返回本次真实归档与管理员控制根，不覆盖共享报告。
export async function createFixtures(directory, report) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const fixtureRoot = await mkdtemp(join(root, 'ordinary-deadline-'));
  const source = await readFile(new URL('./plugin-process.mjs', import.meta.url), 'utf8');
  const runId = randomUUID();
  const suffix = runId.replaceAll('-', '').slice(0, 12);
  const fixtures = [];

  for (const protocolVersion of [2, 3]) {
    const pluginId = `ordinary_deadline_v${protocolVersion}_${suffix}`;
    const controlRoot = join(fixtureRoot, `${pluginId}-control`);
    await mkdir(controlRoot);
    const operations = Object.fromEntries(['long', 'short', 'default']
      .map((name) => [name, `plugin.${pluginId}.${name}`]));
    const manifest = {
      id: pluginId,
      version: '1.0.0',
      protocol_version: protocolVersion,
      args: [],
      operations: ['long', 'short', 'default'].map((name) => ({
        name,
        title: `普通期限夹具 ${name}`,
        input_schema: inputSchema,
        ...(name === 'default' ? {} : {
          execution: { api_version: 1, total_timeout_ms: name === 'long' ? 120000 : 10000 },
        }),
      })),
    };
    const descriptor = {
      name: `deviceforge-${pluginId.replaceAll('_', '-')}`,
      version: '1.0.0',
      type: 'module',
      deviceforge: {
        kind: 'server',
        manifest: 'plugin.json',
        entrypoints: { any: { runtime: 'node', path: 'dist/index.mjs' } },
      },
    };
    // 固定配置属于可信包内容；公开 input 不提供控制路径、预算或运行时覆盖。
    const config = { pluginId, protocolVersion, controlRoot, runId };
    const bytes = archive([
      ['package.json', JSON.stringify(descriptor)],
      ['plugin.json', JSON.stringify(manifest)],
      ['dist/index.mjs', source],
      ['dist/fixture.json', JSON.stringify(config)],
    ]);
    const archivePath = join(fixtureRoot, `${pluginId}.tgz`);
    await writeFile(archivePath, bytes, { flag: 'wx' });
    fixtures.push({
      pluginId, protocolVersion, archivePath,
      archiveSha256: createHash('sha256').update(bytes).digest('hex'),
      controlRoot, operations, shortTimeoutMs: 10000, runId,
    });
  }

  return fixtures;
}
