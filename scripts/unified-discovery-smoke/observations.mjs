import assert from 'node:assert/strict';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

// 对真实响应做逐字段比较，不在验收脚本内重实现宿主原文解析规则。
export function assertDirectory(directory, provider, expected, jobId) {
  assert.deepEqual(directory.provider, provider, '目录必须保留完整当前提供者身份及设备声明');
  assert.match(directory.discovery_job_id, uuid);
  if (jobId !== undefined)
    assert.equal(directory.discovery_job_id, jobId, '目录关联本次Job，不能用后轮目录冒充本次回执');
  assert.ok(Number.isSafeInteger(directory.observed_at) && directory.observed_at > 0);
  assert.equal(directory.devices.length, expected.length, '观测必须整份返回');
  for (let index = 0; index < expected.length; index++) {
    const actual = directory.devices[index],
      wanted = expected[index];
    assert.deepEqual(actual.reference, {
      provider_id: provider.id,
      generation: provider.generation,
      local_id: wanted.local_id,
    });
    assert.equal(actual.state, wanted.state);
    assert.equal(actual.model, wanted.model ?? null);
    assert.deepEqual(actual.capabilities, wanted.capabilities);
    if (wanted.raw_state === undefined || wanted.raw_state === null) {
      assert.equal(
        Object.hasOwn(actual, 'raw_state'),
        false,
        '缺失或null原文映射为None并省略，不补造归一化状态',
      );
    } else {
      assert.equal(actual.raw_state, wanted.raw_state, '特殊/未知原文不得trim、改大小写或替换');
      assert.deepEqual(
        Buffer.from(actual.raw_state, 'utf8'),
        Buffer.from(wanted.raw_state, 'utf8'),
      );
    }
  }
  return directory;
}

export function assertLegacyArray(result, expected, platform) {
  assert.deepEqual(
    result,
    expected.map((device) => ({
      id: device.local_id,
      platform,
      state: device.raw_state,
      model: device.model ?? null,
    })),
    'format2旧结果必须是同次观测的完整有限数组',
  );
  for (const item of result)
    assert.deepEqual(Object.keys(item).sort(), ['id', 'model', 'platform', 'state']);
}

export function assertSingleJob(before, after, operation, jobId) {
  const previous = new Set(before.map((job) => job.id));
  const added = after.filter((job) => !previous.has(job.id));
  assert.equal(added.length, 1, '成功准入只能创建一个共享Job，不得嵌套包装任务');
  const job = added[0];
  assert.equal(job.id, jobId);
  assert.equal(job.operation, operation, '历史保留入口原名');
  assert.deepEqual(job.input, {}, '历史保留严格空业务输入');
  return job;
}

export function assertNoSideEffects(before, after) {
  assert.deepEqual(after.jobs, before.jobs, '坏输入在Job创建前拒绝');
  assert.deepEqual(after.directories, before.directories, '坏输入不得清理已有合法目录');
  assert.deepEqual(after.executionKeys, before.executionKeys, '坏输入不得启动任何真实执行');
}

export function rawCases() {
  return {
    valid: [
      {
        name: '特殊原文保真',
        raw_state: 'Recovery 模式 / SIDELOAD',
        bytes: Buffer.byteLength('Recovery 模式 / SIDELOAD'),
      },
      {
        name: '未知原文及首尾空白保真',
        raw_state: '  Vendor:未识别  ',
        bytes: Buffer.byteLength('  Vendor:未识别  '),
      },
      { name: '100字节中文边界', raw_state: `${'中'.repeat(33)}A`, bytes: 100 },
    ],
    invalid: [
      { name: '空字符串', raw_state: '' },
      { name: '全空白', raw_state: ' \u3000 ' },
      { name: '101字节中文边界', raw_state: `${'中'.repeat(33)}AB` },
      { name: 'NUL控制字符', raw_state: 'raw\u0000state' },
      { name: '换行控制字符', raw_state: 'raw\nstate' },
      { name: 'DEL控制字符', raw_state: 'raw\u007fstate' },
      { name: 'C1控制字符', raw_state: 'raw\u0085state' },
      { name: '错误类型', raw_state: 7 },
    ],
    absent: [
      { name: '省略', omitted: true },
      { name: 'null', raw_state: null },
    ],
  };
}
