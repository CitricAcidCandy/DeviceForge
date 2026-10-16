import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageController } from '../src/components/Message/index.ts';

test('全局消息按ID更新，重复错误替换计时标识，诊断保留而不产生页面状态', () => {
  const messages = createMessageController();
  const events: number[] = [];
  const stop = messages.subscribe(() => events.push(messages.snapshot().length));
  const id = messages.loading('正在发现', { action: { label: '取消等待', onClick() {} } });
  messages.warning('部分提供者失败', {
    id,
    details: [{ label: 'android-device', message: '工具未配置', logId: 'log-1' }],
  });
  assert.equal(messages.snapshot().length, 1);
  assert.equal(messages.snapshot()[0]?.level, 'warning');
  assert.equal(messages.snapshot()[0]?.details?.[0]?.logId, 'log-1');
  const previousError = messages.error('连接失败', { logId: 'log-2' });
  const error = messages.error('连接失败', { logId: 'log-2' });
  assert.notEqual(error, previousError);
  assert.equal(messages.snapshot().length, 2);
  messages.dismiss(id);
  assert.equal(messages.snapshot()[0]?.id, error);
  stop();
  const count = events.length;
  messages.clear();
  assert.equal(events.length, count);
  messages.dispose();
});

test('消息数量有界并保留等待取消入口，服务销毁后旧消息不能重新出现', () => {
  const messages = createMessageController();
  const waiting = messages.loading('读取任务', { action: { label: '取消等待', onClick() {} } });
  for (let index = 0; index < 12; index++) messages.success(`复制完成${index}`);
  assert.equal(messages.snapshot().length, 4);
  assert.equal(messages.snapshot().filter((item) => item.level !== 'loading').length, 3);
  assert.ok(messages.snapshot().some((item) => item.id === waiting));
  assert.equal(messages.snapshot().at(-1)?.title, '复制完成11');
  assert.ok(Object.isFrozen(messages.snapshot()));
  assert.ok(Object.isFrozen(messages.snapshot()[0]));
  messages.dispose();
  assert.deepEqual(messages.snapshot(), []);
  assert.equal(messages.error('晚到旧错误'), '');
  assert.deepEqual(messages.snapshot(), []);
});
