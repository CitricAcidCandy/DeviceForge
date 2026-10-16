import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { ComponentProps, ComponentType } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import type { MarketplaceUploadDialog } from '../src/pages/marketplace/components/MarketplaceUploadDialog/index.tsx';
import type { MarketplaceCard } from '../src/pages/marketplace/components/MarketplaceCard/index.tsx';
import type { MarketplaceDetail } from '../src/pages/marketplace/components/MarketplaceDetail/index.tsx';
import type { FileDropzone } from '../src/components/FileDropzone/index.tsx';
import type { Stepper } from '../src/components/Stepper/index.tsx';
import type {
  MarketplaceController,
  MarketplaceEntry,
  MarketplaceResourceRecord,
} from '../src/features/marketplace/index.ts';
import type { PackageInfo } from '../src/services/api/index.ts';

type UploadProps = ComponentProps<typeof MarketplaceUploadDialog>;
type CardProps = ComponentProps<typeof MarketplaceCard>;
type DetailProps = ComponentProps<typeof MarketplaceDetail>;
type FileProps = ComponentProps<typeof FileDropzone>;
type StepProps = ComponentProps<typeof Stepper>;

function uploadModule(
  value: unknown,
): value is { MarketplaceUploadDialog: ComponentType<UploadProps> } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'MarketplaceUploadDialog' in value &&
    typeof value.MarketplaceUploadDialog === 'function'
  );
}
function cardModule(value: unknown): value is { MarketplaceCard: ComponentType<CardProps> } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'MarketplaceCard' in value &&
    typeof value.MarketplaceCard === 'function'
  );
}
function detailModule(value: unknown): value is { MarketplaceDetail: ComponentType<DetailProps> } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'MarketplaceDetail' in value &&
    typeof value.MarketplaceDetail === 'function'
  );
}
function fileModule(value: unknown): value is { FileDropzone: ComponentType<FileProps> } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'FileDropzone' in value &&
    typeof value.FileDropzone === 'function'
  );
}
function stepModule(value: unknown): value is { Stepper: ComponentType<StepProps> } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'Stepper' in value &&
    typeof value.Stepper === 'function'
  );
}

async function fixture() {
  const browser = new JSDOM(
    '<!doctype html><html><body><main id="marketplace-test"></main></body></html>',
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
  });
  const target = windowRef.document.getElementById('marketplace-test');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const documentRef = windowRef.document;
  function button(label: string) {
    const control = Array.from(documentRef.querySelectorAll('button')).find(
      (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label,
    );
    assert.ok(control, `缺少按钮：${label}`);
    return control;
  }
  return {
    windowRef,
    documentRef,
    target,
    root,
    server,
    button,
    click: async (label: string) => {
      await act(async () => {
        button(label).click();
      });
    },
    async close() {
      await act(async () => {
        root.unmount();
      });
      await server.close();
      browser.window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

type BrowserFixture = Awaited<ReturnType<typeof fixture>>;

function selectedFiles(files: readonly File[]): FileList {
  return {
    length: files.length,
    item: (index) => files[index] ?? null,
    [Symbol.iterator]: () => files.values(),
  };
}

async function chooseFile(browser: BrowserFixture, file: File | null) {
  const input = browser.documentRef.querySelector('input[type="file"]');
  assert.ok(input instanceof browser.windowRef.HTMLInputElement);
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: selectedFiles(file ? [file] : []),
  });
  await act(async () => {
    input.dispatchEvent(new browser.windowRef.Event('change', { bubbles: true }));
  });
}

async function fillText(browser: BrowserFixture, label: string, value: string) {
  const node = Array.from(browser.documentRef.querySelectorAll('label')).find(
    (candidate) => candidate.textContent === label,
  );
  assert.ok(node, `缺少字段：${label}`);
  const input = browser.documentRef.getElementById(node.htmlFor);
  assert.ok(
    input instanceof browser.windowRef.HTMLInputElement ||
      input instanceof browser.windowRef.HTMLTextAreaElement,
  );
  const prototype =
    input instanceof browser.windowRef.HTMLInputElement
      ? browser.windowRef.HTMLInputElement.prototype
      : browser.windowRef.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  assert.ok(setter);
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new browser.windowRef.Event('input', { bubbles: true }));
  });
}

