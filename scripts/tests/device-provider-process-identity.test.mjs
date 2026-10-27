import assert from 'node:assert/strict';
import test from 'node:test';
import { assessProcessIdentity, snapshotProcesses } from '../device-provider/process-identity.mjs';
import { cleaned, exited, processEvidence } from '../device-provider/fixtures.mjs';
import { exited as nestedExited } from '../nested-device-artifacts/fixtures.mjs';

test('旧嵌套产物夹具继续导入同一退出检查，当前进程仍被识别为活动', () => {
  assert.equal(nestedExited, exited);
  assert.equal(exited(process.pid), false);
});

const scope = {
  run_id: 'unit-run-a',
  profile: 'debug',
  profile_directory: 'G:\\临时夹具\\deviceforge-provider-smoke-unit',
};
const identity = {
  ...scope,
  pid: 74008,
  command_line: '"node.exe" "G:\\临时夹具\\deviceforge-provider-smoke-unit\\server-plugins\\a\\dist\\index.mjs"',
  created_at: '639286960706700001',
  entry_path: 'G:\\临时夹具\\deviceforge-provider-smoke-unit\\server-plugins\\a\\dist\\index.mjs',
};
const start = { kind: 'started', pid: identity.pid, process_identity: identity };
const present = { state: 'present', ...identity };
const assess = (observation = present, event = start, currentScope = scope) =>
  assessProcessIdentity(event, observation, currentScope);

test('同一 PID、命令行、创建时间与本次目录仍在时不得放行', () => {
  assert.equal(assess().state, 'running');
  assert.equal(assess().process_exited, false);
});

test('PID 消失可确认本次进程已退出', () => {
  assert.equal(assess({ state: 'absent', pid: identity.pid }).state, 'exited');
  assert.equal(assess({ state: 'absent', pid: identity.pid }).process_exited, true);
});

test('同 PID 被外来命令与新创建时间复用，不得误报本次残留', () => {
  const result = assess({ ...present, command_line: 'node unrelated.mjs', created_at: '639286960900000000' });
  assert.equal(result.state, 'pid_reused');
  assert.equal(result.process_exited, true);
});

test('同命令同目录但创建时间改变，也属于 PID 复用', () => {
  assert.equal(assess({ ...present, created_at: '639286960706700002' }).state, 'pid_reused');
});

test('仅命令行不同但创建时间相同不能推定旧进程退出', () => {
  assert.equal(assess({ ...present, command_line: 'node changed.mjs' }).state, 'unconfirmed');
});

test('查询被拒绝或超时不等于进程退出', () => {
  const result = assess({ state: 'unknown', pid: identity.pid, error_code: 'EACCES' });
  assert.equal(result.state, 'unconfirmed');
  assert.equal(result.process_exited, false);
});

test('当前命令行或创建时间缺失，不能掩盖真实泄漏', () => {
  for (const key of ['command_line', 'created_at']) {
    assert.equal(assess({ ...present, [key]: null }).state, 'unconfirmed');
  }
});

test('旧报告没有原进程身份时不能事后将其改为通过', () => {
  assert.equal(assess(present, { kind: 'started', pid: identity.pid }).state, 'unconfirmed');
});

test('别次运行或另一构建 profile 的事件不能证明本次退出', () => {
  for (const patch of [{ run_id: 'unit-run-b' }, { profile: 'release' }, { profile_directory: 'G:\\other' }]) {
    const event = { ...start, process_identity: { ...identity, ...patch } };
    assert.equal(assess({ state: 'absent', pid: identity.pid }, event).state, 'unconfirmed');
  }
});

test('入口必须位于本次目录内，不能用同前缀的外来路径冒认', () => {
  const entry_path = `${scope.profile_directory}-other\\index.mjs`;
  const event = { ...start, process_identity: { ...identity, entry_path } };
  assert.equal(assess({ state: 'absent', pid: identity.pid }, event).state, 'unconfirmed');
});

test('命令行必须包含本次实际入口，不能只靠配置声称归属', () => {
  const event = { ...start, process_identity: { ...identity, command_line: 'node unrelated.mjs' } };
  assert.equal(assess({ state: 'absent', pid: identity.pid }, event).state, 'unconfirmed');
});

