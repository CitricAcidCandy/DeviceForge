# 浏览器插件生命周期与取消

每次启用产生独立插件代次。宿主读取默认导出、核对身份及贡献、登记扩展，再调用可选 `activate(context)`；失败会撤销本代已登记内容并尝试释放资源。`panels`、组件和模块在实际进入时才调用 `mount`，其上下文绑定挂载子作用域。面板关闭与插件停用是不同粒度，关闭一个面板不应停止其他面板和整代服务。

## 实现资源所有权

1. 激活资源使用激活上下文登记；挂载资源使用该次 mount 的上下文登记。
2. 监听、计时器、订阅、DOM、对象 URL、自有连接与第三方实例都要释放。
3. 在创建资源后立即 `context.onDispose(cleanup)`；mount 最终返回释放函数。
4. 清理函数应幂等；需要等待关闭的资源应返回 Promise，失败不要吞掉。
5. 不保存上一代上下文或设备引用用于下一代请求。

```javascript
async function mount(target, context) {
  const local = new AbortController();
  const root = document.createElement('div');
  target.append(root);
  const release = context.onDispose(() => {
    local.abort();
    root.remove();
  });
  try {
    const signal = AbortSignal.any([context.signal, local.signal]);
    const result = await context.listOperations(signal);
    signal.throwIfAborted();
    root.textContent = `当前操作：${result.data.length}`;
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
```

异步调用必须传显式 `AbortSignal`。命令、服务和钩子回调收到的 signal 包含调用等待与提供者生命周期；自己的异步工作仍需使用本次上下文并检查晚到结果。不要用激活时捕获的上下文替代 mount 收到的子上下文，否则关闭面板后仍可能写入失效视图。

## 取消语义

调用者取消、插件/挂载撤销、服务提供者卸载、注册表关闭时，宿主会及时拒绝相应等待，不交付旧代晚到结果。可信插件若忽略 signal，其自有副作用仍可能继续；宿主停止等待不等于强制停止 JavaScript 或完成外部清理。不要把 API 返回取消就写成资源已全部释放。

服务器任务一旦接受，浏览器取消等待、关闭面板、停用浏览器插件均不自动取消任务。需要停止时显式 `cancelJob(id,signal)`，随后 `getJob` 确认 `succeeded/failed/cancelled` 终态；取消请求与任务完成竞争时，以最终任务状态为准。`queued/running` 不是成功。历史查询退出也不删除记录或取消任务。

A 调用 B 的服务时，B 卸载取消在途信号；不会自动停用 A。B 重载后，A 按相同 ID/精确版本发起的新调用可解析新代 B，旧调用和旧上下文不会复活。缺失服务、命令应显示不可用，并通过公开目录重新发现。

## 日志、错误与结果

SDK 响应为 `{data,logId}`；HTTP v2 的 `{log_id,data}` 由宿主映射。公开错误为 `HostError`，字段包括 `kind`（http/network/cancelled/protocol）、`code/message/logId/status/retryAfter`。本地参数、生命周期错误或未取得响应的取消可无日志 ID，不要伪造。

保留并展示日志 ID 便于排查；任务 ID 用于查询任务，产物 ID 用于下载，两者都不能当日志 ID。仅按 `instanceof` 判断错误可能受独立打包的类副本影响，可读取公开字段并保留原错误。自己的 JSON 解析错误属于本地错误，不冒充服务器错误。

不同任务的响应不得覆盖当前选择；发起新请求可撤销旧等待，也可使用请求序号及当前设备完整引用做晚到检查。重试前应区分只读查询与有副作用提交。提交等待取消后先查真实状态，不能假设事务回滚并自动重复提交。

## 停用与换代

停用撤销本实例贡献并清理已登记资源。浏览器包删除会先停止当前 runtime 的实例并撤销加载源，无法强制停止同事浏览器中的已执行代码。浏览器包和服务器包独立管理，不要在本地面板退出时擅自删除共享服务器部署。

每次实际加载使用新的 `runs/{run_id}/assets/` 模块路径，入口和包内相对依赖继承该路径，避免重载复用旧模块状态。只给入口加查询参数不能让相对依赖自动换代。它是新路径加载机制，不能称为从浏览器内存卸出已执行 ESM。重复 enable 已加载实例不会创建新代；需要先停用再启用。
