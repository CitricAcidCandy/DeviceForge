import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { ComponentProps } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import type { MarketplaceUploadDialog } from '../src/pages/marketplace/components/MarketplaceUploadDialog/index.tsx';
import type {
  ReleasePublicationPlan,
  ReleasePublicationProgress,
  ReleasePublicationResult,
} from '../src/pages/marketplace/release-publication/index.ts';
import { createMarketplace } from '../src/features/marketplace/services/index.ts';
import { deferred } from './fixtures.ts';

type UploadProps = ComponentProps<typeof MarketplaceUploadDialog>;
function uploadModule(
  value: unknown,
): value is { MarketplaceUploadDialog: typeof MarketplaceUploadDialog } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'MarketplaceUploadDialog' in value &&
    typeof value.MarketplaceUploadDialog === 'function'
  );
}

function planFor(file: File): ReleasePublicationPlan {
  return {
    file,
    manifest: {
      format_version: 1,
      host_api_version: 2,
      id: 'demo-feature',
      version: '1.2.0',
      name: '设备分析完整插件',
      description: '一次发布服务器组件与设备工具',
      components: [
        {
          id: 'demo-server',
          kind: 'server',
          version: '1.2.0',
          variants: [
            {
              platform: 'windows-x64',
              path: 'components/server.zip',
              format: 'zip',
              sha256: 'a'.repeat(64),
              size: 3,
            },
          ],
        },
      ],
      tools: [
        {
          id: 'helper',
          version: '2.0.0',
          required: true,
          variants: [
            {
              platform: 'windows-x64',
              path: 'tools/helper.zip',
              format: 'zip',
              sha256: 'b'.repeat(64),
              size: 2,
              entries: { bin: 'helper.exe' },
            },
          ],
          bindings: [{ component_id: 'demo-server', config_pointer: '/helper', entry: 'bin' }],
        },
      ],
      requirements: [
        {
          component_id: 'demo-server',
          config_pointer: '/api_key',
          any_of: ['/api_key_file'],
          title: '服务密钥',
          description: '由安装者填写自己的服务密钥',
          required: true,
          sensitive: true,
        },
      ],
    },
    resources: [
      { path: 'components/server.zip', sha256: 'a'.repeat(64), size: 3, blob: new Blob(['zip']) },
      { path: 'tools/helper.zip', sha256: 'b'.repeat(64), size: 2, blob: new Blob(['ok']) },
    ],
    manifestSha256: 'c'.repeat(64),
    manifestBlob: new Blob(['{}']),
    totalResourceBytes: 5,
  };
}

const published: ReleasePublicationResult = {
  resourceCount: 2,
  reusedCount: 1,
  manifestSha256: 'd'.repeat(64),
  source: 'http://market.example',
};
const progressing: ReleasePublicationProgress = {
  stage: 'catalog',
  completedResources: 2,
  totalResources: 2,
  completedBytes: 5,
  totalBytes: 5,
};