const resource: MarketplaceResourceRecord = {
  id: 'a'.repeat(64),
  sha256: 'a'.repeat(64),
  filename: 'demo.zip',
  media_type: 'application/zip',
  kind: 'plugin',
  size: 3,
  created_at: 1,
};

function marketplaceMock(overrides: Partial<MarketplaceController> = {}): MarketplaceController {
  return {
    defaultUrl: 'http://127.0.0.1:7040',
    currentUrl: () => 'http://market.example',
    setUrl: (value) => value,
    resetUrl: () => 'http://127.0.0.1:7040',
    search: async () => ({ entries: [], total: 0, offset: 0, limit: 20 }),
    upload: async () => resource,
    publish: async (entry) => entry,
    download: async () => ({
      blob: new Blob(),
      filename: 'demo.zip',
      mediaType: 'application/zip',
      size: 0,
    }),
    ...overrides,
  };
}

async function advanceToReview(browser: BrowserFixture) {
  await chooseFile(browser, new File(['zip'], 'demo.zip', { type: 'application/zip' }));
  await browser.click('下一步');
  assert.match(
    browser.documentRef.querySelector('[aria-current="step"]')?.textContent ?? '',
    /填写描述/,
  );
  await fillText(browser, '条目标识 *', 'demo-plugin');
  await fillText(browser, '名称 *', '设备分析插件');
  await fillText(browser, '简介 *', '提供设备分析能力');
  await fillText(browser, '类型专属描述', '{"plugin_kind":"browser"}');
  await browser.click('下一步');
  assert.match(
    browser.documentRef.querySelector('[aria-current="step"]')?.textContent ?? '',
    /确认发布/,
  );
}

function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      assert.ok(complete);
      complete(value);
    },
  };
}

