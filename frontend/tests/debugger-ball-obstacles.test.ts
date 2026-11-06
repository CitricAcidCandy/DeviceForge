import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { ballPosition } from '../../examples/browser-debugger/src/geometry.ts';
import type { Rect } from '../../examples/browser-debugger/src/geometry.ts';

function clearOf(position: { readonly x: number; readonly y: number }, obstacle: Rect) {
  return position.x + 48 + 8 <= obstacle.x || position.x >= obstacle.x + obstacle.width + 8
    || position.y + 48 + 8 <= obstacle.y || position.y >= obstacle.y + obstacle.height + 8;
}

test('调试球避开真实自动化按钮，选最近安全位置且保留八像素间隔', () => {
  const viewport = { width: 1424, height: 805 };
  const button: Rect = { x: 1290, y: 667.921875, width: 94, height: 36 };
  const result = ballPosition(1360, 672, viewport, true, [button]);
  assert.deepEqual(result, { x: 1360, y: 711.921875 });
  assert.ok(clearOf(result, button));
  assert.ok(result.y + 48 <= viewport.height - 40);
});

test('调试球同时避开多个按钮，最近安全位置不受目录顺序影响', () => {
  const viewport = { width: 1424, height: 805 };
  const controls: readonly Rect[] = [
    { x: 1320, y: 400, width: 88, height: 36 },
    { x: 1320, y: 480, width: 88, height: 36 },
  ];
  const result = ballPosition(1360, 430, viewport, true, controls);
  assert.deepEqual(result, { x: 1360, y: 344 });
  assert.ok(controls.every((control) => clearOf(result, control)));
  assert.deepEqual(ballPosition(1360, 430, viewport, true, [...controls].reverse()), result);
});

test('调试球无相交控件时保留原四参数停靠和拖动语义', () => {
  const viewport = { width: 1424, height: 805 };
  for (const snap of [true, false]) {
    const original = ballPosition(1360, 672, viewport, snap);
    assert.deepEqual(ballPosition(1360, 672, viewport, snap, []), original);
    assert.deepEqual(ballPosition(1360, 672, viewport, snap, [
      { x: 300, y: 672, width: 400, height: 36 },
      { x: 1320, y: 300, width: 88, height: 36 },
    ]), original);
  }
});

test('调试球窄窗避让控件后仍在视口并让出底部状态区', () => {
  const viewport = { width: 390, height: 600 };
  const button: Rect = { x: 300, y: 460, width: 74, height: 30 };
  for (const snap of [true, false]) {
    const result = ballPosition(326, 470, viewport, snap, [button]);
    assert.deepEqual(result, { x: 326, y: 498 });
    assert.ok(clearOf(result, button));
    assert.ok(result.x >= 0 && result.x + 48 <= viewport.width);
    assert.ok(result.y >= 0 && result.y + 48 <= viewport.height - 40);
  }
});

test('整条停靠边没有安全空间时有界保留原位置，不越界或反复迁移', () => {
  const viewport = { width: 390, height: 600 };
  const controls: readonly Rect[] = [{ x: 300, y: 0, width: 90, height: 600 }];
  const expected = ballPosition(2000, 4000, viewport, true);
  const first = ballPosition(2000, 4000, viewport, true, controls);
  assert.deepEqual(first, expected);
  assert.deepEqual(ballPosition(first.x, first.y, viewport, true, controls), expected);
  assert.ok(Number.isFinite(first.x) && Number.isFinite(first.y));
});

test('避让目录只读当前横向带中的可见业务控件，不采入调试器自身', async () => {
  const { readBallObstacles } = await import('../../examples/browser-debugger/src/ball-obstacles.ts');
  const page = new JSDOM(`<button id="business">重复点击</button>
    <input id="input" /><button id="elsewhere">其他区域</button>
    <button id="zero">零尺寸</button><button id="hidden" hidden>已隐藏</button>
    <button id="invisible" style="visibility:hidden">不可见</button>
    <div data-deviceforge-debugger><button id="self">打开调试器</button></div>`, { pretendToBeVisual: true });
  try {
    const document = page.window.document;
    Object.defineProperty(page.window, 'innerWidth', { value: 1424 });
    Object.defineProperty(page.window, 'innerHeight', { value: 805 });
    const rectangles: Readonly<Record<string, Rect>> = {
      business: { x: 1290, y: 668, width: 94, height: 36 },
      input: { x: 1340, y: 500, width: 68, height: 36 },
      elsewhere: { x: 300, y: 668, width: 100, height: 36 },
      zero: { x: 1360, y: 550, width: 0, height: 0 },
      hidden: { x: 1360, y: 550, width: 48, height: 36 },
      invisible: { x: 1360, y: 600, width: 48, height: 36 },
      self: { x: 1360, y: 672, width: 48, height: 48 },
    };
    for (const [id, rectangle] of Object.entries(rectangles)) {
      const element = document.getElementById(id);
      assert.ok(element);
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => new page.window.DOMRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height),
      });
    }
    const before = document.body.innerHTML;
    const result = readBallObstacles(document, 1360);
    assert.deepEqual(result, [rectangles.business, rectangles.input]);
    assert.equal(document.body.innerHTML, before, '测量目录不能改动业务DOM');
  } finally { page.window.close(); }
});

