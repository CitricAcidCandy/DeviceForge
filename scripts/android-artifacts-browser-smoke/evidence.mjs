export const ok = (condition, message) => {
  if (!condition) throw new Error(message);
};
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  return value;
}
export const equal = (actual, expected, message) =>
  ok(JSON.stringify(ordered(actual)) === JSON.stringify(ordered(expected)), message);
export const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
export const names = [
  'app.install',
  'screenshot',
  'connect',
  'disconnect',
  'packages',
  'app.start',
  'app.stop',
  'app.uninstall',
  'input',
];
export const operation = (name) => 'plugin.android-device.' + name;
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
export async function capture(run) {
  try {
    return { ok: true, result: await run() };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: error.kind ?? null,
        code: error.code ?? null,
        logId: error.logId ?? null,
        status: error.status ?? null,
        message: String(error.message).slice(0, 500),
      },
    };
  }
}
export function receipt(reply, report, path, status = 200) {
  ok(uuid(reply.logId), '缺少真实服务日志ID');
  ok(
    report.transport.some(
      (entry) => entry.path === path && entry.status === status && entry.logId === reply.logId,
    ),
    'SDK日志与同次HTTP传输不匹配',
  );
}
export async function raw(path, options = {}) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(10000) });
  const payload = await response.json();
  ok(
    uuid(payload.log_id) && payload.log_id === response.headers.get('x-deviceforge-log-id'),
    'HTTP日志包装与响应头不一致',
  );
  return {
    status: response.status,
    logId: payload.log_id,
    data: payload.data,
    error: payload.error,
  };
}
export async function finished(context, id, signal) {
  const deadline = performance.now() + 15000;
  while (true) {
    const result = await context.getJob(id, signal);
    if (['succeeded', 'failed', 'cancelled'].includes(result.data.status)) return result;
    ok(performance.now() < deadline, '设备任务未在有界期限内终态');
    await pause();
  }
}
export function jobShape(value) {
  equal(
    Object.keys(value).sort(),
    ['error', 'id', 'operation', 'result', 'status'],
    'Job五字段契约发生变化',
  );
  ok(uuid(value.id), 'Job ID无效');
}
export async function mcp(name, arguments_, report) {
  const id = crypto.randomUUID();
  const response = await fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: location.origin,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: arguments_ },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json();
  const logId = response.headers.get('x-deviceforge-log-id');
  ok(
    uuid(logId) &&
      response.ok &&
      payload.id === id &&
      !payload.error &&
      payload.result?._meta?.['deviceforge/log_id'] === logId &&
      payload.result?.isError === false,
    'MCP工具回执失败：' + name,
  );
  report.mcp ??= [];
  report.mcp.push({ name, status: response.status, logId });
  return payload.result.structuredContent;
}
