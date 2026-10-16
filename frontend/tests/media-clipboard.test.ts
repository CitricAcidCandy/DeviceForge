import assert from 'node:assert/strict';
import test from 'node:test';
import type { MirroringControl } from '../src/features/mirroring-streaming/index.ts';
import { createMediaClipboardControl } from '../src/pages/media/media-clipboard.ts';
import type { MediaClipboardState } from '../src/pages/media/media-clipboard.ts';
import { deferred } from './fixtures.ts';

function fixture(write?: (text: string) => Promise<void>) {
  const sent: MirroringControl[][] = [];
  const writes: string[] = [];
  const states: MediaClipboardState[] = [];
  let active = true;
  let focused = true;
  let identity = 'device:session:1';
  let ownershipRevision: number | null = null;
  const control = createMediaClipboardControl({
    active: () => active,
    focused: () => focused,
    identity: () => identity,
    ownershipRevision: () => ownershipRevision,
    enqueue: (values) => { sent.push([...values]); },
    write: async (text) => {
      writes.push(text);
      await write?.(text);
    },
    changed: (state) => { states.push(state); },
  });
  return {
    control, sent, writes, states,
    setActive: (value: boolean) => { active = value; },
    setFocused: (value: boolean) => { focused = value; },
    setIdentity: (value: string) => { identity = value; },
    setOwnershipRevision: (value: number | null) => { ownershipRevision = value; },
    state: () => states.at(-1),
  };
}

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

test('设备原生菜单复制仅当前控制修订的客户端自动写入，失权与旧修订均丢弃', async () => {
  const creatorA = fixture();
  const sharedControllerB = fixture();
  const viewerC = fixture();
  sharedControllerB.setOwnershipRevision(2);
  sharedControllerB.setFocused(false);
  creatorA.control.receive('原生菜单选择的文字', 2);
  sharedControllerB.control.receive('原生菜单选择的文字', 2);
  viewerC.control.receive('原生菜单选择的文字', 2);
  await settled();
  assert.deepEqual(creatorA.writes, []);
  assert.deepEqual(viewerC.writes, []);
  assert.deepEqual(sharedControllerB.writes, ['原生菜单选择的文字']);
  sharedControllerB.setOwnershipRevision(null);
  sharedControllerB.control.reset();
  sharedControllerB.control.receive('失权后的迟到正文', 2);
  creatorA.setOwnershipRevision(3);
  creatorA.control.receive('旧控制修订正文', 2);
  creatorA.control.receive('新控制者原生复制', 3);
  await settled();
  assert.deepEqual(creatorA.writes, ['新控制者原生复制']);
  assert.deepEqual(sharedControllerB.writes, ['原生菜单选择的文字']);
  assert.equal(sharedControllerB.state()?.text, null);
  for (const viewer of [creatorA, sharedControllerB, viewerC]) viewer.control.dispose();
});

test('控制修订已确认时复制不依赖旧协议回包凭证，重复同文复制不会耗尽旧请求队列', async () => {
  const setup = fixture();
  setup.setOwnershipRevision(1);
  for (let index = 0; index < 257; index++) assert.equal(setup.control.copySelection(), true);
  assert.equal(setup.sent.length, 257);
  setup.control.receive('已知控制修订收到正文', 1);
  await settled();
  assert.deepEqual(setup.writes, ['已知控制修订收到正文']);
  setup.control.receive('不得接受遗漏修订的正文');
  await settled();
  assert.deepEqual(setup.writes, ['已知控制修订收到正文']);
  setup.control.dispose();
});

test('两名独立观看者仅触发复制的一方写入电脑，无请求回传不获得写入凭证', async () => {
  const viewerA = fixture();
  const viewerB = fixture();
  assert.equal(viewerA.control.shortcut('copy'), true);
  assert.deepEqual(viewerA.sent, [[{ type: 'get_clipboard', copy_key: 'copy' }]]);
  assert.deepEqual(viewerB.sent, []);
  viewerA.control.receive('设备选择的文字');
  viewerB.control.receive('设备选择的文字');
  await settled();
  assert.deepEqual(viewerA.writes, ['设备选择的文字']);
  assert.deepEqual(viewerB.writes, []);
  await viewerB.control.copyToComputer();
  assert.deepEqual(viewerB.writes, []);
  assert.equal(viewerB.state()?.text ?? null, null);
  viewerA.control.dispose();
  viewerB.control.dispose();
});

