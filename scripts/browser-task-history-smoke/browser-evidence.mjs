export const check = (condition, message) => { if (!condition) throw new Error(message); };
export const equal = (left, right, message) => check(JSON.stringify(left) === JSON.stringify(right), message);
export const log = (value) => check(typeof value === 'string' && !!value.trim(), '缺少真实响应日志ID');
export const brief = (error) => ({ message: String(error?.message ?? error).slice(0, 700),
  kind: error?.kind ?? null, code: error?.code ?? null, status: error?.status ?? null, logId: error?.logId ?? null });
export async function capture(run) {
  try { return { ok: true, result: await run() }; }
  catch (error) { return { ok: false, error: brief(error) }; }
}
export async function bounded(pending, milliseconds, message) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]); }
  finally { clearTimeout(timer); }
}
export const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

export async function raw(path) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  const body = await response.json(); log(body.log_id);
  check(body.log_id === response.headers.get('x-deviceforge-log-id'), '公开HTTP日志包装与响应头不符');
  return { status: response.status, logId: body.log_id, data: body.data, error: body.error };
}
export async function control(path, body) {
  const response = await fetch('/__control/gates' + path, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000) });
  check(response.ok, '验收控制门闩失败'); return response.json();
}
export async function waitGate(id) {
  const end = performance.now() + 4000;
  while (true) {
    const state = await control('/' + id);
    if (state.state === 'ready') { log(state.logId); check(state.status === 200, '门闩并非成功真实回执'); return state; }
    if (performance.now() >= end) throw new Error('真实回执未抵达门闩');
    await pause();
  }
}

// 记录实际传输；门闩请求故意不传播signal，以验证宿主及时拒绝及晚结果消费。
export function createTransport(report) {
  let next = null; const flights = new Set();
  report.transport = [];
  const transport = (input, options = {}) => {
    const url = new URL(input, location.href); const path = url.pathname + url.search;
    const gate = next?.path === path ? next : null; if (gate) next = null;
    const entry = { path, method: options.method ?? 'GET', gate: gate?.id ?? null,
      ignoresSignal: !!gate, completed: false };
    report.transport.push(entry);
    const headers = new Headers(options.headers);
    if (gate) headers.set('x-deviceforge-verification-gate', gate.id);
    const pending = fetch(input, { ...options, headers, ...(gate ? { signal: undefined } : {}) }).then(async (response) => {
      entry.status = response.status; entry.logId = response.headers.get('x-deviceforge-log-id');
      if (gate?.lateReject) {
        await response.body?.cancel(); entry.controlledLateReject = true;
        throw new Error('验收传输在真实回执抵达后注入晚拒绝');
      }
      if (gate && options.signal?.aborted) {
        // 撤销后的晚回执不再被客户端读取；显式释放它的字节流。
        await response.body?.cancel(); entry.revokedResponseBodyReleased = true;
      }
      return response;
    });
    // 成功与失败分支均登记，并立即接住错误，不创建未处理的派生拒绝。
    const observed = pending.then(() => { entry.completed = true; }, (error) => {
      entry.completed = true; entry.failure = String(error.message).slice(0, 200);
    });
    flights.add(observed); void observed.then(() => { flights.delete(observed); });
    return pending;
  };
  return { transport,
    async arm(path, lateReject = false) {
      check(next === null, '上个门闩尚未消费');
      const gate = await control('', { path }); next = { id: gate.id, path, lateReject }; return gate;
    },
    async drain() { await bounded(Promise.all([...flights]), 5000, '实际传输未收敛'); },
  };
}

export function matchReceipt(reply, report, path, status = 200) {
  log(reply.logId);
  check(report.transport.some((entry) => entry.path === path && entry.status === status && entry.logId === reply.logId),
    'SDK日志ID不对应本次实际传输');
}
export async function zeroTransport(access, id, signal, report) {
  const before = report.transport.length;
  const results = [];
  for (const invoke of [() => access.list({}, signal), () => access.get(id, signal), () => access.events(id, {}, signal)]) {
    const reply = await capture(invoke); results.push(reply);
    check(!reply.ok && reply.error.kind === 'cancelled' && reply.error.logId === null, '旧引用未本地撤销或伪造服务日志');
  }
  check(report.transport.length === before, '旧引用撤销后仍发起传输');
  return { attempts: results, transfers: report.transport.length - before };
}
