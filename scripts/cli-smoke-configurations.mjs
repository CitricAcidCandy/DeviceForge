// 通过实际npx代理保存浏览器记录，并核对两类配置落在独立用户根。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export function createNpxConfigurationCheck(userDirectory, dataDirectory) {
  const record = {
    version: 1,
    values: { count: 17 },
    revision: randomUUID(),
    applied: 'defaults',
    sensitivePaths: [],
  };
  let created = false;
  return async (base, headers) => {
    const path = '/api/v2/browser-plugin-configurations/npx.user-configuration';
    const logs = [];
    async function call(method, body) {
      const response = await fetch(base + path, {
        method,
        headers,
        signal: AbortSignal.timeout(5000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.equal(value.log_id, response.headers.get('x-deviceforge-log-id'));
      logs.push(value.log_id);
      return value.data.record;
    }
    if (!created) {
      assert.equal(await call('GET'), null);
      assert.ok(
        isDeepStrictEqual(await call('PATCH', { expected_revision: null, record }), record),
      );
      created = true;
    }
    assert.ok(isDeepStrictEqual(await call('GET'), record), '实际npx重启后的浏览器记录不一致');
    const directory = join(userDirectory, 'plugin-configurations');
    const persisted = JSON.parse(
      await readFile(join(directory, 'browser', 'npx.user-configuration', 'state.json'), 'utf8'),
    );
    assert.ok(isDeepStrictEqual(persisted, record), '浏览器配置实际落盘内容不一致');
    const server = JSON.parse(
      await readFile(join(directory, 'server', 'tool-supply', 'state.json'), 'utf8'),
    );
    assert.ok(
      server.values.manifest_url && !server.values.local_manifest,
      '完整有效的旧工具配置不应混入互斥默认项',
    );
    assert.equal(
      await stat(join(dataDirectory, 'plugin-configurations')).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      ),
      false,
      '业务根不应创建插件配置存储',
    );
    return {
      passed: true,
      root_independent: true,
      browser_record_persisted: true,
      legacy_source_preserved: true,
      log_ids: logs,
    };
  };
}