test('避让目录纳入同边可见正文与标题，沿原几何让出卡片文字且不改DOM', async () => {
  const { readBallObstacles } = await import('../../examples/browser-debugger/src/ball-obstacles.ts');
  const page = new JSDOM(`<main>
    <h3 id="title">市场插件说明</h3><p id="description">该插件提供完整工作区与调试能力。</p>
    <button id="business">配置插件</button><p id="elsewhere">其他栏文字</p>
    <div hidden><p id="hidden">隐藏页草稿</p></div>
    <div inert><h2 id="inert">失活工作区标题</h2></div>
    <p id="aria" aria-hidden="true">辅助隐藏文字</p>
    <p id="invisible" style="visibility:hidden">不可见文字</p>
    <p id="empty"> \n\t </p>
    <div data-deviceforge-debugger><p id="self">调试器自有说明</p></div>
  </main>`, { pretendToBeVisual: true });
  try {
    const document = page.window.document;
    const viewport = { width: 940, height: 760 };
    Object.defineProperty(page.window, 'innerWidth', { value: viewport.width });
    Object.defineProperty(page.window, 'innerHeight', { value: viewport.height });
    const rectangles: Readonly<Record<string, Rect>> = {
      title: { x: 760, y: 555, width: 164, height: 24 },
      description: { x: 760, y: 610, width: 164, height: 40 },
      business: { x: 870, y: 400, width: 54, height: 30 },
      elsewhere: { x: 100, y: 610, width: 200, height: 40 },
      hidden: { x: 760, y: 0, width: 164, height: 760 },
      inert: { x: 760, y: 0, width: 164, height: 760 },
      aria: { x: 760, y: 0, width: 164, height: 760 },
      invisible: { x: 760, y: 0, width: 164, height: 760 },
      empty: { x: 760, y: 0, width: 164, height: 760 },
      self: { x: 876, y: 0, width: 48, height: 760 },
    };
    for (const [id, rectangle] of Object.entries(rectangles)) {
      const element = document.getElementById(id); assert.ok(element);
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => new page.window.DOMRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height),
      });
    }
    const before = document.body.innerHTML;
    const obstacles = readBallObstacles(document, 876);
    assert.deepEqual(obstacles, [rectangles.title, rectangles.description, rectangles.business],
      '原障碍目录应包含有字正文和标题，排除隐藏/失活/自身/空段落及其他横带');
    const position = ballPosition(876, 620, viewport, true, obstacles);
    assert.deepEqual(position, { x: 876, y: 658 }, '复用原最近安全位置，不另建正文避让规则');
    assert.ok(obstacles.every((obstacle) => clearOf(position, obstacle)));
    assert.ok(position.y + 48 <= viewport.height - 40);
    assert.equal(document.body.innerHTML, before, '只读测量和几何避让不得写业务DOM');
  } finally { page.window.close(); }
});

