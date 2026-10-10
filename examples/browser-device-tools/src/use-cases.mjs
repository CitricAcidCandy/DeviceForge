import { action, fail, object, reference, text } from './input.mjs';

function current(session, context, caller) {
  return session.signal(AbortSignal.any([caller, context.signal]));
}
function deviceAccess(context) {
  if (!context.devices) fail('example_devices_unsupported', '当前宿主没有可选 devices 扩展');
  return context.devices;
}

export async function catalog(session, context, input, caller) {
  object(input, [], '目录查询');
  const signal = current(session, context, caller);
  const revision = session.operationRevision();
  const reply = await context.listOperations(signal);
  signal.throwIfAborted();
  session.seedOperations(reply.data, revision);
  return { data: session.snapshot(), logId: reply.logId };
}

export async function refreshDevices(session, context, input, caller) {
  object(input, [], '设备目录查询');
  const signal = current(session, context, caller);
  // 读取提供者和已有目录，不自动发现，不将历史任务结果恢复为设备观测。
  const reply = await deviceAccess(context).refreshDirectories(signal);
  signal.throwIfAborted();
  return reply;
}

export async function discover(session, context, input, caller) {
  object(input, ['providerId', 'generation'], '显式发现');
  text(input.providerId, 'providerId'); text(input.generation, 'generation');
  const devices = deviceAccess(context);
  return session.withProvider(context, input.providerId, input.generation, caller,
    (signal) => devices.refreshProvider(input.providerId, input.generation, signal));
}

export async function select(session, context, input, caller) {
  current(session, context, caller);
  const devices = deviceAccess(context);
  devices.select(input === null ? null : reference(input));
  return { data: devices.snapshot(), logId: null };
}

export async function invokeRead(session, context, input, caller) {
  current(session, context, caller);
  const request = action(input);
  const devices = deviceAccess(context);
  const provider = devices.snapshot().providers.find((entry) => entry.id === request.providerId
    && entry.generation === request.generation);
  const capability = provider?.definition.capabilities.find((entry) => entry.id === request.capability
    && entry.version === request.version);
  if (!capability) fail('example_capability_unavailable', '当前提供者没有精确匹配的能力版本');
  // 示例限定目录声明的 read 能力；真实状态、作用域与可用性仍由 SDK/宿主检查。
  if (capability.access !== 'read') fail('example_read_only', '此示例不执行声明为 write 的设备能力');
  return session.withProvider(context, request.providerId, request.generation, caller,
    (signal) => devices.invoke(request, signal), (reply, signal) => {
      session.remember(reply.data, signal);
      return reply;
    });
}

export async function submit(session, context, input, caller) {
  object(input, ['operation', 'input'], '任务提交'); text(input.operation, 'operation');
  const signal = current(session, context, caller);
  const reply = await context.submit(input.operation, input.input, signal);
  session.remember(reply.data, signal);
  return reply;
}

export async function getJob(session, context, input, caller) {
  object(input, ['jobId'], '历史任务查询'); text(input.jobId, 'jobId');
  const signal = current(session, context, caller);
  // 历史按 Job ID 查询，不要求旧提供者仍存在，不补当前目录预算或代次。
  const reply = await context.getJob(input.jobId, signal);
  signal.throwIfAborted();
  return reply;
}

export async function cancelJob(session, context, input, caller) {
  object(input, ['jobId'], '显式任务取消'); text(input.jobId, 'jobId');
  const signal = current(session, context, caller);
  const reply = await context.cancelJob(input.jobId, signal);
  signal.throwIfAborted();
  return reply;
}

export async function requireCurrentOperation(session, context, submission, caller) {
  const signal = current(session, context, caller);
  const reply = await context.listOperations(signal);
  signal.throwIfAborted();
  if (!reply.data.some((entry) => entry.id === submission.operation)) {
    fail('example_operation_unavailable', '提交前公开目录已经撤销该操作，示例钩子停止本次提交');
  }
  // 实际增加提交前的目录检查；业务 input 原样返回，不注入预算或私有身份。
  return submission;
}