test('有控制权的分享接收者与创建者分别复制时只写本人剪贴板，只读接收者不发送或接收', async () => {
  const creatorA = fixture();
  const sharedControllerB = fixture();
  const readOnlyViewerC = fixture();
  readOnlyViewerC.setActive(false);
  assert.equal(sharedControllerB.control.shortcut('copy'), true);
  for (const viewer of [creatorA, sharedControllerB, readOnlyViewerC]) {
    viewer.control.receive('分享接收者选择的文字');
  }
  await settled();
  assert.deepEqual(sharedControllerB.writes, ['分享接收者选择的文字']);
  assert.deepEqual(creatorA.writes, []);
  assert.deepEqual(readOnlyViewerC.writes, []);
  assert.equal(creatorA.state()?.text ?? null, null);
  assert.equal(readOnlyViewerC.state()?.text ?? null, null);
  assert.equal(creatorA.control.shortcut('cut'), true);
  for (const viewer of [creatorA, sharedControllerB, readOnlyViewerC]) {
    viewer.control.receive('创建者选择的文字');
  }
  await settled();
  assert.deepEqual(creatorA.writes, ['创建者选择的文字']);
  assert.deepEqual(sharedControllerB.writes, ['分享接收者选择的文字']);
  assert.equal(sharedControllerB.state()?.text, '分享接收者选择的文字');
  assert.equal(readOnlyViewerC.control.shortcut('copy'), false);
  assert.equal(readOnlyViewerC.control.shortcut('cut'), false);
  await readOnlyViewerC.control.copyToComputer();
  assert.deepEqual(creatorA.sent, [[{ type: 'get_clipboard', copy_key: 'cut' }]]);
  assert.deepEqual(sharedControllerB.sent, [[{ type: 'get_clipboard', copy_key: 'copy' }]]);
  assert.deepEqual(readOnlyViewerC.sent, []);
  assert.deepEqual(readOnlyViewerC.writes, []);
  assert.equal(readOnlyViewerC.state()?.text ?? null, null);
  for (const viewer of [creatorA, sharedControllerB, readOnlyViewerC]) viewer.control.dispose();
});

test('分享接收者点击复制按钮使画面失焦后仍只写本人剪贴板，失效和销毁拒绝按钮请求', async () => {
  const creatorA = fixture();
  const sharedControllerB = fixture();
  const readOnlyViewerC = fixture();
  sharedControllerB.setFocused(false);
  readOnlyViewerC.setActive(false);
  assert.equal(sharedControllerB.control.copySelection(), true);
  assert.equal(readOnlyViewerC.control.copySelection(), false);
  creatorA.control.receive('分享接收者点击复制的文字');
  sharedControllerB.control.receive('分享接收者点击复制的文字');
  readOnlyViewerC.control.receive('分享接收者点击复制的文字');
  await settled();
  assert.deepEqual(sharedControllerB.writes, ['分享接收者点击复制的文字']);
  assert.deepEqual(sharedControllerB.sent, [[{ type: 'get_clipboard', copy_key: 'copy' }]]);
  assert.deepEqual(creatorA.writes, []);
  assert.deepEqual(creatorA.sent, []);
  assert.equal(creatorA.state()?.text ?? null, null);
  assert.deepEqual(readOnlyViewerC.writes, []);
  assert.deepEqual(readOnlyViewerC.sent, []);
  sharedControllerB.control.dispose();
  assert.equal(sharedControllerB.control.copySelection(), false);
  assert.equal(sharedControllerB.sent.length, 1);
  creatorA.control.dispose();
  readOnlyViewerC.control.dispose();
});

