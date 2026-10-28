// 纯原生ESM演示：只公开无敏感字段的业务投影，宿主缺少可选能力时正常运行。
export function registerDemoData(context) {
  if (!context.debug?.registerDataSource) return;
  let revision = 1;
  let value = { name: '调试示例', count: 0 };
  const release = context.debug.registerDataSource({
    id: 'demo.settings', label: '示例业务数据', persistence: 'memory', applyPolicy: 'immediate',
    schema: { type: 'object', additionalProperties: false, required: ['name', 'count'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 40 }, count: { type: 'integer', minimum: 0, maximum: 1000 },
    } },
    async read(_query, signal) {
      signal.throwIfAborted(); context.signal.throwIfAborted();
      return { revision: String(revision), value: { ...value } };
    },
    async write(request, signal) {
      signal.throwIfAborted(); context.signal.throwIfAborted();
      // 最终比较与修改之间没有await；真实存储应在同一事务内比较实际修订。
      if (request.expectedRevision !== String(revision)) throw new Error('数据修订冲突，请重新读取');
      const next = request.value;
      if (!next || typeof next !== 'object' || Array.isArray(next) || Object.keys(next).length !== 2 ||
        typeof next.name !== 'string' || !next.name.trim() || next.name.length > 40 ||
        !Number.isInteger(next.count) || next.count < 0 || next.count > 1000)
        throw new Error('示例业务数据不符合约束');
      value = { name: next.name, count: next.count };
      revision++;
    },
  });
  context.onDispose(release);
}
