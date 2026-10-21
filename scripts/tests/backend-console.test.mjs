import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRecentRecords, createLogFollower, formatLog } from '../backend-console/logs.mjs';
import { ownedDirectory, record, encoded, lines } from './backend-console-fixture.mjs';
import { registerLifecycleTests } from './backend-console-lifecycle.mjs';

test('日志读取按文件滚动顺序仅返回最近上限条完整记录，忽略非日志与破损行', async () => {
  await ownedDirectory(async (directory) => {
    await writeFile(
      join(directory, 'deviceforge.2026-10-19.jsonl'),
      Buffer.concat([encoded(record('前一天')), encoded(record('旧记录'))]),
    );
    await writeFile(
      join(directory, 'deviceforge.2026-10-20.jsonl'),
      Buffer.concat([
        encoded(record('最新一')),
        Buffer.from('不是JSON\n'),
        encoded(record('最新二')),
        Buffer.from('{"fields":'),
      ]),
    );
    await writeFile(join(directory, 'private.txt'), encoded(record('不得读取')));
    const recent = await readRecentRecords(directory, 2);
    assert.equal(recent.length, 2);
    const output = recent.map(formatLog).join('\n');
    assert.match(output, /最新一/);
    assert.match(output, /最新二/);
    assert.doesNotMatch(output, /前一天|旧记录|不得读取|不是JSON/);
  });
});

test('日志格式保留中文消息与排查标识，只允许安全字段，不透传秘密和嵌套输入', () => {
  const output = formatLog(
    record('收到中文任务', {
      log_id: 'correlation-17',
      job_id: 'job-27',
      code: 'ok',
      token: 'FIXTURE_TOKEN_VALUE',
      api_key: 'FIXTURE_API_KEY_VALUE',
      password: 'FIXTURE_PASSWORD_VALUE',
      authorization: 'Bearer FIXTURE_AUTH_VALUE',
      input: { message: 'FIXTURE_INPUT_VALUE' },
      arbitrary: 'FIXTURE_UNKNOWN_VALUE',
    }),
  );
  assert.equal(typeof output, 'string');
  assert.match(output, /收到中文任务/);
  assert.match(output, /correlation-17/);
  assert.doesNotMatch(output, /FIXTURE_(?:TOKEN|API_KEY|PASSWORD|AUTH|INPUT|UNKNOWN)_VALUE/);
  assert.doesNotMatch(output, /undefined|\[object Object\]/);
});

test('日志跟随等待完整JSON行与中文UTF8字节，重复轮询不重放且关闭后停止', async () => {
  await ownedDirectory(async (directory) => {
    const path = join(directory, 'deviceforge.2026-10-20.jsonl');
    await writeFile(path, encoded(record('已有记录')));
    const writes = [];
    const follower = createLogFollower(directory, {
      write: (value) => writes.push(String(value)),
      initialLines: 1,
    });
    try {
      await follower.poll();
      assert.equal((lines(writes).match(/已有记录/g) ?? []).length, 1);
      const bytes = encoded(record('中文半行拼接完成'));
      const chinese = bytes.indexOf(Buffer.from('中文', 'utf8')) + 1;
      await appendFile(path, bytes.subarray(0, chinese));
      await follower.poll();
      assert.doesNotMatch(lines(writes), /中文半行拼接完成|�/);
      await appendFile(path, bytes.subarray(chinese, bytes.length - 1));
      await follower.poll();
      assert.doesNotMatch(lines(writes), /中文半行拼接完成/);
      await appendFile(path, bytes.subarray(bytes.length - 1));
      await follower.poll();
      await follower.poll();
      assert.equal((lines(writes).match(/中文半行拼接完成/g) ?? []).length, 1);
      assert.doesNotMatch(lines(writes), /�/);
      await follower.close();
      const before = writes.length;
      await appendFile(path, encoded(record('关闭后新记录')));
      await assert.rejects(follower.poll(), /已关闭/);
      assert.equal(writes.length, before);
    } finally {
      await follower.close();
    }
  });
});

test('日志截断、同名替换和日期滚动后从新文件读取，不拼接旧半行也不重放历史', async () => {
  await ownedDirectory(async (directory) => {
    const path = join(directory, 'deviceforge.2026-10-20.jsonl');
    await writeFile(
      path,
      Buffer.concat([
        encoded(record('截断前长记录'.repeat(20))),
        Buffer.from('{"fields":{"message":"旧半行'),
      ]),
    );
    const writes = [];
    const follower = createLogFollower(directory, {
      write: (value) => writes.push(String(value)),
      initialLines: 0,
    });
    try {
      await follower.poll();
      assert.equal(writes.length, 0);
      await writeFile(path, encoded(record('截断后')));
      await follower.poll();
      assert.equal((lines(writes).match(/截断后/g) ?? []).length, 1);
      const replacement = join(directory, 'replacement.tmp');
      await writeFile(replacement, encoded(record('同名替换后')));
      await rename(path, join(directory, 'archived.old'));
      await rename(replacement, path);
      await follower.poll();
      assert.equal((lines(writes).match(/同名替换后/g) ?? []).length, 1);
      await writeFile(
        join(directory, 'deviceforge.2026-10-21.jsonl'),
        encoded(record('日期滚动后')),
      );
      await follower.poll();
      await follower.poll();
      assert.equal((lines(writes).match(/日期滚动后/g) ?? []).length, 1);
      assert.doesNotMatch(lines(writes), /旧半行|截断前长记录/);
    } finally {
      await follower.close();
    }
  });
});

test('空日志目录可以跟随，后续新增文件不会漏掉首条中文记录', async () => {
  await ownedDirectory(async (directory) => {
    const logs = join(directory, 'logs');
    await mkdir(logs);
    const writes = [];
    const follower = createLogFollower(logs, {
      write: (value) => writes.push(String(value)),
      initialLines: 0,
    });
    try {
      assert.deepEqual(await readRecentRecords(logs, 10), []);
      await follower.poll();
      await writeFile(join(logs, 'deviceforge.2026-10-20.jsonl'), encoded(record('新目录首条')));
      await follower.poll();
      assert.equal((lines(writes).match(/新目录首条/g) ?? []).length, 1);
    } finally {
      await follower.close();
    }
  });
});

registerLifecycleTests();
