# 可直接打包的浏览器插件

以下三个文件构成无外部依赖的原生 ESM 插件。将文件按标题保存到同一包目录。它提供操作目录、显式任务提交、任务查询和取消，以及一个自己的目录命令。示例只在用户点击提交时调用实际操作；必须先阅读所选操作的 `input_schema`，按真实环境填写输入。目录存在不保证设备或服务器插件可用。

### package.json

```json
{
  "name": "deviceforge-browser-guide-example",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "files": ["plugin.json", "src"],
  "deviceforge": {
    "kind": "browser",
    "manifest": "plugin.json",
    "entrypoints": {
      "any": { "runtime": "browser", "path": "src/index.js" }
    }
  }
}
```

### plugin.json

```json
{
  "id": "browser_guide_example",
  "version": "0.1.0",
  "api_version": 2
}
```

### src/index.js

```javascript
const pluginId = 'browser_guide_example';
const commandId = `${pluginId}.catalog`;

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function mount(target, context) {
  const lifetime = new AbortController();
  let pending = null;
  let unsubscribe = null;
  let disposed = false;
  let operations = [];
  const root = element('section');
  root.setAttribute('aria-label', '插件任务示例');
  const title = element('h2', '插件任务示例');
  const select = element('select');
  select.setAttribute('aria-label', '操作');
  const schema = element('pre');
  schema.setAttribute('aria-label', '操作输入模式');
  const input = element('textarea');
  input.setAttribute('aria-label', 'JSON 输入');
  input.rows = 5;
  input.value = '{}';
  const jobId = element('input');
  jobId.setAttribute('aria-label', '任务 ID');
  jobId.placeholder = '提交后填入，也可粘贴已有任务 ID';
  const output = element('pre', '请刷新操作目录');
  output.setAttribute('role', 'status');
  output.setAttribute('aria-live', 'polite');
  const actions = element('div');

  function showSchema() {
    const operation = operations.find((entry) => entry.id === select.value);
    schema.textContent = operation ? JSON.stringify(operation.input_schema, null, 2) : '请选择操作';
  }

  function renderOperations(items) {
    operations = items;
    const previous = select.value;
    const placeholder = element('option', '请选择操作');
    placeholder.value = '';
    select.replaceChildren(placeholder);
    for (const operation of items) {
      const option = element('option', `${operation.title}（${operation.id}）`);
      option.value = operation.id;
      select.append(option);
    }
    if (items.some((entry) => entry.id === previous)) select.value = previous;
    showSchema();
  }

  async function run(action) {
    if (disposed || context.signal.aborted) return;
    pending?.abort();
    const request = new AbortController();
    pending = request;
    const signal = AbortSignal.any([context.signal, lifetime.signal, request.signal]);
    output.textContent = '正在请求';
    try {
      const result = await action(signal);
      if (signal.aborted || disposed || pending !== request) return;
      output.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      if (signal.aborted || disposed || pending !== request) return;
      output.textContent = JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        code: error?.code ?? null,
        logId: error?.logId ?? null,
      }, null, 2);
    } finally {
      if (pending === request) pending = null;
    }
  }

  function button(text, action) {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', () => { void run(action); }, { signal: lifetime.signal });
    actions.append(node);
  }

  button('刷新操作', async (signal) => {
    const result = await context.listOperations(signal);
    if (!signal.aborted && !disposed) renderOperations(result.data);
    return result;
  });
  button('提交任务', async (signal) => {
    if (!select.value) throw new Error('请先选择操作并核对输入模式');
    const result = await context.submit(select.value, JSON.parse(input.value), signal);
    if (!signal.aborted && !disposed) jobId.value = result.data.id;
    return result;
  });
  button('查询任务', (signal) => {
    if (!jobId.value.trim()) throw new Error('请填写任务 ID');
    return context.getJob(jobId.value.trim(), signal);
  });
  button('取消服务器任务', (signal) => {
    if (!jobId.value.trim()) throw new Error('请填写任务 ID');
    return context.cancelJob(jobId.value.trim(), signal);
  });
  button('调用本插件命令', (signal) => {
    if (!context.extensions) throw new Error('当前宿主未提供扩展访问');
    return context.extensions.executeCommand(commandId, {}, signal);
  });
  select.addEventListener('change', showSchema, { signal: lifetime.signal });
  root.append(title, select, schema, input, jobId, actions, output);
  target.append(root);

  const release = context.onDispose(async () => {
    if (disposed) return;
    disposed = true;
    pending?.abort();
    lifetime.abort();
    root.remove();
    const stop = unsubscribe;
    unsubscribe = null;
    if (stop) await stop();
  });
  try {
    unsubscribe = context.subscribeOperations((items) => {
      if (!disposed && !context.signal.aborted) renderOperations(items);
    });
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

export default {
  id: pluginId,
  version: '0.1.0',
  apiVersion: 2,
  panels: [{ id: `${pluginId}.tools`, title: '任务工具示例', mount }],
  contributions: {
    commands: [{
      id: commandId,
      title: '读取操作目录',
      async execute(_input, context, callerSignal) {
        const signal = AbortSignal.any([context.signal, callerSignal]);
        signal.throwIfAborted();
        const result = await context.listOperations(signal);
        signal.throwIfAborted();
        return {
          data: result.data.map(({ id, title }) => ({ id, title })),
          logId: result.logId,
        };
      },
    }],
  },
};
```

