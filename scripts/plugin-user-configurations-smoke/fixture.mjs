// 独立部署受控 Node 插件；模板与清单由测试创建，不读取真实用户配置。
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const serverId = 'user_config_smoke';
export const browserId = 'user_browser_config_smoke';
export const serverPath = `/api/v2/plugin-configurations/server/${serverId}`;
export const browserPath = `/api/v2/browser-plugin-configurations/${browserId}`;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function prepare(paths, repository) {
  await mkdir(paths.deployment, { recursive: true });
  await mkdir(paths.browserDeployment, { recursive: true });
  const directory = join(paths.deployment, serverId);
  await mkdir(directory);
  const fixture = join(paths.output, 'fixture.mjs');
  await copyFile(
    join(repository, 'backend/scripts/plugin-configurations-smoke/fixture.mjs'),
    fixture,
  );
  const legacy = join(directory, 'legacy.json');
  await writeFile(legacy, JSON.stringify({ count: 3 }));
  const manifest = {
    id: serverId,
    version: '1.0.0',
    protocol_version: 1,
    executable: process.execPath,
    args: [fixture, '--config', legacy, '--marker', join(directory, 'started')],
    operations: [
      {
        name: 'read',
        title: '读取受控用户配置',
        input_schema: {
          type: 'object',
          properties: { delay_ms: { type: 'integer', minimum: 0, maximum: 5000 } },
          additionalProperties: false,
        },
      },
    ],
    configuration: {
      version: 1,
      apply_policy: 'next_invocation',
      legacy_filename: 'legacy.json',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count'],
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
      defaults: { count: 1 },
    },
  };
  const manifestPath = join(directory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return {
    manifestPath,
    legacyPath: legacy,
    manifestDigest: digest(await readFile(manifestPath)),
    legacyDigest: digest(await readFile(legacy)),
  };
}
