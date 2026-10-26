# 浏览器插件生命周期与取消

每次启用产生独立插件代次。宿主读取默认导出、核对身份及贡献、登记扩展，再调用可选 `activate(context)`；失败会撤销本代已登记内容并尝试释放资源。`panels`、组件和模块在实际进入时才调用 `mount`，其上下文绑定挂载子作用域。面板关闭与插件停用是不同粒度，关闭一个面板不应停止其他面板和整代服务。

## 清理告警与新操作

历史清理失败和后台恢复不作为独立新操作、加载或启用的前置门禁；本次真实失败仍报告，旧错误可查看，新成功不能将其抹去。loader、activate、mount 与 dispose 的宿主等待均须可取消或按固定期限结束，共享队列不能因旧回调不返回而永久停住。晚到旧代不得重新发布贡献，宿主等待结束不代表已强制停止同页面 JavaScript。真实资源互斥、容量和文件事务只限制对应对象，不要求用户先恢复或重启。完整规则及必验清单见[插件清理告警与重试约束](../../contracts/插件清理告警与重试约束.md)，规则不代表当前宿主已全量通过验证。

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

停用撤销本实例贡献并清理已登记资源。完整功能发布由统一安装用例管理服务器和浏览器组件；旧独立包仍兼容单组件管理，但不能用旧入口删除或更新统一发布所属组件。浏览器本地撤销加载源无法强制停止同事浏览器中的已执行代码，不要在本地面板退出时擅自删除共享服务器部署。

每次实际加载使用新的 `runs/{run_id}/assets/` 模块路径，入口和包内相对依赖继承该路径，避免重载复用旧模块状态。只给入口加查询参数不能让相对依赖自动换代。它是新路径加载机制，不能称为从浏览器内存卸出已执行 ESM。重复 enable 已加载实例不会创建新代；需要先停用再启用。

统一发布的持久 `enabled` 意图和当前浏览器实例状态分别检查。缺必填输入时安装状态为 `configuration_required`，填完再显式启用；新安装满足输入后默认启用，更新保留原意图。管理更新/启停/卸载使用原始清单修订 `expected_revision`，冲突先刷新而不覆盖。发布卸载保留两端配置，公共工具只在没有活动发布、上版恢复、其他选择和调用租约引用时可清理；本地面板停用不能代替发布卸载或仓库清理。
