// 检查条件只记录名称；配置原值仅在内存中比较，不进入报告与断言错误。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { browserId, browserPath, digest, serverId, serverPath } from './fixture.mjs';
import { poll } from './host.mjs';

export const checks = (report) => (name, condition) => {
  assert.ok(condition, name);
  report.checks.push(name);
};

async function invoke(call, check, count, managed, label) {
  const job = await call('/api/v2/jobs', {
    method: 'POST',
    status: 202,
    input: {
      operation: `plugin.${serverId}.read`,
      input: {},
    },
  });
  const final = await poll(
    () => call(`/api/v2/jobs/${job.id}`),
    (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status),
    '受控插件调用终态',
  );
  check(
    label,
    final.status === 'succeeded' &&
      final.result?.count === count &&
      final.result?.managed === managed,
  );
}

export async function firstRound(call, check) {
  const initial = await call(serverPath);
  check(
    '服务器首次读取旁置模板与修订零',
    initial.source === 'legacy' && initial.revision === 0 && initial.values.count === 3,
  );
  await invoke(call, check, 3, true, '初始模板导入用户目录后插件实际消费托管快照');
  const server = await call(serverPath, {
    method: 'PATCH',
    input: { expected_revision: 0, patch: { count: 11 } },
  });
  check(
    '服务器保存推进修订并立即应用',
    server.source === 'managed' &&
      server.revision === 1 &&
      server.applied_revision === 1 &&
      server.values.count === 11 &&
      server.compatible,
  );
  await invoke(call, check, 11, true, '保存后插件实际消费托管配置');
  await call(serverPath, {
    method: 'PATCH',
    status: 409,
    input: { expected_revision: 0, patch: { count: 99 } },
  });
  const unchanged = await call(serverPath);
  check(
    '服务器过期修订被拒绝且当前配置不变',
    unchanged.revision === server.revision && isDeepStrictEqual(unchanged.values, server.values),
  );

  const missing = await call(browserPath);
  check('未安装的浏览器插件可以查询空配置', missing.record === null);
  const revision = randomUUID();
  const record = {
    version: 1,
    values: { count: 13, token: randomUUID() },
    revision,
    applied: revision,
    sensitivePaths: ['/token'],
  };
  const saved = await call(browserPath, {
    method: 'PATCH',
    input: { expected_revision: null, record },
  });
  check('浏览器首次保存完整记录', isDeepStrictEqual(saved.record, record));
  const read = await call(browserPath);
  check('浏览器配置重读保持版本原值修订与敏感路径', isDeepStrictEqual(read.record, record));
  await call(browserPath, {
    method: 'PATCH',
    status: 409,
    input: { expected_revision: null, record: { ...record, revision: randomUUID() } },
  });
  const nextRevision = randomUUID();
  const next = {
    ...record,
    values: { ...record.values, count: 17 },
    revision: nextRevision,
    applied: nextRevision,
  };
  const updated = await call(browserPath, {
    method: 'PATCH',
    input: { expected_revision: revision, record: next },
  });
  check('浏览器匹配当前修订可更新', isDeepStrictEqual(updated.record, next));
  await call(browserPath, {
    method: 'PATCH',
    status: 409,
    input: { expected_revision: revision, record },
  });
  const stable = await call(browserPath);
  check('浏览器首次空修订与过期修订均不能覆盖现有记录', isDeepStrictEqual(stable.record, next));
  return { server, browser: next };
}

export async function secondRound(call, check, saved) {
  const server = await call(serverPath);
  check(
    '更换业务目录后服务器配置与修订保留',
    server.source === 'managed' &&
      server.revision === saved.server.revision &&
      server.applied_revision === saved.server.applied_revision &&
      isDeepStrictEqual(server.values, saved.server.values),
  );
  await invoke(call, check, 11, true, '更换业务目录后插件仍实际消费用户配置');
  const browser = await call(browserPath);
  check('更换业务目录后浏览器完整配置与修订保留', isDeepStrictEqual(browser.record, saved.browser));
  await call(serverPath, {
    method: 'PATCH',
    status: 409,
    input: { expected_revision: 0, patch: { count: 99 } },
  });
  await call(browserPath, {
    method: 'PATCH',
    status: 409,
    input: { expected_revision: null, record: { ...saved.browser, revision: randomUUID() } },
  });
  check('重启后两类配置仍拒绝过期修订', true);
}

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function diskChecks(paths, fixture, saved, check, label) {
  const root = join(paths.user, 'plugin-configurations');
  const serverFile = join(root, 'server', serverId, 'state.json');
  const browserFile = join(root, 'browser', browserId, 'state.json');
  check(
    `${label}两类配置实际保存于指定用户根`,
    (await exists(serverFile))?.isFile() && (await exists(browserFile))?.isFile(),
  );
  const serverState = JSON.parse(await readFile(serverFile, 'utf8'));
  const browserState = JSON.parse(await readFile(browserFile, 'utf8'));
  check(
    `${label}用户根实际文件与公开读取一致`,
    serverState.revision === saved.server.revision &&
      isDeepStrictEqual(serverState.values, saved.server.values) &&
      isDeepStrictEqual(browserState, saved.browser),
  );
  for (let index = 0; index < paths.dataDirectories.length; index += 1) {
    check(
      `${label}业务目录${index + 1}不产生插件配置存储`,
      (await exists(join(paths.dataDirectories[index], 'plugin-configurations'))) === null,
    );
  }
  check(
    `${label}部署清单原始字节未改变`,
    digest(await readFile(fixture.manifestPath)) === fixture.manifestDigest,
  );
  check(
    `${label}旁置初始模板原始字节未改变`,
    digest(await readFile(fixture.legacyPath)) === fixture.legacyDigest,
  );
}
