import { deviceId, packageName } from './fixtures.mjs';
// 独立按主代理冻结的AOSP字段手工编码，禁止导入生产解析器或其测试编码器。
const varint = (value) => {
  let number = BigInt(value),
    bytes = [];
  if (number < 0) number += 1n << 64n;
  do {
    let next = Number(number & 127n);
    number >>= 7n;
    if (number) next |= 128;
    bytes.push(next);
  } while (number);
  return Buffer.from(bytes);
};
const integer = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const bytesField = (field, bytes) =>
  Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
const textField = (field, value) => bytesField(field, Buffer.from(value));
const metadata = (key, value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytesField(42, Buffer.concat([integer(1, key), bytesField(2, bytes)]));
};
export const layerName = 'SurfaceView[' + packageName + '/MainActivity](BLAST)#42';
function layer({ id, name, parent, ownerUid, uid, pid }) {
  return Buffer.concat([
    integer(1, id),
    textField(2, name),
    ...(parent === undefined ? [] : [integer(25, parent)]),
    ...(ownerUid === undefined ? [] : [integer(53, ownerUid)]),
    ...(uid === undefined ? [] : [metadata(1, uid)]),
    ...(pid === undefined ? [] : [metadata(6, pid)]),
  ]);
}
const root = (overrides) => ({
  id: 10,
  name: '游戏父节点',
  parent: -1,
  ownerUid: 1000,
  uid: 10123,
  pid: 2468,
  ...overrides,
});
const candidate = (overrides) => ({
  id: 42,
  name: layerName,
  parent: 10,
  ownerUid: 10123,
  ...overrides,
});
function layers(values) {
  return Buffer.concat(values.map((value) => bytesField(1, layer(value))));
}
function wrapped(values) {
  const magic = Buffer.concat([Buffer.from([0x09]), Buffer.from('4c59525452414345', 'hex')]);
  return Buffer.concat([magic, bytesField(2, bytesField(3, layers(values)))]);
}
const valid = layers([root(), candidate()]);
const shell = (tail) => ['-s', deviceId, 'shell', '-T', ...tail];
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
// 与生产命令独立构造逐项引用后再整体引用的固定解释器argv。
const quotedShell = (tail) =>
  shell(['/system/bin/sh', '-c', shellQuote(tail.map(shellQuote).join(' '))]);
const latencyArgv = quotedShell(['dumpsys', 'SurfaceFlinger', '--latency', layerName]);
const snapshot = (timestamps) =>
  '16666667\n' + timestamps.map((value) => '1 ' + value + ' 1').join('\n') + '\n';
const before = snapshot([950000000, 1000000000]),
  after = snapshot([950000000, 1000000000, 1016666667, 1033333334, 1050000000]);
const alternate = (a, b) => Array.from({ length: 64 }, (_, i) => (i % 2 ? b : a));
const command = (category, tail, outputs) => ({ category, argv: shell(tail), outputs });
function stat(start, ticks) {
  const fields = Array(20).fill('0');
  fields[0] = 'R';
  fields[11] = String(ticks);
  fields[19] = String(start);
  return '2468 (fps game) ' + fields.join(' ') + '\n';
}
const status = (uid) =>
  'Name:\tfps game\nPid:\t2468\nUid:\t' + [uid, uid, uid, uid].join('\t') + '\n';