test('上传对话框完成三步校验，确认阶段连续 Enter 只上传发布一次', async () => {
  const browser = await fixture();
  const loaded: unknown = await browser.server.ssrLoadModule(
    '/src/pages/marketplace/components/MarketplaceUploadDialog/index.tsx',
  );
  assert.ok(uploadModule(loaded));
  const uploaded = deferred<MarketplaceResourceRecord>();
  const calls: string[] = [];
  let refreshed = 0;
  const marketplace = marketplaceMock({
    upload: async (file, kind, signal) => {
      calls.push('upload');
      assert.equal(file.name, 'demo.zip');
      assert.equal(kind, 'plugin');
      assert.equal(signal.aborted, false);
      return uploaded.promise;
    },
    publish: async (entry, signal) => {
      calls.push('publish');
      assert.equal(entry.resource_id, resource.sha256);
      assert.equal(entry.id, 'demo-plugin');
      assert.equal(signal.aborted, false);
      return entry;
    },
  });
  try {
    await act(async () => {
      browser.root.render(
        createElement(loaded.MarketplaceUploadDialog, {
          open: true,
          onOpenChange() {},
          marketplace,
          onPublished() {
            refreshed++;
          },
        }),
      );
    });
    assert.match(
      browser.documentRef.querySelector('[aria-current="step"]')?.textContent ?? '',
      /选择资源/,
    );
    await browser.click('下一步');
    assert.match(
      browser.documentRef.querySelector('[role="alert"]')?.textContent ?? '',
      /请先选择/,
    );
    assert.equal(calls.length, 0);
    await chooseFile(browser, new File(['zip'], 'demo.zip', { type: 'application/zip' }));
    await browser.click('下一步');
    await browser.click('下一步');
    assert.match(
      browser.documentRef.querySelector('[role="alert"]')?.textContent ?? '',
      /条目标识/,
    );
    assert.equal(calls.length, 0);
    await fillText(browser, '条目标识 *', 'demo-plugin');
    await fillText(browser, '名称 *', '设备分析插件');
    await fillText(browser, '简介 *', '提供设备分析能力');
    await fillText(browser, '类型专属描述', '{"plugin_kind":"browser"}');
    await browser.click('下一步');
    assert.match(
      browser.documentRef.querySelector('[aria-label="发布确认"]')?.textContent ?? '',
      /demo.zip/,
    );
    const form = browser.documentRef.querySelector('form');
    assert.ok(form instanceof browser.windowRef.HTMLFormElement);
    await act(async () => {
      form.dispatchEvent(
        new browser.windowRef.Event('submit', { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new browser.windowRef.Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(calls, ['upload']);
    assert.equal(browser.button('上传发布中…').disabled, true);
    await act(async () => {
      uploaded.resolve(resource);
    });
    assert.deepEqual(calls, ['upload', 'publish']);
    assert.equal(refreshed, 1);
    assert.match(
      browser.documentRef.querySelector('[role="status"]')?.textContent ?? '',
      /已上传并发布/,
    );
    await act(async () => {
      form.dispatchEvent(
        new browser.windowRef.Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(calls, ['upload', 'publish']);
  } finally {
    await browser.close();
  }
});

test('切换路由关闭上传对话框会取消等待，晚到上传不发布且重新打开回到第一步', async () => {
  const browser = await fixture();
  const loaded: unknown = await browser.server.ssrLoadModule(
    '/src/pages/marketplace/components/MarketplaceUploadDialog/index.tsx',
  );
  assert.ok(uploadModule(loaded));
  const uploaded = deferred<MarketplaceResourceRecord>();
  const signals: AbortSignal[] = [];
  let publications = 0;
  let refreshed = 0;
  const marketplace = marketplaceMock({
    upload: async (_file, _kind, signal) => {
      signals.push(signal);
      return uploaded.promise;
    },
    publish: async (entry) => {
      publications++;
      return entry;
    },
  });
  const render = async (open: boolean) => {
    await act(async () => {
      browser.root.render(
        createElement(loaded.MarketplaceUploadDialog, {
          open,
          onOpenChange() {},
          marketplace,
          onPublished() {
            refreshed++;
          },
        }),
      );
    });
  };
  try {
    await render(true);
    await advanceToReview(browser);
    await browser.click('确认上传并发布');
    assert.equal(signals.length, 1);
    await render(false);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(browser.documentRef.querySelector('[role="dialog"]'), null);
    await render(true);
    assert.match(
      browser.documentRef.querySelector('[aria-current="step"]')?.textContent ?? '',
      /选择资源/,
    );
    await act(async () => {
      uploaded.resolve(resource);
    });
    assert.equal(publications, 0);
    assert.equal(refreshed, 0);
    assert.equal(browser.documentRef.querySelector('[role="status"]'), null);
    assert.equal(browser.documentRef.querySelector('.ui-file-selected'), null);
    assert.equal(browser.button('下一步').disabled, false);
  } finally {
    await browser.close();
  }
});

test('文件选择器保留取消前的文件，拒绝错误格式，支持移除并禁用交互', async () => {
  const browser = await fixture();
  const loaded: unknown = await browser.server.ssrLoadModule(
    '/src/components/FileDropzone/index.tsx',
  );
  assert.ok(fileModule(loaded));
  const changes: (File | null)[] = [];
  const selected = new File(['zip'], 'demo.zip', { type: 'application/zip' });
  const render = async (file: File | null, disabled = false) => {
    await act(async () => {
      browser.root.render(
        createElement(loaded.FileDropzone, {
          file,
          disabled,
          accept: '.zip,application/gzip',
          label: '安装包',
          onFileChange: (next) => {
            changes.push(next);
          },
        }),
      );
    });
  };
  try {
    await render(null);
    await chooseFile(browser, selected);
    assert.deepEqual(changes, [selected]);
    await render(selected);
    await chooseFile(browser, null);
    assert.deepEqual(changes, [selected]);
    assert.match(browser.target.textContent ?? '', /demo.zip/);
    await chooseFile(browser, new File(['image'], 'photo.png', { type: 'image/png' }));
    assert.deepEqual(changes, [selected]);
    assert.match(
      browser.target.querySelector('[role="alert"]')?.textContent ?? '',
      /支持的文件格式/,
    );
    await browser.click('移除文件 demo.zip');
    assert.deepEqual(changes, [selected, null]);
    await render(selected, true);
    await chooseFile(browser, new File(['zip'], 'other.zip'));
    await browser.click('移除文件 demo.zip');
    assert.deepEqual(changes, [selected, null]);
    assert.equal(browser.button('移除文件 demo.zip').disabled, true);
  } finally {
    await browser.close();
  }
});

function entry(patch: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
  return {
    metadata_version: 1,
    id: 'demo-plugin',
    kind: 'plugin',
    name: '设备分析插件',
    version: '2.0.0',
    summary: '提供设备分析能力',
    description: '采集设备信息并生成分析报告',
    keywords: ['分析', '自动化'],
    categories: ['function', 'ui'],
    applies_to: ['deviceforge'],
    supports_mcp: 'both',
    supports_agent: true,
    restart_policy: 'plugin_reload',
    platforms: ['windows'],
    architectures: ['x64'],
    author: '测试作者',
    license: 'MIT',
    source: 'http://market.example',
    sourceName: '测试市场',
    resource_id: resource.sha256,
    details: {
      plugin_kind: 'browser',
      permissions: ['设备连接'],
      configuration: { scope: 'user', owner_id: 'demo-plugin', section: 'preferences' },
    },
    ...patch,
  };
}

const installed: PackageInfo = {
  id: 'demo-plugin',
  version: '1.0.0',
  kind: 'browser',
  installed_at: 1,
  entry_path: 'plugin.js',
  runtime: 'browser',
  api_version: 2,
};

test('步骤条随当前步骤更新完成和待办语义，保留可访问的进度说明', async () => {
  const browser = await fixture();
  const loaded: unknown = await browser.server.ssrLoadModule('/src/components/Stepper/index.tsx');
  assert.ok(stepModule(loaded));
  try {
    await act(async () => {
      browser.root.render(
        createElement(loaded.Stepper, {
          currentStep: 1,
          label: '上传步骤',
          steps: [
            { id: 'file', title: '选择资源' },
            { id: 'metadata', title: '填写描述' },
            { id: 'review', title: '确认发布' },
          ],
        }),
      );
    });
    const steps = Array.from(browser.target.querySelectorAll('li'));
    assert.equal(steps.length, 3);
    assert.equal(steps[0]?.getAttribute('data-state'), 'complete');
    assert.match(steps[0]?.textContent ?? '', /已完成/);
    assert.equal(steps[1]?.getAttribute('aria-current'), 'step');
    assert.match(steps[1]?.textContent ?? '', /进行中/);
    assert.equal(steps[2]?.getAttribute('data-state'), 'pending');
    assert.match(steps[2]?.textContent ?? '', /待完成/);
  } finally {
    await browser.close();
  }
});

test('市场卡片分别派发详情、下载、安装、更新与已安装配置卸载，忙碌时阻止操作', async () => {
  const browser = await fixture();
  const loaded: unknown = await browser.server.ssrLoadModule(
    '/src/pages/marketplace/components/MarketplaceCard/index.tsx',
  );
  assert.ok(cardModule(loaded));
  const calls: string[] = [];
  const actions = {
    onDetail() {
      calls.push('detail');
    },
    onDownload() {
      calls.push('download');
    },
    onInstall() {
      calls.push('install');
    },
    onRemove() {
      calls.push('remove');
    },
    onConfigure() {
      calls.push('configure');
    },
  };
  const render = async (patch: Partial<CardProps> = {}) => {
    await act(async () => {
      browser.root.render(
        createElement(loaded.MarketplaceCard, {
          entry: entry(),
          busy: false,
          ...actions,
          ...patch,
        }),
      );
    });
  };
  try {
    await render();
    await browser.click('查看 设备分析插件 详情');
    await browser.click('下载');
    await browser.click('安装');
    assert.deepEqual(calls, ['detail', 'download', 'install']);
    await render({ installed });
    await browser.click('更新');
    assert.equal(calls.at(-1), 'install');
    await render({ installed, installedTab: true });
    await browser.click('配置');
    await browser.click('卸载');
    await browser.click('更新');
    assert.deepEqual(calls.slice(-3), ['configure', 'remove', 'install']);
    await render({ installed, installedTab: true, busy: true });
    const count = calls.length;
    await browser.click('配置');
    await browser.click('卸载');
    await browser.click('更新');
    assert.equal(calls.length, count);
    await render({
      installed,
      installedTab: true,
      entry: entry({ details: { plugin_kind: 'browser' } }),
    });
    assert.equal(browser.button('配置').disabled, true);
    await render({ installed: { ...installed, version: '2.0.0' } });
    assert.equal(browser.button('已安装').disabled, true);
    await render({ entry: entry({ metadataIssues: ['缺少摘要'] }) });
    assert.equal(browser.button('安装').disabled, true);
  } finally {
    await browser.close();
  }
});

test('详情对话框显示来源摘要平台权限重启和类型字段，并派发下载更新及关闭', async () => {
  const browser = await fixture();
  const loaded: unknown = await browser.server.ssrLoadModule(
    '/src/pages/marketplace/components/MarketplaceDetail/index.tsx',
  );
  assert.ok(detailModule(loaded));
  const calls: string[] = [];
  const render = async (value: MarketplaceEntry | null) => {
    await act(async () => {
      browser.root.render(
        createElement(loaded.MarketplaceDetail, {
          entry: value,
          installed,
          busy: false,
          onDownload() {
            calls.push('download');
          },
          onInstall() {
            calls.push('install');
          },
          onClose() {
            calls.push('close');
          },
        }),
      );
    });
  };
  try {
    await render(entry());
    const dialog = browser.documentRef.querySelector('[role="dialog"]');
    assert.ok(dialog);
    for (const text of [
      'http://market.example',
      resource.sha256,
      'windows',
      'x64',
      '设备连接',
      '重载插件',
      'MCP 双向',
      '支持 Agent',
    ])
      assert.ok(dialog.textContent?.includes(text), `详情缺少：${text}`);
    await browser.click('下载');
    await browser.click('更新');
    await browser.click('关闭');
    assert.deepEqual(calls, ['download', 'install', 'close']);
    await render(
      entry({
        kind: 'tool',
        categories: ['analysis'],
        details: { tool_type: 'analysis', commands: ['adb'], requires_admin: true },
      }),
    );
    assert.match(
      browser.documentRef.querySelector('[role="dialog"]')?.textContent ?? '',
      /工具类型/,
    );
    assert.match(
      browser.documentRef.querySelector('[role="dialog"]')?.textContent ?? '',
      /需要管理员权限/,
    );
    assert.equal(
      Array.from(browser.documentRef.querySelectorAll('button')).some(
        (node) => node.textContent?.trim() === '安装',
      ),
      false,
    );
    await render(entry({ metadataIssues: ['缺少插件运行位置'] }));
    assert.match(
      browser.documentRef.querySelector('[role="status"]')?.textContent ?? '',
      /元数据不完整/,
    );
    assert.equal(browser.button('更新').disabled, true);
    await render(null);
    assert.equal(browser.documentRef.querySelector('[role="dialog"]'), null);
  } finally {
    await browser.close();
  }
});