test('Windows 入口归属兼容命令行路径大小写与分隔符差异', () => {
  const command_line = identity.command_line.replaceAll('\\', '/').toLowerCase();
  const event = { ...start, process_identity: { ...identity, command_line } };
  assert.equal(assess({ ...present, command_line }, event).state, 'running');
});

test('观察结果 PID 不对应时不能据此确认退出', () => {
  assert.equal(assess({ ...present, pid: 74009 }).state, 'unconfirmed');
});

test('即使自报 process_exit，同一实例仍可见也继续报残留', () => {
  assert.equal(assess(present, { ...start, process_exit: true }).process_exited, false);
});

test('复用 PID 的外来命令行只留摘要，不能把敏感参数写入报告', () => {
  const command_line = 'node foreign.mjs --token=unit-secret';
  const result = assess({ ...present, command_line, created_at: 'different-time' });
  assert.equal(result.observed.command_line_matches, false);
  assert.equal(result.observed.command_line_sha256.length, 64);
  assert.equal(JSON.stringify(result).includes('unit-secret'), false);
});

test('同一次快照同时检查复用 PID 的旧调用和仍存活的新调用', () => {
  const next = { ...start, request_id: 'next', process_identity: { ...identity, created_at: 'next-time' } };
  let queries = 0;
  const result = processEvidence({ processScope: scope }, [start, next], (pids) => {
    queries += 1;
    assert.deepEqual(pids, [identity.pid, identity.pid]);
    return new Map([[identity.pid, { ...present, created_at: 'next-time' }]]);
  });
  assert.equal(queries, 1);
  assert.equal(result[0].process.state, 'pid_reused');
  assert.equal(result[1].process.state, 'running');
});

const windowsSnapshot = (output, execute = () => output) =>
  snapshotProcesses([identity.pid], { platform: 'win32', execute }).get(identity.pid);

test('Windows 查询限定给定 PID、隐藏窗口、限制 5 秒且去重', () => {
  let queries = 0;
  const result = snapshotProcesses([identity.pid, identity.pid], {
    platform: 'win32',
    execute: (file, args, options) => {
      queries += 1;
      assert.equal(file, 'powershell.exe');
      assert.ok(args.at(-1).includes(`-Filter 'ProcessId=${identity.pid}'`));
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 5000);
      assert.equal(options.maxBuffer, 512 * 1024);
      return JSON.stringify([present]);
    },
  });
  assert.equal(queries, 1);
  assert.equal(result.size, 1);
  assert.equal(result.get(identity.pid).created_at, identity.created_at);
});

test('Windows 只有成功返回空数组才表示 PID 不存在', () => {
  assert.equal(windowsSnapshot('[]').state, 'absent');
  for (const output of ['', 'null', '{}', 'not json', JSON.stringify([{ pid: 74009 }]), JSON.stringify([present, present])]) {
    assert.equal(windowsSnapshot(output).state, 'unknown');
  }
});

test('Windows 查询超时、拒绝访问都保持未确认，不退回裸 PID 判断', () => {
  for (const code of ['ETIMEDOUT', 'EACCES']) {
    const observed = windowsSnapshot(null, () => { throw Object.assign(new Error('不记录原始错误输出'), { code }); });
    assert.equal(observed.state, 'unknown');
    assert.equal(observed.error_code, code);
    assert.equal(assess(observed).process_exited, false);
  }
});

test('Windows 中文命令行和 BOM 能保留原样并参与比较', () => {
  assert.equal(assess(windowsSnapshot(`\uFEFF${JSON.stringify([present])}`)).state, 'running');
});

test('空 PID 集合不启动查询，非法 PID 或超限集合不能构造命令', () => {
  const options = { platform: 'win32', execute: () => { assert.fail('不应启动查询'); } };
  assert.equal(snapshotProcesses([], options).size, 0);
  for (const ids of [[0], [-1], [1.2], ['74008;Stop-Process'], Array.from({ length: 257 }, (_, i) => i + 1)]) {
    assert.throws(() => snapshotProcesses(ids, options));
  }
});

