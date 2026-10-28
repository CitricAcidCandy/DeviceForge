# 可直接打包的浏览器插件

## 推荐的单清单入口

新工程使用 manifest 主题的 manifest.json（manifest_version:1），用 `deviceforge plugin pack` 生成运行清单、市场资料、组件包和完整发布；package.json/plugin.json/market.json 不再重复维护。最小入口可保存为组件 files 中的 index.js：

```javascript
export default ({id}) => ({
  panels: [{ id: id + '.hello', title: '问候', mount(root) {
    root.textContent = '插件已挂载';
    return () => root.replaceChildren();
  }}]
});
```

身份与版本由生成包装注入，工厂可用于贡献命名空间。需要 React/TypeScript 时先自行构建。market 的完整结构、默认值与枚举直接查询 manifest 主题；发布命令查询 packaging 主题。下面保留的手写多文件示例属于旧包兼容和协议参考，可复用其业务逻辑，不要求新工程重复维护身份。

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

## 把同一面板嵌入设备应用区域

上面的 `panels` 只提供插件页独立面板入口。要把它显示到设备工作台右栏「应用」页签，在原默认导出对象的 `contributions` 中增加 `components`，与已有 `commands` 并列；其余清单、入口和完整 `mount` 函数保持原样：

```javascript
components: [{
  id: `${pluginId}.apps_tools`,
  title: '设备应用工具',
  slot: 'devices.apps',
  mode: 'append',
  mount,
}],
```

这是复用上面完整入口的字段片段，不是第二份可直接导入的独立模块。安装并启用后，打开设备工作台的「应用」页签，宿主会把它追加到原应用内容之后。`panels` 可以保留，两个位置分别调用 `mount`，因此 DOM、状态和取消控制器必须在每次挂载内部创建，不能共用一个已挂载节点。

改用 `mode: 'replace'` 会接管整个应用区域；挂载成功前、失败或卸载后仍回落到宿主内容。它不会把插件内容注入原列表每行，也不会自动替换每行的名称或图标。要保留原列表只增加别名，仍需要宿主提供行级展示解析接口；单独注册解析服务不会让原列表自动调用。自有页面与侧栏入口应使用 `modules`，完整字段和派生规则继续读取 `sdk` 主题。

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

## 功能级服务消费方

下面是第二个可独立加载的完整浏览器入口，仅使用公开 SDK，不导入宿主私有模块。另建组件包并将清单 ID 设为 `guide_service_consumer`、版本设为 `1.0.0`，入口指向 `service-consumer.mjs`，不要直接复用上例组件身份。

提供者是另一个独立浏览器插件，公开服务 `guide_service_provider.echo@1`，声明输入、输出 Schema 均为 `{type:'string'}`，`invoke` 原样返回输入。消费者不负责安装提供者；提供者缺失时，状态命令仍存在，回声命令等待依赖。这里的版本 `'1'` 是精确字符串，不是版本范围。

### service-consumer.mjs

```javascript
const echo = { id: 'guide_service_provider.echo', version: '1' };
const typedEcho = {
  ...echo,
  accepts: (value) => typeof value === 'string',
  returns: (value) => typeof value === 'string',
};

export default {
  id: 'guide_service_consumer',
  version: '1.0.0',
  apiVersion: 2,
  panels: [],
  contributions: {
    commands: [{
      id: 'guide_service_consumer.status',
      title: '查询组合功能状态',
      execute: async (_input, context) => ({
        data: context.services?.diagnostics().map(({ featureId, state }) => ({ featureId, state })) ?? [],
        logId: null,
      }),
    }],
  },
  activate: async (context) => {
    if (!context.services) return;
    context.services.whenAvailable('echo', [echo], (feature) => {
      const services = feature.services;
      const register = feature.extensions?.register;
      if (!services || !register) throw new Error('宿主未提供功能级动态扩展');
      return register({
        commands: [{
          id: 'guide_service_consumer.echo',
          title: '调用字符串回声服务',
          execute: async (input, _context, signal) => services.callTyped(typedEcho, input, signal),
        }],
      });
    });
  },
};
```

`whenAvailable` 返回的撤销函数由插件资源管理，激活不会等待依赖。动态命令通过 `feature` 上下文注册，依赖撤销时一起移除，提供者重新加载后用新子作用域重建；静态状态命令和消费者插件本身保持运行。`callTyped` 的两个守卫会在运行时验证输入、输出，Schema 仍由提供者与宿主校验。TypeScript 插件可以将该引用声明为 `TypedService<string,string>`，不能只写类型断言而省略守卫。

在真实宿主验收时分别验证：先启用消费者只出现状态命令；启用提供者后回声调用成功；传数字被拒绝；停用提供者只撤销回声命令；重新启用后可再次调用。此例没有可见界面，也不证明真实设备、后端协议 6 或冻结包交付通过。服务器公共服务须走 `context.services.server.list/submit` 与 Job 终态查询，不用 `whenAvailable` 等待服务器目录。