test('快捷键和复制按钮共用请求顺序，画面失焦时仅按钮对应回包自动写入', async () => {
  const setup = fixture();
  assert.equal(setup.control.shortcut('copy'), true);
  setup.setFocused(false);
  assert.equal(setup.control.copySelection(), true);
  setup.control.receive('快捷键请求的文字');
  await settled();
  assert.deepEqual(setup.writes, []);
  assert.equal(setup.state()?.text, '快捷键请求的文字');
  setup.control.receive('按钮请求的文字');
  await settled();
  assert.deepEqual(setup.writes, ['按钮请求的文字']);
  assert.equal(setup.state()?.text, '按钮请求的文字');
  assert.deepEqual(setup.sent, [
    [{ type: 'get_clipboard', copy_key: 'copy' }],
    [{ type: 'get_clipboard', copy_key: 'copy' }],
  ]);
  setup.control.receive('没有请求的回包');
  await settled();
  assert.deepEqual(setup.writes, ['按钮请求的文字']);
  assert.equal(setup.state()?.text, '按钮请求的文字');
  setup.control.dispose();
});

test('同一文本重复复制和剪切分别消费本人请求，额外回包不会重复写入', async () => {
  const setup = fixture();
  const actions: readonly ('copy' | 'cut')[] = ['copy', 'copy', 'cut'];
  for (const action of actions) {
    assert.equal(setup.control.shortcut(action), true);
    setup.control.receive('相同的文字');
    await settled();
  }
  assert.deepEqual(setup.sent, [
    [{ type: 'get_clipboard', copy_key: 'copy' }],
    [{ type: 'get_clipboard', copy_key: 'copy' }],
    [{ type: 'get_clipboard', copy_key: 'cut' }],
  ]);
  assert.deepEqual(setup.writes, ['相同的文字', '相同的文字', '相同的文字']);
  setup.control.receive('没有新请求的正文');
  await settled();
  assert.equal(setup.writes.length, 3);
  assert.equal(setup.state()?.text, '相同的文字');
  setup.control.dispose();
});

test('多个本人请求逐个消费回包，待回传请求数保持有界', async () => {
  const setup = fixture();
  setup.control.shortcut('copy');
  setup.control.shortcut('cut');
  setup.control.receive('相同正文');
  await settled();
  setup.control.receive('相同正文');
  await settled();
  setup.control.receive('超过本人请求数的回包');
  await settled();
  assert.deepEqual(setup.writes, ['相同正文', '相同正文']);
  assert.equal(setup.state()?.text, '相同正文');
  setup.control.dispose();
  const bounded = fixture();
  for (let index = 0; index < 257; index++) bounded.control.shortcut('copy');
  assert.equal(bounded.sent.length, 256);
  bounded.control.reset();
  bounded.control.receive('重置前请求的回包');
  await settled();
  assert.deepEqual(bounded.writes, []);
  bounded.control.dispose();
});

test('本人复制请求在失焦后回包只保留可手动复制的正文', async () => {
  const setup = fixture();
  setup.control.shortcut('copy');
  setup.setFocused(false);
  setup.control.receive('本人发起的复制');
  await settled();
  assert.deepEqual(setup.writes, []);
  assert.equal(setup.state()?.text, '本人发起的复制');
  await setup.control.copyToComputer();
  assert.deepEqual(setup.writes, ['本人发起的复制']);
  setup.setFocused(true);
  setup.control.receive('未经本人新请求的回传');
  await settled();
  assert.deepEqual(setup.writes, ['本人发起的复制']);
  setup.control.dispose();
});

test('重置和会话代次变化撤销未完成复制请求，旧回包不写入新会话', async () => {
  for (const change of ['reset', 'identity']) {
    const setup = fixture();
    setup.control.shortcut('copy');
    if (change === 'reset') setup.control.reset();
    else setup.setIdentity('device:session:2');
    setup.control.receive('旧会话文字');
    await settled();
    assert.deepEqual(setup.writes, []);
    assert.equal(setup.state()?.text ?? null, null);
    setup.control.shortcut('cut');
    setup.control.receive('新请求文字');
    await settled();
    assert.deepEqual(setup.writes, ['新请求文字']);
    setup.control.dispose();
  }
});