test('不支持的平台必须显式未确认', () => {
  assert.equal(snapshotProcesses([identity.pid], { platform: 'unknown' }).get(identity.pid).state, 'unknown');
});

test('Linux 只有 stat 明确不存在才认定 PID 已退出', () => {
  const read = () => { throw Object.assign(new Error('不存在'), { code: 'ENOENT' }); };
  const observed = snapshotProcesses([identity.pid], { platform: 'linux', read }).get(identity.pid);
  assert.equal(observed.state, 'absent');
});

test('Linux 后续读取失败不能把仍可见进程误判为退出', () => {
  const read = (file) => {
    if (file.endsWith('/stat')) return `${identity.pid} (node) ${Array(20).fill('1').join(' ')}`;
    throw Object.assign(new Error('其他字段缺失'), { code: 'ENOENT' });
  };
  const observed = snapshotProcesses([identity.pid], { platform: 'linux', read }).get(identity.pid);
  assert.equal(observed.state, 'unknown');
});

test('Linux 创建身份保留启动时钟精度和完整参数边界', () => {
  const fields = Array(20).fill('1');
  fields[19] = '9007199254740993';
  const read = (file) => {
    if (file.endsWith('/stat')) return `${identity.pid} (name with ) bracket) ${fields.join(' ')}`;
    if (file.endsWith('/boot_id')) return 'boot-unit\n';
    return `node\0${identity.entry_path}\0`;
  };
  const observed = snapshotProcesses([identity.pid], { platform: 'linux', read }).get(identity.pid);
  assert.equal(observed.created_at, 'boot-unit:9007199254740993');
  assert.equal(observed.command_line, `node\0${identity.entry_path}`);
});

test('本机只查询单元测试自身的 PID，不连接或操作服务', { skip: process.platform !== 'win32' }, (t) => {
  const observed = snapshotProcesses([process.pid]).get(process.pid);
  assert.equal(observed.state, 'present', `测试自身进程身份查询失败：${observed.error_code}`);
  // 测试运行器可以用相对路径启动子进程；这里只检验查询对象，不冒认夹具归属。
  assert.ok(observed.command_line.includes(process.argv[1].split(/[\\/]/).at(-1)));
  assert.match(observed.created_at, /^\d+$/);
  t.diagnostic(`仅查询测试自身 PID=${process.pid}；辅助查询同步结束`);
});

const cleanupStart = { ...start, request_id: 'cleanup-unit', label: 'cleanup-unit' };
const cleanupEvents = ['started', 'cleaned', 'process_exit'].map((kind) => ({ ...cleanupStart, kind }));
const cleanupOptions = (all, observed) => ({
  atReturn: true,
  readEvents: async () => all,
  observe: () => new Map([[identity.pid, observed]]),
});

test('卸载返回后查询才发现退出，不能补齐首次读取时缺失的退出标记', async () => {
  await assert.rejects(
    cleaned({ processScope: scope }, 'cleanup-unit', cleanupOptions(cleanupEvents.slice(0, 2), { pid: identity.pid, state: 'absent' })),
    /卸载返回前必须完成/,
  );
});

test('自报退出但同一实例仍活着，卸载清理仍失败', async () => {
  await assert.rejects(
    cleaned({ processScope: scope }, 'cleanup-unit', cleanupOptions(cleanupEvents, present)),
    /卸载返回前必须完成/,
  );
});

test('清理、退出标记及操作系统退出三者齐全才能通过', async () => {
  const result = await cleaned({ processScope: scope }, 'cleanup-unit', cleanupOptions(cleanupEvents, { pid: identity.pid, state: 'absent' }));
  assert.equal(result.process_exit_recorded, true);
  assert.equal(result.process_exited, true);
});

test('退出标记已在首次读取中存在，之后 PID 复用不能误报卸载泄漏', async () => {
  const result = await cleaned({ processScope: scope }, 'cleanup-unit', cleanupOptions(cleanupEvents, { ...present, created_at: 'next-time' }));
  assert.equal(result.process_observation.state, 'pid_reused');
});