const process = command(
  'process',
  ['cat', '/proc/2468/stat'],
  Array.from({ length: 64 }, (_, i) => stat(900, 100 + i * 10)),
);
const uid = command('status', ['cat', '/proc/2468/status'], [status(10123)]);
const proto = (outputs) => ({
  category: 'surface-proto',
  argv: ['-s', deviceId, 'exec-out', 'dumpsys', 'SurfaceFlinger', '--proto'],
  outputs,
});
const latency = (outputs) => ({ category: 'latency', argv: latencyArgv, outputs });
const windowTitle = packageName + '/MainActivity';
const windowLayers = layers([
  { id: 1, name: 'Root#0', parent: -1 },
  { id: 7, name: 'ab12 ' + windowTitle + '#0', parent: 1 },
  { id: 10, name: windowTitle + '$_2468#0', parent: 7, uid: 10123 },
  candidate(),
]);
const windowWitness =
  '  Window #0 Window{ab12 u0 ' +
  windowTitle +
  '}:\n' +
  '    mSession=Session{cafe 2468:u0a10123}\n    mOwnerUid=10123 package=' +
  packageName +
  '\n' +
  '    mAppDied=false\n    mViewVisibility=0x0\n    mHasSurface=true isReadyForDisplay()=true\n' +
  '      mSurface=Surface(name=' +
  windowTitle +
  '$_2468)/@0x1234\n' +
  '      mDrawState=HAS_DRAWN mLastHidden=false\n    isOnScreen=true\n    isVisible=true\n';
const windowCommand = (outputs) =>
  command('window-owner', ['dumpsys', 'window', 'windows'], outputs);

const count = { frame_window: { frames: 3, min_duration_ms: 80, max_duration_ms: 60000 } },
  missing = { fps: null };
