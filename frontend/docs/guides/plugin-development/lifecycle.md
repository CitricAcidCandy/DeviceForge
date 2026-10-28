# 浏览器插件生命周期与取消

每次启用产生独立插件代次。宿主读取默认导出、核对身份及贡献、登记扩展，再调用可选 `activate(context)`；失败会撤销本代已登记内容并尝试释放资源。`panels`、组件和模块在实际进入时才调用 `mount`，其上下文绑定挂载子作用域。面板关闭与插件停用是不同粒度，关闭一个面板不应停止其他面板和整代服务。

## 固定预算与兼容边界

- 加载模块、配置准备、激活及配置应用共用默认 30 秒的绝对截止点，不在每个阶段重新计时。
- 槽位申请及实际挂载共用默认 10 秒；整次插件清理默认总共 5 秒，不为每个释放函数各给 5 秒。
- 同插件操作按插件串行，槽位操作按槽位串行；无关插件不共享等待队列，注册表不等待用户回调。超时与取消结束宿主等待，迟到结果只能清理原作用域，不能发布到新代。
- SDK 仍为 v2，新增 `context.services` 可选，旧调用继续兼容。以前永久阻塞或超长激活的实现现在会超时；耗时业务应提交任务或使用会话，不阻塞 `activate/mount`。
- 同页面插件按可信代码运行，宿主无法强制停止同步死循环或任意 JavaScript 副作用。等待结束、DOM 撤销与真实外部资源已释放是不同事实。

## 功能级服务依赖

`context.services.whenAvailable(featureId,required,setup)` 观察浏览器服务的精确版本，立即返回撤销函数，并由插件作用域管理。服务仅在提供者激活成功后可用，缺失或版本不匹配时不执行 `setup`。不要通过等待依赖的 Promise 阻塞插件激活。

`setup(feature)` 必须使用本次 `feature` 上下文登记动态贡献、订阅和资源，必要时返回幂等释放函数。依赖撤销或提供者换代时，宿主先取消相关功能信号并撤销其贡献，再有界回收；依赖恢复后重新执行 `setup`，不能复用旧上下文。同插件的独立功能和其他插件继续运行。初始化默认 30 秒，清理默认 5 秒。

`context.services.diagnostics()` 返回每个功能的 `featureId/state/missing/error/cleanupErrors`。状态表达 `waiting`（等待依赖）、`starting`（初始化）、`active`（可用）、`failed`（初始化失败）、`stopped`（已停止），不是整个插件的状态。旧功能清理异常保留在 `cleanupErrors`，每功能最近 8 条；新代成功不抹旧错，旧错也不覆盖新代 `active`。每插件最多 128 个活动功能，每功能最多 64 个不重复依赖引用，诊断最多保留 256 项。

功能依赖不会自动下载或安装提供者；共享工具依赖安装另见 `dependencies` 主题。`whenAvailable` 不观察服务器 Job 的业务终态；后端调用仍通过 `services.server`、任务查询与显式取消处理。浏览器消费方的完整示例直接包含在 `examples` 主题中。

## 清理告警与新操作

历史清理失败和后台恢复不作为独立新操作、加载或启用的前置门禁；本次真实失败仍报告，旧错误可查看，新成功不能将其抹去。loader、activate、mount 与 dispose 的宿主等待均须可取消或按固定期限结束，共享队列不能因旧回调不返回而永久停住。晚到旧代不得重新发布贡献，宿主等待结束不代表已强制停止同页面 JavaScript。真实资源互斥、容量和文件事务只限制对应对象，不要求用户先恢复或重启。复验步骤查询本指南 `validation` 主题；规则不代表当前宿主已全量通过验证。

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