test('任务结果避让纳入展开pre整矩形和滚动条，折叠及隐藏结果不挤占同侧停靠', async () => {
  const { readBallObstacles } = await import('../../examples/browser-debugger/src/ball-obstacles.ts');
  const page = new JSDOM(`<main>
    <details open><summary>执行结果</summary><pre id="result">{"data":"可滚动的任务原文"}</pre></details>
    <details><summary>未展开</summary><pre id="closed">折叠结果</pre></details>
    <details><details open><pre id="nested">外层折叠的嵌套结果</pre></details></details>
    <div hidden><pre id="hidden">隐藏结果</pre></div>
    <div inert><pre id="inert">失活结果</pre></div>
    <pre id="empty"> \n\t </pre><pre id="elsewhere">其他横带结果</pre>
    <div data-deviceforge-debugger><pre id="self">调试器自有结果</pre></div>
  </main>`, { pretendToBeVisual: true });
  try {
    const document = page.window.document;
    const viewport = { width: 480, height: 760 };
    Object.defineProperty(page.window, 'innerWidth', { value: viewport.width });
    Object.defineProperty(page.window, 'innerHeight', { value: viewport.height });
    const result: Rect = { x: 16, y: 504.7, width: 433, height: 180 };
    const rectangles: Readonly<Record<string, Rect>> = {
      result,
      closed: { x: 16, y: 0, width: 433, height: 760 },
      nested: { x: 16, y: 0, width: 433, height: 760 },
      hidden: { x: 16, y: 0, width: 433, height: 760 },
      inert: { x: 16, y: 0, width: 433, height: 760 },
      empty: { x: 16, y: 0, width: 433, height: 760 },
      elsewhere: { x: 10, y: 504.7, width: 100, height: 180 },
      self: { x: 416, y: 0, width: 48, height: 760 },
    };
    for (const [id, rectangle] of Object.entries(rectangles)) {
      const element = document.getElementById(id); assert.ok(element);
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => new page.window.DOMRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height),
      });
    }
    const before = document.body.innerHTML;
    const obstacles = readBallObstacles(document, 416);
    assert.deepEqual(obstacles, [result], '展开的非空pre按包含滚动条的整矩形采入，折叠祖先等结果排除');
    const initial = { x: 416, y: 650 };
    assert.equal(clearOf(initial, result), false, '夹具必须复现球与实际结果区右下方相交');
    const position = ballPosition(initial.x, initial.y, viewport, true, obstacles);
    assert.deepEqual(position, { x: 416, y: 448.7 });
    assert.ok(clearOf(position, result), '同停靠侧沿原几何给结果和滚动条保留八像素间隔');
    assert.equal(document.body.innerHTML, before, '结果测量不得改业务DOM或滚动状态');
  } finally { page.window.close(); }
});

test('任务结果折叠open变化合并原避让测量，自有details变化不循环且释放撤销', async () => {
  const { watchBallObstacles } = await import('../../examples/browser-debugger/src/ball-obstacles.ts');
  const page = new JSDOM(`<main><details id="business"><summary>任务结果</summary><pre>业务结果</pre></details></main>
    <div data-deviceforge-debugger><details id="self"><summary>技术详情</summary><pre>自有结果</pre></details></div>`,
  { pretendToBeVisual: true });
  const view = page.window, frames = new Map<number, FrameRequestCallback>();
  const business = view.document.getElementById('business'), own = view.document.getElementById('self');
  assert.ok(business instanceof view.HTMLDetailsElement && own instanceof view.HTMLDetailsElement);
  let nextFrame = 0, observations = 0, cancelled = 0;
  view.requestAnimationFrame = (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; };
  view.cancelAnimationFrame = (id) => { if (frames.delete(id)) cancelled++; };
  const flush = () => {
    const ready = [...frames.values()]; frames.clear();
    for (const callback of ready) callback(1);
  };
  const release = watchBallObstacles(view.document, () => { observations++; });
  try {
    flush();
    assert.equal(observations, 1);
    business.open = true; business.open = false; business.open = true;
    await Promise.resolve();
    assert.equal(frames.size, 1, '业务details同批open变化必须合并到原唯一测量帧');
    assert.equal(observations, 1);
    flush();
    assert.equal(observations, 2);
    own.open = true; own.open = false;
    await Promise.resolve();
    assert.equal(frames.size, 0, '调试器内部details开合不能形成测量循环');
    business.open = false;
    await Promise.resolve();
    assert.equal(frames.size, 1);
    release();
    assert.equal(frames.size, 0);
    assert.equal(cancelled, 1);
    business.open = true;
    await Promise.resolve();
    view.document.dispatchEvent(new view.Event('scroll'));
    assert.equal(frames.size, 0, '释放后open变化或滚动不能重新调度');
    assert.equal(observations, 2);
  } finally { release(); page.window.close(); }
});

