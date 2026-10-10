export const check = (condition, message) => { if (!condition) throw new Error(message); };
export const brief = (error) => ({ name: error?.name ?? null, kind: error?.kind ?? null, code: error?.code ?? null,
  status: error?.status ?? null, logId: error?.logId ?? null, message: String(error?.message ?? error).slice(0, 500) });
export const capture = (pending) => Promise.resolve(pending).then((value) => ({ ok: true, value }),
  (error) => ({ ok: false, error: brief(error) }));
export const attempt = (run) => capture(Promise.resolve().then(run));

export async function timely(pending, message, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

export async function eventually(read, accept, message, signal, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await read();
    if (accept(value)) return value;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(message);
}

export function expectFailure(result, { kind, code } = {}) {
  check(!result.ok, '预期失败的调用却成功');
  if (kind) check(result.error.kind === kind, '失败种类不符合预期：' + JSON.stringify(result.error));
  if (code) check(result.error.code === code, '失败码不符合预期：' + JSON.stringify(result.error));
  return result.error;
}

export function stepRecorder(report, signal) {
  return async (id, work) => {
    report.stage = id;
    const entry = { id, passed: false }; report.checks.push(entry);
    try { entry.evidence = await work(); signal.throwIfAborted(); entry.passed = true; }
    catch (error) { entry.error = brief(error); throw error; }
  };
}