在包目录运行 `node --check src/index.js`，随后 `npm pack --ignore-scripts`。上传生成的 TGZ，选择浏览器包并启用，再在插件页挂载“任务工具示例”。操作目录与命令不需要额外依赖；提交任务的结果取决于实际后端操作。

示例每次交互撤销上次等待，防止旧响应覆盖当前视图；它不会自动取消上次已经接受的服务器任务。要停止服务器任务，使用已有任务 ID 点击取消，再查询确认终态。终态为 `succeeded/failed/cancelled`；`queued/running` 仍在执行中。面板输出保留响应日志 ID，未收到服务器响应或本地输入错误可没有日志 ID。

修改为 React 或 TypeScript 时，先构建浏览器 ESM，并把依赖一起打进归档；入口仍遵守相同对象和清理契约。不要从宿主私有源码导入 React、状态或 API，不假定 `@deviceforge/plugin-sdk` 已在 npm 发布。此最小示例未提供设备权限判断、业务结果解析或自动轮询，需要按自己的功能另加验证。

## 成套发布示例的归属

上例是可独立核验的底层浏览器组件。若配套后端指南 examples 主题的 `guide_echo@1.0.0`，使用一个外层 `release.json` 组成功能 `guide-suite@1.0.0`，而不是合并插件入口。发布清单保持 `format_version:1,host_api_version:2`，组件为：

```json
[
  {"id":"guide_echo","kind":"server","version":"1.0.0","variants":[
    {"platform":"any","path":"blobs/<服务器SHA-256>","sha256":"<服务器SHA-256>","size":1,"format":"tgz"}
  ]},
  {"id":"browser_guide_example","kind":"browser","version":"0.1.0","variants":[
    {"platform":"any","path":"blobs/<浏览器SHA-256>","sha256":"<浏览器SHA-256>","size":1,"format":"tgz"}
  ]}
]
```

这是 components 数组结构模板，尖括号和 size=1 必须由发布器替换为真实归档摘要与大小，不能直接安装。完整顶层含 `id/version/name/description/components/tools/requirements`；本例不执行外部工具，tools 与 requirements 可为空。离线目录根直接是 release.json 与 blobs/ 下两个实际 TGZ，不多套工程目录；完整顶层示例可通过 `target=backend,topic=examples` 读取。

安装按 packaging 的在线或离线统一流程进行，再验证浏览器面板能发现并调用 `plugin.guide_echo.echo`，查到真实终态和日志。打开面板不会替用户安装配套服务；不能把只成功挂载的旧独立包算作成套发布通过。用户根配置、服务器 SDK 资源描述、托管路径和高级覆盖保持边界，不进入浏览器 HostContext。