test('避让观察将目录变更、滚动、缩放合并到一帧，退出撤销监听与待执行帧', async () => {
  const { watchBallObstacles } = await import('../../examples/browser-debugger/src/ball-obstacles.ts');
  const page = new JSDOM('<main><button>业务按钮</button></main>', { pretendToBeVisual: true });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0, observations = 0, disconnects = 0, cancelled = 0;
  const view = page.window;
  view.requestAnimationFrame = (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; };
  view.cancelAnimationFrame = (id) => { if (frames.delete(id)) cancelled++; };
  class Observer extends view.MutationObserver {
    override disconnect() { disconnects++; super.disconnect(); }
  }
  view.MutationObserver = Observer;
  const flush = () => {
    const ready = [...frames.values()];
    frames.clear();
    for (const callback of ready) callback(1);
  };
  const release = watchBallObstacles(view.document, () => { observations++; });
  try {
    flush();
    observations = 0;
    view.document.querySelector('main')?.append(view.document.createElement('button'));
    await Promise.resolve();
    view.document.dispatchEvent(new view.Event('scroll'));
    view.dispatchEvent(new view.Event('resize'));
    assert.equal(observations, 0, '测量必须延后到合并帧');
    assert.equal(frames.size, 1);
    flush();
    assert.equal(observations, 1);
    view.document.dispatchEvent(new view.Event('scroll'));
    assert.equal(frames.size, 1);
    release();
    assert.equal(disconnects, 1);
    assert.equal(cancelled, 1);
    assert.equal(frames.size, 0);
    view.document.querySelector('main')?.append(view.document.createElement('input'));
    await Promise.resolve();
    view.document.dispatchEvent(new view.Event('scroll'));
    view.dispatchEvent(new view.Event('resize'));
    assert.equal(frames.size, 0);
    assert.equal(observations, 1, '退出后不得重新测量或调度');
    release();
    assert.equal(disconnects, 1, '重复释放不重复回收观察器');
  } finally { release(); page.window.close(); }
});

test('业务显隐属性变化合并测量，调试器自身DOM和位置变化不产生观察循环', async () => {
  const { watchBallObstacles } = await import('../../examples/browser-debugger/src/ball-obstacles.ts');
  const page = new JSDOM(`<main><button id="business">业务按钮</button><p id="description">原业务正文</p></main>
    <div data-deviceforge-debugger><button id="ball">调试器</button></div>`, { pretendToBeVisual: true });
  const view = page.window, frames = new Map<number, FrameRequestCallback>();
  const business = view.document.getElementById('business'), ball = view.document.getElementById('ball');
  const description = view.document.getElementById('description');
  assert.ok(business && ball && description);
  const descriptionText = description.firstChild, ownText = ball.firstChild;
  assert.ok(descriptionText instanceof view.Text && ownText instanceof view.Text);
  let nextFrame = 0, observations = 0;
  view.requestAnimationFrame = (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; };
  view.cancelAnimationFrame = (id) => { frames.delete(id); };
  const flush = () => {
    const ready = [...frames.values()];
    frames.clear();
    for (const callback of ready) callback(1);
  };
  const release = watchBallObstacles(view.document, () => {
    observations++;
    ball.style.setProperty('--df-y', `${100 + observations}px`);
  });
  try {
    flush();
    await Promise.resolve();
    assert.equal(observations, 1);
    assert.equal(frames.size, 0, '初次测量后的悬浮球位置更新不能调度下一轮');

    ball.className = 'fixed';
    ball.setAttribute('aria-hidden', 'false');
    ball.append(view.document.createElement('span'));
    await Promise.resolve();
    assert.equal(frames.size, 0, '调试器自身属性和子树变化不触发业务测量');

    business.hidden = true;
    business.className = 'hidden';
    business.style.display = 'none';
    await Promise.resolve();
    assert.equal(frames.size, 1, '同批业务显隐变化仅安排一帧');
    flush();
    await Promise.resolve();
    assert.equal(observations, 2);
    assert.equal(frames.size, 0, '业务测量更新调试球后不形成反馈循环');

    descriptionText.nodeValue = '更新业务正文';
    descriptionText.nodeValue = '再次更新业务正文';
    await Promise.resolve();
    assert.equal(frames.size, 1, '原地更新正文Text应合并安排一帧，不依赖替换DOM节点');
    flush();
    await Promise.resolve();
    assert.equal(observations, 3);
    assert.equal(frames.size, 0);

    ownText.nodeValue = '调试器自有文本更新';
    await Promise.resolve();
    assert.equal(frames.size, 0, '调试器内部Text更新不得形成避让反馈循环');
    assert.equal(observations, 3);
  } finally { release(); page.window.close(); }
});