async function fixture() {
  const browser = new JSDOM(
    '<!doctype html><html><body><main id="release-ui"></main></body></html>',
    {
      url: 'http://localhost:5173',
      pretendToBeVisual: true,
    },
  );
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef,
    document: windowRef.document,
    navigator: windowRef.navigator,
    Element: windowRef.Element,
    HTMLElement: windowRef.HTMLElement,
    Node: windowRef.Node,
    DocumentFragment: windowRef.DocumentFragment,
    NodeFilter: windowRef.NodeFilter,
    HTMLInputElement: windowRef.HTMLInputElement,
    HTMLTextAreaElement: windowRef.HTMLTextAreaElement,
    HTMLFormElement: windowRef.HTMLFormElement,
    HTMLButtonElement: windowRef.HTMLButtonElement,
    HTMLSelectElement: windowRef.HTMLSelectElement,
    MutationObserver: windowRef.MutationObserver,
    Event: windowRef.Event,
    CustomEvent: windowRef.CustomEvent,
    FocusEvent: windowRef.FocusEvent,
    KeyboardEvent: windowRef.KeyboardEvent,
    MouseEvent: windowRef.MouseEvent,
    PointerEvent: windowRef.MouseEvent,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const server = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    plugins: [
      {
        name: '完整发布界面端口隔离',
        enforce: 'pre',
        resolveId(source) {
          if (source.endsWith('/release-publication/index.ts'))
            return '\0release-publication-ui-ports';
          return null;
        },
        load(id) {
          if (id !== '\0release-publication-ui-ports') return null;
          // 界面测试必须显式注入执行器，默认调用直接失败，防止误发真实市场请求。
          return `export async function prepareReleasePublication() { throw new Error('界面回归未注入检查器'); }
          export async function publishReleasePublication() { throw new Error('界面回归未注入发布器'); }`;
        },
      },
    ],
  });
  const target = windowRef.document.getElementById('release-ui');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const loaded: unknown = await server.ssrLoadModule(
    '/src/pages/marketplace/components/MarketplaceUploadDialog/index.tsx',
  );
  assert.ok(uploadModule(loaded));
  const marketplace = createMarketplace(async () => {
    throw new Error('此 UI 回归不应发送真实网络请求');
  });
  marketplace.setUrl('http://market.example');
  let generation = 0;
  function button(label: string) {
    const control = [...windowRef.document.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label,
    );
    assert.ok(control, `缺少按钮：${label}`);
    return control;
  }
  return {
    document: windowRef.document,
    windowRef,
    marketplace,
    text: () => windowRef.document.querySelector('[role="dialog"]')?.textContent ?? '',
    button,
    render: async (props: Partial<UploadProps> = {}, fresh = false) => {
      if (fresh) generation++;
      await act(async () =>
        root.render(
          createElement(loaded.MarketplaceUploadDialog, {
            key: generation,
            open: true,
            onOpenChange() {},
            marketplace,
            onPublished() {},
            prepareRelease: async (file) => planFor(file),
            publishRelease: async () => published,
            ...props,
          }),
        ),
      );
    },
    click: async (label: string) => {
      await act(async () => button(label).click());
    },
    choose: async (name = 'feature.zip') => {
      const input = windowRef.document.querySelector('input[type="file"]:not([webkitdirectory])');
      assert.ok(input instanceof windowRef.HTMLInputElement);
      const file = new File(['zip'], name, { type: 'application/zip' });
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: {
          length: 1,
          item: (index: number) => (index === 0 ? file : null),
          [Symbol.iterator]: () => [file].values(),
        },
      });
      await act(async () => input.dispatchEvent(new windowRef.Event('change', { bubbles: true })));
    },
    fill: async (label: string, value: string) => {
      const element = [...windowRef.document.querySelectorAll('label')].find((node) =>
        node.textContent?.trim().startsWith(label),
      );
      assert.ok(element, `缺少字段：${label}`);
      const input = windowRef.document.getElementById(element.htmlFor);
      assert.ok(
        input instanceof windowRef.HTMLInputElement ||
          input instanceof windowRef.HTMLTextAreaElement,
      );
      const prototype =
        input instanceof windowRef.HTMLInputElement
          ? windowRef.HTMLInputElement.prototype
          : windowRef.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      assert.ok(setter);
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
      });
    },
    detach: async () => {
      await act(async () => root.render(null));
    },
    close: async () => {
      await act(async () => root.unmount());
      await server.close();
      windowRef.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('完整功能插件网页发布交互与取消保护', async (context) => {
  const browser = await fixture();
  try {
    await context.test('默认完整发布，兼容入口可切换，重新打开恢复默认', async () => {
      await browser.render({}, true);
      assert.equal(browser.button('完整功能插件').getAttribute('aria-pressed'), 'true');
      assert.match(browser.text(), /先上传依赖.*一个市场卡片/);
      await browser.click('独立组件或其他资源');
      assert.match(browser.text(), /上传资源并发布/);
      assert.equal(browser.button('独立组件或其他资源').getAttribute('aria-pressed'), 'true');
      await browser.render({ open: false });
      await browser.render();
      assert.equal(browser.button('完整功能插件').getAttribute('aria-pressed'), 'true');
      assert.match(browser.text(), /选择完整功能插件 ZIP/);
    });

    await context.test(
      '检查后展示清单身份、组件工具、用户输入与摘要，发布调用保留身份',
      async () => {
        let publications = 0;
        let refreshed = 0;
        await browser.render(
          {
            onPublished() {
              refreshed++;
            },
            publishRelease: async (plan, metadata, marketplace, signal, onProgress) => {
              publications++;
              assert.equal(signal.aborted, false);
              assert.equal(marketplace, browser.marketplace);
              assert.equal(metadata.id, plan.manifest.id);
              assert.equal(metadata.version, plan.manifest.version);
              assert.equal(metadata.name, plan.manifest.name);
              assert.equal(metadata.description, plan.manifest.description);
              assert.equal(metadata.summary, '市场展示简介');
              assert.equal(metadata.author, '插件作者');
              assert.equal(metadata.license, 'Apache-2.0');
              assert.equal(metadata.details.release_format_version, 1);
              onProgress?.(progressing);
              return published;
            },
          },
          true,
        );
        await browser.click('检查完整 ZIP');
        assert.match(browser.document.querySelector('[role="alert"]')?.textContent ?? '', /先选择/);
        await browser.choose();
        assert.equal(browser.document.querySelector('[role="alert"]'), null);
        await browser.click('检查完整 ZIP');
        assert.match(browser.text(), /设备分析完整插件/);
        assert.match(browser.text(), /demo-feature/);
        assert.match(browser.text(), /服务器组件 · demo-server/);
        assert.match(browser.text(), /helper · 2.0.0 · 必需/);
        assert.match(browser.text(), /服务密钥 · 必填 · 敏感信息/);
        assert.match(browser.text(), /\/api_key_file/);
        assert.match(browser.text(), /2 项 · 5 字节/);
        assert.match(browser.text(), new RegExp('c'.repeat(64)));
        assert.equal(
          browser.document.querySelector('input[value="demo-feature"]'),
          null,
          '发布身份不提供可编辑字段',
        );
        assert.equal(publications, 0);
        await browser.fill('市场简介', '市场展示简介');
        await browser.fill('作者', '插件作者');
        await browser.fill('许可证', 'Apache-2.0');
        await browser.click('确认上传并发布');
        assert.equal(publications, 1);
        assert.equal(refreshed, 1);
        assert.match(browser.text(), /已发布「设备分析完整插件」1.2.0/);
        assert.match(browser.text(), /其中复用 1 项/);
        const steps = browser.document.querySelectorAll(
          'ol[aria-label="完整功能插件发布步骤"] > li',
        );
        assert.equal(steps.length, 3);
        assert.ok([...steps].every((step) => step.getAttribute('data-state') === 'complete'));
        assert.equal(
          browser.document.querySelector(
            'ol[aria-label="完整功能插件发布步骤"] [aria-current="step"]',
          ),
          null,
        );
        const fileInput = browser.document.querySelector('input[type="file"]');
        assert.ok(fileInput instanceof browser.windowRef.HTMLInputElement);
        assert.equal(fileInput.disabled, true);
        assert.equal(browser.button('完成').disabled, false);
      },
    );

    await context.test('校验失败不进入发布，选择新包清空错误，重开清空旧成功', async () => {
      let inspected = 0;
      let publishedCalls = 0;
      await browser.render(
        {
          prepareRelease: async (file) => {
            inspected++;
            if (inspected === 1) throw new Error('组件摘要不一致，停止发布');
            return planFor(file);
          },
          publishRelease: async () => {
            publishedCalls++;
            return published;
          },
        },
        true,
      );
      await browser.choose('broken.zip');
      await browser.click('检查完整 ZIP');
      assert.match(
        browser.document.querySelector('[role="alert"]')?.textContent ?? '',
        /组件摘要不一致/,
      );
      assert.equal(
        [...browser.document.querySelectorAll('button')].some(
          (node) => node.textContent?.trim() === '确认上传并发布',
        ),
        false,
      );
      assert.equal(publishedCalls, 0);
      await browser.choose('repaired.zip');
      assert.equal(browser.document.querySelector('[role="alert"]'), null);
      await browser.click('检查完整 ZIP');
      assert.match(browser.text(), /repaired.zip/);
      await browser.render({ open: false });
      await browser.render();
      assert.equal(browser.document.querySelector('.ui-file-selected'), null);
      assert.doesNotMatch(browser.text(), /repaired.zip|已发布「/);
    });

    await context.test('目录提交失败显示真实错误与可复用边界，不通知成功', async () => {
      let refreshed = 0;
      await browser.render(
        {
          onPublished() {
            refreshed++;
          },
          publishRelease: async (_plan, _metadata, _marketplace, _signal, onProgress) => {
            onProgress?.(progressing);
            throw Object.assign(new Error('市场目录提交失败'), { logId: 'catalog-failed-log' });
          },
        },
        true,
      );
      await browser.choose();
      await browser.click('检查完整 ZIP');
      await browser.click('确认上传并发布');
      assert.equal(refreshed, 0);
      assert.match(
        browser.document.querySelector('[role="alert"]')?.textContent ?? '',
        /市场目录提交失败.*catalog-failed-log/,
      );
      assert.match(browser.text(), /已上传资源可在重试时复用/);
      assert.match(browser.text(), /请先刷新目录确认/);
      assert.doesNotMatch(browser.text(), /已发布「/);
      assert.equal(browser.button('确认上传并发布').disabled, false);
      await browser.fill('市场简介', '重新检查元数据');
      assert.equal(browser.document.querySelector('[role="alert"]'), null);
      assert.doesNotMatch(browser.text(), /已上传资源可在重试时复用/);
    });

    await context.test('市场资料无效时不调用发布器，修正后连续点击只提交一次', async () => {
      const waiting = deferred<ReleasePublicationResult>();
      let calls = 0;
      await browser.render(
        {
          publishRelease: async () => {
            calls++;
            return waiting.promise;
          },
        },
        true,
      );
      await browser.choose();
      await browser.click('检查完整 ZIP');
      await browser.fill('市场简介', '');
      await browser.click('确认上传并发布');
      assert.match(browser.document.querySelector('[role="alert"]')?.textContent ?? '', /简介/);
      assert.equal(calls, 0);
      await browser.fill('市场简介', '恢复有效简介');
      const submit = browser.button('确认上传并发布');
      await act(async () => {
        submit.click();
        submit.click();
      });
      assert.equal(calls, 1);
      assert.equal(
        browser.document.querySelector(
          'ol[aria-label="完整功能插件发布步骤"] [aria-current="step"] .ui-stepper-title',
        )?.textContent,
        '上传并发布',
      );
      await act(async () => {
        waiting.resolve(published);
      });
      assert.match(browser.text(), /已发布「/);
    });

    await context.test('目录已提交后刷新通知失败不改写成功，也不允许重复发布', async () => {
      for (const asynchronous of [false, true]) {
        let calls = 0;
        let refreshed = 0;
        await browser.render(
          {
            onPublished() {
              refreshed++;
              if (asynchronous) return Promise.reject(new Error('异步目录刷新失败'));
              throw new Error('同步目录刷新失败');
            },
            publishRelease: async () => {
              calls++;
              return published;
            },
          },
          true,
        );
        await browser.choose();
        await browser.click('检查完整 ZIP');
        await browser.click('确认上传并发布');
        assert.equal(refreshed, 1);
        assert.equal(calls, 1);
        assert.equal(browser.document.querySelector('[role="alert"]'), null);
        assert.match(browser.text(), /已发布「设备分析完整插件」1.2.0/);
        assert.match(browser.text(), /发布已完成.*请手动刷新市场目录/);
        assert.doesNotMatch(browser.text(), /市场目录提交可能已完成/);
        assert.equal(browser.button('完成').disabled, false);
        assert.equal(
          [...browser.document.querySelectorAll('button')].some(
            (node) => node.textContent?.trim() === '确认上传并发布',
          ),
          false,
        );
      }
    });

    await context.test(
      '目录已提交时不等待刷新才开放完成，关闭后迟到刷新失败不污染新弹窗',
      async () => {
        const refresh = deferred<void>();
        await browser.render({ onPublished: () => refresh.promise }, true);
        await browser.choose('committed.zip');
        await browser.click('检查完整 ZIP');
        await browser.click('确认上传并发布');
        assert.match(browser.text(), /已发布「/);
        assert.equal(browser.button('完成').disabled, false);
        await browser.render({ open: false });
        await browser.render();
        await browser.choose('next.zip');
        await browser.click('检查完整 ZIP');
        await act(async () => {
          refresh.reject(new Error('上轮目录刷新失败'));
        });
        assert.match(browser.text(), /next.zip/);
        assert.doesNotMatch(browser.text(), /已发布「|目录刷新时出现问题/);
        assert.equal(browser.document.querySelector('[role="alert"]'), null);
        assert.equal(browser.button('确认上传并发布').disabled, false);
      },
    );

    await context.test('发布中禁切换和关闭，显式取消后拒绝旧进度及迟到成功', async () => {
      const waiting = deferred<ReleasePublicationResult>();
      let oldSignal: AbortSignal | undefined;
      let oldProgress: ((progress: ReleasePublicationProgress) => void) | undefined;
      let refreshed = 0;
      let closed = 0;
      await browser.render(
        {
          onPublished() {
            refreshed++;
          },
          onOpenChange(open) {
            if (!open) closed++;
          },
          publishRelease: async (_plan, _metadata, _marketplace, signal, onProgress) => {
            oldSignal = signal;
            oldProgress = onProgress;
            onProgress?.({ ...progressing, stage: 'uploading', current: 'tools/helper.zip' });
            return waiting.promise;
          },
        },
        true,
      );
      await browser.choose('first.zip');
      await browser.click('检查完整 ZIP');
      await browser.click('确认上传并发布');
      assert.match(
        browser.document.querySelector('[aria-label="完整发布进度"]')?.textContent ?? '',
        /正在上传组件与工具依赖.*2 \/ 2.*5 \/ 5/,
      );
      assert.equal(browser.button('独立组件或其他资源').disabled, true);
      await act(async () => {
        browser.document.dispatchEvent(
          new browser.windowRef.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      assert.equal(closed, 0);
      await browser.click('取消当前操作');
      assert.equal(oldSignal?.aborted, true);
      assert.match(browser.text(), /已取消当前发布等待/);
      assert.match(browser.text(), /市场目录提交可能已完成/);
      await browser.choose('second.zip');
      assert.doesNotMatch(browser.text(), /已取消当前发布等待/);
      await browser.click('检查完整 ZIP');
      assert.match(browser.text(), /second.zip/);
      await act(async () => {
        oldProgress?.({ ...progressing, stage: 'complete' });
        waiting.resolve(published);
        await waiting.promise;
      });
      assert.equal(refreshed, 0);
      assert.match(browser.text(), /second.zip/);
      assert.doesNotMatch(browser.text(), /已发布「|完整功能插件发布完成/);
      assert.equal(browser.document.querySelector('[aria-label="完整发布进度"]'), null);
      assert.equal(browser.button('确认上传并发布').disabled, false);
    });

    await context.test('取消旧 ZIP 检查后，新预览不受迟到失败覆盖', async () => {
      const inspection = deferred<ReleasePublicationPlan>();
      let attempts = 0;
      await browser.render(
        {
          prepareRelease: async (file) => {
            attempts++;
            return attempts === 1 ? inspection.promise : planFor(file);
          },
        },
        true,
      );
      await browser.choose('pending.zip');
      await browser.click('检查完整 ZIP');
      assert.match(browser.text(), /正在检查发布内容/);
      await browser.click('取消当前操作');
      await browser.choose('fresh.zip');
      await browser.click('检查完整 ZIP');
      await act(async () => {
        inspection.reject(new Error('旧检查迟到失败'));
        await inspection.promise.catch(() => {});
      });
      assert.match(browser.text(), /fresh.zip/);
      assert.equal(browser.document.querySelector('[role="alert"]'), null);
      assert.equal(browser.button('确认上传并发布').disabled, false);
    });

    await context.test('强制关闭检查后重新打开，旧成功及 finally 不能结束新检查', async () => {
      const oldInspection = deferred<ReleasePublicationPlan>();
      const newInspection = deferred<ReleasePublicationPlan>();
      let oldFile: File | undefined;
      let newFile: File | undefined;
      let oldSignal: AbortSignal | undefined;
      await browser.render(
        {
          prepareRelease: async (file, signal) => {
            oldFile = file;
            oldSignal = signal;
            return oldInspection.promise;
          },
        },
        true,
      );
      await browser.choose('old.zip');
      await browser.click('检查完整 ZIP');
      await browser.render({ open: false });
      assert.equal(oldSignal?.aborted, true);
      await browser.render({
        prepareRelease: async (file) => {
          newFile = file;
          return newInspection.promise;
        },
      });
      await browser.choose('new.zip');
      await browser.click('检查完整 ZIP');
      assert.ok(oldFile);
      const inspectedOldFile = oldFile;
      await act(async () => {
        oldInspection.resolve(planFor(inspectedOldFile));
      });
      assert.equal(browser.button('独立组件或其他资源').disabled, true);
      assert.match(browser.text(), /正在检查发布内容/);
      assert.equal(browser.document.querySelector('[aria-label="完整功能插件预览"]'), null);
      assert.ok(newFile);
      const inspectedNewFile = newFile;
      await act(async () => {
        newInspection.resolve(planFor(inspectedNewFile));
      });
      assert.match(browser.text(), /new.zip/);
      assert.doesNotMatch(browser.text(), /old.zip/);
      assert.equal(browser.button('确认上传并发布').disabled, false);
    });

    await context.test('旧发布取消后的迟到失败不能结束新发布或覆盖新结果', async () => {
      const oldPublication = deferred<ReleasePublicationResult>();
      const newPublication = deferred<ReleasePublicationResult>();
      let calls = 0;
      let refreshed = 0;
      await browser.render(
        {
          onPublished() {
            refreshed++;
          },
          publishRelease: async () =>
            ++calls === 1 ? oldPublication.promise : newPublication.promise,
        },
        true,
      );
      await browser.choose();
      await browser.click('检查完整 ZIP');
      await browser.click('确认上传并发布');
      await browser.click('取消当前操作');
      await browser.click('确认上传并发布');
      await act(async () => {
        oldPublication.reject(new Error('旧目录响应迟到失败'));
      });
      assert.equal(browser.document.querySelector('[role="alert"]'), null);
      assert.equal(browser.button('独立组件或其他资源').disabled, true);
      assert.ok(browser.button('取消当前操作'));
      await act(async () => {
        newPublication.resolve(published);
      });
      assert.equal(refreshed, 1);
      assert.match(browser.text(), /已发布「/);
    });

    await context.test('卸载发布界面会取消请求，晚到进度和成功不交付通知', async () => {
      const waiting = deferred<ReleasePublicationResult>();
      let signal: AbortSignal | undefined;
      let progress: ((value: ReleasePublicationProgress) => void) | undefined;
      let refreshed = 0;
      await browser.render(
        {
          onPublished() {
            refreshed++;
          },
          publishRelease: async (_plan, _metadata, _marketplace, activeSignal, onProgress) => {
            signal = activeSignal;
            progress = onProgress;
            return waiting.promise;
          },
        },
        true,
      );
      await browser.choose();
      await browser.click('检查完整 ZIP');
      await browser.click('确认上传并发布');
      await browser.detach();
      assert.equal(signal?.aborted, true);
      await act(async () => {
        progress?.({ ...progressing, stage: 'complete' });
        waiting.resolve(published);
      });
      assert.equal(refreshed, 0);
      await browser.render();
      assert.doesNotMatch(browser.text(), /已发布「|完整功能插件发布完成/);
      assert.equal(browser.document.querySelector('.ui-file-selected'), null);
    });
  } finally {
    await browser.close();
  }
});