function scenario(id, title, protoOutputs, expected = missing, custom = []) {
  const replacements = new Map(custom.map((spec) => [spec.category, spec]));
  const specs = [process, uid, proto(protoOutputs), latency(alternate(before, after))].map(
    (spec) => replacements.get(spec.category) ?? spec,
  );
  return { id, title, kind: 'sample', expected: [expected], commands: specs };
}
export const contract = {
  frozen: true,
  source: [
    'https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-11.0.0_r1/services/core/java/com/android/server/wm/WindowState.java',
    'https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-11.0.0_r1/services/core/java/com/android/server/wm/WindowSurfaceController.java',
    'https://android.googlesource.com/platform/frameworks/native/+/refs/tags/android-12.0.0_r1/services/surfaceflinger/layerproto/layers.proto',
    'https://android.googlesource.com/platform/external/perfetto/+/refs/heads/main/protos/perfetto/trace/android/surfaceflinger_layers.proto',
  ],
  route: ['exec-out', 'dumpsys', 'SurfaceFlinger', '--proto'],
  schema: {
    bare_layers: 1,
    layer_id: 1,
    name: 2,
    parent: 25,
    metadata: 42,
    owner_uid: 53,
    metadata_key: 1,
    metadata_bytes: 2,
    owner_uid_key: 1,
    owner_pid_key: 6,
    metadata_integer: 'int32_le',
    wrapper_magic_fixed64: '4c59525452414345',
    wrapper_entry: 2,
    snapshot_layers: 3,
  },
  shared: [
    {
      category: 'discover',
      argv: ['devices', '-l'],
      outputs: [
        'List of devices attached\nfps-0001 device product:golden model:FPS黄金设备 transport_id:1\n',
      ],
    },
    { category: 'sdk', argv: quotedShell(['getprop', 'ro.build.version.sdk']), outputs: ['30\n'] },
    command('pid', ['pidof', '-s', packageName], ['2468\n']),
    command(
      'memory',
      ['dumpsys', 'meminfo', '-s', '2468'],
      ['** MEMINFO in pid 2468 [' + packageName + '] **\nTOTAL PSS: 2048 TOTAL RSS: 4096\n'],
    ),
    command(
      'system',
      ['cat', '/proc/stat'],
      Array.from(
        { length: 64 },
        (_, i) => 'cpu ' + (10000 + i * 100) + ' 0 0 1000\ncpu0 1 0 0 1\ncpu1 1 0 0 1\n',
      ),
    ),
    command('uevent', ['cat', '/sys/class/power_supply/battery/uevent'], ['']),
    command(
      'battery',
      ['dumpsys', 'battery'],
      ['Current Battery Service state:\n  (UPDATES STOPPED -- use reset to restart)\n'],
    ),
    command('thermal', ['dumpsys', 'thermalservice'], ['HAL Ready: false\n']),
  ],
  cases: [
    {
      ...scenario(
        'android11-window',
        'Android11精确Window Session身份与数值SF父链展示计数',
        [windowLayers],
        count,
      ),
      commands: [
        process,
        uid,
        proto([windowLayers]),
        windowCommand([windowWitness]),
        latency(alternate(before, after)),
      ],
    },
    {
      ...scenario('android11-other-pid', 'Android11同UID其他Session PID不能桥接FPS', [
        windowLayers,
      ]),
      commands: [
        process,
        uid,
        proto([windowLayers]),
        windowCommand([windowWitness.replace('2468:u0a10123', '2470:u0a10123')]),
        latency(alternate(before, after)),
      ],
    },
    scenario('valid-bare', '裸LayersProto真实父链PID/UID归属与新展示3帧', [valid], count),
    scenario(
      'valid-wrapper',
      '精确magic的单snapshot包装身份与同窗口展示计数',
      [wrapped([root(), candidate()])],
      count,
    ),
    scenario('initial-status-unavailable', '初始进程status不可用只缺FPS不补0', [valid], missing, [
      command('status', ['cat', '/proc/2468/status'], ['']),
    ]),
    scenario('unknown-owner', '同名层缺metadata身份不得当作游戏FPS', [
      layers([{ id: 10, name: '未知父层', parent: -1, ownerUid: 1000 }, candidate()]),
    ]),
    scenario('wrong-pid', '父链OWNER_PID不符时FPS缺测', [
      layers([root({ pid: 9876 }), candidate()]),
    ]),
    scenario('wrong-uid', '候选creator UID不符时FPS缺测', [
      layers([root(), candidate({ ownerUid: 10124 })]),
    ]),
    scenario('conflicting-chain', '整父链已声明metadata互相冲突时FPS缺测', [
      layers([
        { id: 9, name: '冲突祖先', parent: -1, ownerUid: 1000, uid: 10123, pid: 9999 },
        root({ parent: 9 }),
        candidate(),
      ]),
    ]),
    scenario('multiple-layers', '两有效候选不靠包名猜前台，FPS缺测', [
      layers([root(), candidate(), candidate({ id: 43, name: layerName + '(第二层)' })]),
    ]),
    scenario(
      'changed-chain',
      '前后祖先ID与身份链变化不沿旧层锚计算',
      alternate(valid, layers([root({ id: 11 }), candidate({ parent: 11 })])),
    ),
    scenario(
      'no-new-frame',
      '完整同锚历史在合法采样窗内无新增展示为0FPS',
      [valid],
      { frame_window: { frames: 0, min_duration_ms: 80, max_duration_ms: 60000 } },
      [latency(alternate(before, before))],
    ),
    scenario('lost-anchor', '环形展示窗口丢失原锚时FPS缺测', [valid], missing, [
      latency(alternate(before, snapshot([1016666667, 1033333334, 1050000000]))),
    ]),
    {
      ...scenario('starttime-reused', '采样期间同PID的starttime换代拒绝整样本', [valid]),
      kind: 'failure',
      commands: [
        command('process', ['cat', '/proc/2468/stat'], alternate(stat(900, 100), stat(901, 110))),
        uid,
        proto([valid]),
        latency(alternate(before, after)),
      ],
    },
    {
      ...scenario('uid-reused', '采样期间Uid换代拒绝整样本', [valid]),
      kind: 'failure',
      commands: [
        process,
        command('status', ['cat', '/proc/2468/status'], alternate(status(10123), status(10124))),
        proto([valid]),
        latency(alternate(before, after)),
      ],
    },
    {
      ...scenario('lifecycle', '暂停继续及在途卸载', [valid], count),
      kind: 'lifecycle',
      hold_category: 'surface-proto',
    },
  ],
};