test('停止或销毁后不发送输入，已排队的剪贴板写入也不重新启动', async () => {
  const setup = fixture();
  setup.control.shortcut('copy');
  setup.control.receive('排队中的文字');
  setup.control.dispose();
  await settled();
  setup.control.receive('销毁后的回包');
  assert.equal(setup.control.shortcut('copy'), false);
  assert.equal(setup.control.paste('电脑文字'), false);
  await setup.control.copyToComputer();
  assert.deepEqual(setup.writes, []);
  assert.equal(setup.sent.length, 1);
  const inactive = fixture();
  inactive.setActive(false);
  assert.equal(inactive.control.shortcut('copy'), false);
  assert.equal(inactive.control.paste('电脑文字'), false);
  inactive.control.receive('停止时的回传');
  await settled();
  assert.deepEqual(inactive.sent, []);
  assert.deepEqual(inactive.writes, []);
  inactive.control.dispose();
});

test('浏览器写入失败保留本人正文供手动降级，不恢复已消费的请求', async () => {
  let denied = true;
  const setup = fixture(async () => {
    if (denied) throw new Error('浏览器拒绝写入');
  });
  setup.control.shortcut('copy');
  setup.control.receive('权限拒绝后仍能手动复制');
  await settled();
  assert.deepEqual(setup.writes, ['权限拒绝后仍能手动复制']);
  assert.equal(setup.state()?.text, '权限拒绝后仍能手动复制');
  assert.match(setup.state()?.message ?? '', /复制到电脑|选中文字复制/);
  setup.control.receive('无请求回包不得替换降级内容');
  await settled();
  assert.equal(setup.state()?.text, '权限拒绝后仍能手动复制');
  denied = false;
  await setup.control.copyToComputer();
  assert.deepEqual(setup.writes, ['权限拒绝后仍能手动复制', '权限拒绝后仍能手动复制']);
  assert.match(setup.state()?.message ?? '', /已同步/);
  setup.control.dispose();
});

test('电脑粘贴保持原文与字节上限，不登记设备回传请求或截断文本', async () => {
  const setup = fixture();
  assert.equal(setup.control.shortcut('paste'), false);
  assert.equal(setup.control.paste('中文🙂\n第二行'), true);
  assert.equal(setup.control.paste(''), true);
  assert.deepEqual(setup.sent, [
    [{ type: 'clipboard', text: '中文🙂\n第二行', paste: true }],
    [{ type: 'clipboard', text: '', paste: true }],
  ]);
  setup.control.receive('粘贴操作不允许冒用复制回包');
  await settled();
  assert.deepEqual(setup.writes, []);
  for (const value of ['a'.repeat(2049), '中'.repeat(683), '\0', '\ud800']) {
    assert.equal(setup.control.paste(value), true);
    assert.equal(setup.sent.length, 2);
    assert.match(setup.state()?.message ?? '', /2048|有效文字/);
  }
  setup.control.dispose();
});

test('空剪贴板仍是有效请求结果，切代会撤销尚未开始的异步写入', async () => {
  const empty = fixture();
  empty.control.shortcut('copy');
  empty.control.receive('');
  await settled();
  assert.deepEqual(empty.writes, ['']);
  empty.control.dispose();
  const blocked = deferred<void>();
  const setup = fixture(async () => blocked.promise);
  setup.control.shortcut('copy');
  setup.control.receive('先开始的写入');
  await settled();
  assert.deepEqual(setup.writes, ['先开始的写入']);
  setup.control.shortcut('copy');
  setup.control.receive('尚未开始的写入');
  setup.setIdentity('device:session:2');
  setup.control.reset();
  blocked.resolve();
  await settled();
  assert.deepEqual(setup.writes, ['先开始的写入']);
  assert.equal(setup.state()?.text, null);
  setup.control.dispose();
});
