export const inputSchema = {
  type: 'object', required: ['message'], additionalProperties: false,
  properties: { message: { type: 'string', maxLength: 1000 } },
};
export const outputSchema = {
  type: 'object', required: ['message', 'source'], additionalProperties: false,
  properties: { message: { type: 'string' }, source: { type: 'string' } },
};

export function messageInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 1 || typeof input.message !== 'string' ||
      [...input.message].length > 1000) throw new Error('请输入唯一的 message 字符串，最多 1000 个字符');
  return { message: input.message };
}

// 即使测试替身或旧宿主忽略 signal，本示例也有自己的等待出口。
export function waitFor(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export async function localEcho(input, context, callerSignal) {
  const signal = AbortSignal.any([context.signal, callerSignal]);
  signal.throwIfAborted();
  return { data: { ...messageInput(input), source: 'demo.debugger.browser' }, logId: null };
}

export async function serverEcho(input, context, callerSignal) {
  const payload = messageInput(input);
  const signal = AbortSignal.any([context.signal, callerSignal, AbortSignal.timeout(8000)]);
  signal.throwIfAborted();
  const submitted = await waitFor(context.submit('plugin.demo_debugger_server.echo', payload, signal), signal);
  let job = submitted.data;
  let queryLogId = null;
  // 只轮询同一个 Job；超时、取消或查询失败都不再次提交。
  for (let attempt = 0; ['queued', 'running'].includes(job.status) && attempt < 40; attempt++) {
    await waitFor(new Promise((resolve) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(abort, 100);
      signal.addEventListener('abort', abort, { once: true });
    }), signal);
    signal.throwIfAborted();
    const current = await waitFor(context.getJob(job.id, signal), signal);
    queryLogId = current.logId;
    job = current.data;
  }
  signal.throwIfAborted();
  if (job.status !== 'succeeded') {
    const error = new Error(`回显任务尚未成功：${job.status}；请按原 Job 查询或显式取消`);
    error.jobId = job.id;
    error.logId = queryLogId ?? submitted.logId;
    throw error;
  }
  return { data: { job, submission_log_id: submitted.logId, query_log_id: queryLogId }, logId: submitted.logId };
}
