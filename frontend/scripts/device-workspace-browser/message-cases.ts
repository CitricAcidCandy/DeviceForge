import assert from 'node:assert/strict';

interface BrowserChecks {
  evaluate(expression: string): Promise<unknown>;
  wait(expression: string, name: string): Promise<void>;
  click(name: string, scope?: string): Promise<void>;
  capture(name: string, width: number, height: number): Promise<void>;
  check(name: string, action: () => Promise<unknown>): Promise<void>;
}

// 全部行为消费真实 App 和消息根；网络等待仅由受控设备夹具控制。
export async function runMessageCases(browser: BrowserChecks) {
  const { evaluate, wait, click, capture, check } = browser;
  await check('目录读取成功通过顶部消息展示并可关闭', async () => {
    await evaluate('window.__harness.clearMessages()');
    await click('读取目录');
    await wait('document.querySelector("[data-message-kind=success]")?.textContent.includes("设备目录已更新")', '顶部成功提示');
    assert.equal(await evaluate('document.querySelector("[data-message-kind=success]").closest("[data-global-message-root]")!==null'), true);
    await capture('message-success', 1536, 1024);
    await click('关闭消息', '[data-global-message-root]');
    await wait('window.__harness.messages().length===0', '关闭成功提示');
  });
  await check('顶部全局等待消息可取消且忽略晚到发现结果', async () => {
    await evaluate('window.__harness.clearMessages();window.__harness.holdDiscovery(true)');
    await click('重新发现 fixture.first');
    await wait('window.__harness.pendingDiscovery()===1&&document.querySelector("[data-message-kind=loading]")!==null', '顶部等待提示');
    assert.equal(await evaluate('document.querySelectorAll("[data-global-message-root]").length'), 1);
    assert.equal(await evaluate('document.querySelector("[data-global-message-root]").getBoundingClientRect().top<100'), true);
    await capture('message-loading', 1536, 1024);
    await click('取消等待', '[data-global-message-root]');
    await wait('!window.__harness.messages().some(item=>item.level==="loading")', '取消消息');
    await evaluate('window.__harness.releaseDiscovery()');
    await new Promise<void>((done) => setTimeout(done, 160));
    assert.equal(await evaluate('window.__harness.messages().some(item=>item.level==="error"||item.level==="success")'), false);
  });
  await check('顶部错误详情保留日志 ID，复制失败显示全局提示', async () => {
    await evaluate('window.__harness.clearMessages();window.__harness.failDiscovery(true)');
    await click('重新发现 fixture.first');
    await wait('document.querySelector("[data-message-kind=error]")!==null', '顶部错误提示');
    assert.equal(await evaluate('document.querySelectorAll(".device-page-feedback,.device-discovery-report").length'), 0);
    assert.equal(await evaluate('(() => {const summary=document.querySelector("[data-message-kind=error] [data-message-details] summary");if(!summary)return false;summary.click();return true;})()'), true);
    await wait('document.querySelector("[data-message-kind=error] [data-message-details]")?.open', '错误诊断详情');
    assert.equal(await evaluate('document.querySelector("[data-message-kind=error]").textContent.includes("device-workspace-fixture-log")'), true);
    await capture('message-error-details', 1536, 1024);
    await evaluate('window.__clipboardDescriptor=Object.getOwnPropertyDescriptor(navigator,"clipboard");Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:()=>Promise.reject(new Error("受控剪贴板拒绝"))}})');
    try {
      await click('复制消息日志 ID', '[data-message-kind=error]');
      await wait('window.__harness.messages().some(item=>item.title==="复制失败，请手动选择日志 ID")', '复制失败提示');
      await capture('message-mobile', 390, 844);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll("[data-message-id]")].every(item=>{const r=item.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})'), true);
    } finally {
      await evaluate('if(window.__clipboardDescriptor)Object.defineProperty(navigator,"clipboard",window.__clipboardDescriptor);else delete navigator.clipboard;delete window.__clipboardDescriptor;window.__harness.failDiscovery(false);window.__harness.clearMessages()');
    }
  });
  await check('不同路由消费同一全局消息实例和展示根', async () => {
    await evaluate('window.__harness.clearMessages();window.__harness.publishMessage("跨路由共享消息");window.__messageRoot=document.querySelector("[data-global-message-root]");location.hash="tasks"');
    await wait('document.querySelector("[data-route=tasks]")?.hidden===false', '任务路由');
    assert.equal(await evaluate('document.querySelectorAll("[data-global-message-root]").length===1&&document.querySelector("[data-global-message-root]")===window.__messageRoot&&window.__harness.messages().filter(item=>item.id==="route-message-probe").length===1'), true);
    await evaluate('location.hash="devices"');
    await wait('document.querySelector("[data-route=devices]")?.hidden===false', '设备路由');
    assert.equal(await evaluate('document.querySelector("[data-global-message-root]")===window.__messageRoot'), true);
    await evaluate('window.__harness.clearMessages();delete window.__messageRoot');
  });
}

export async function checkDisposedMessages(browser: BrowserChecks) {
  const { evaluate, wait, click, check } = browser;
  await evaluate('location.hash="devices"');
  await wait('document.querySelector("[data-route=devices]")?.hidden===false', '销毁前设备路由');
  await check('实例销毁与晚到响应不留下旧全局消息', async () => {
    await evaluate('window.__harness.clearMessages();window.__harness.holdDiscovery(true)');
    await click('重新发现 fixture.first');
    await wait('window.__harness.pendingDiscovery()===1', '销毁前等待');
    const result = await evaluate('window.__harness.disposeWithLateDiscovery()');
    assert.deepEqual(result, { messages: [], pending: 0 });
    assert.equal(await evaluate('document.querySelectorAll("[data-global-message-root],[data-message-id]").length'), 0);
    return result;
  });
}
