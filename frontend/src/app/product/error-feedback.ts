import type { MessageDetail, MessageOptions } from '../../components/Message/index.ts';
import type { ApiError } from '../../services/api/index.ts';
import { JobFailure, JobWaitFailure } from '../../shared/jobs/index.ts';
import { explainPublicError } from './error-reasons.ts';

export interface ActionErrorFeedback {
  readonly level: 'error' | 'warning' | 'info';
  readonly title: string;
  readonly options: MessageOptions;
}

type RequestError = Pick<ApiError, 'kind' | 'code' | 'message' | 'status' | 'logId'>;

function isRequestError(value: unknown): value is RequestError {
  return value !== null && typeof value === 'object' &&
    'kind' in value && typeof value.kind === 'string' &&
    ['http', 'network', 'cancelled', 'protocol'].includes(value.kind) &&
    'code' in value && typeof value.code === 'string' &&
    'message' in value && typeof value.message === 'string' &&
    'status' in value && (value.status === null || typeof value.status === 'number') &&
    'logId' in value && (value.logId === null || typeof value.logId === 'string');
}

function publicLogId(value: unknown): string | null {
  return value !== null && typeof value === 'object' &&
    'logId' in value && typeof value.logId === 'string' && value.logId.trim() ? value.logId : null;
}

function diagnosticText(message: string): string {
  // 只展示公开错误文字，不展开请求、堆栈或任意对象；意外混入的部署信息也要隐藏。
  return message
    .replace(/\bBearer\s+[^\s,;，；]+/giu, 'Bearer [已隐藏]')
    .replace(/\b(token|api[_-]?key|password|secret|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;，；]+)/giu, '$1=[已隐藏]')
    .replace(/\bhttps?:\/\/[^\s<>"'，；]+/giu, '[地址已隐藏]')
    .replace(/\b[A-Za-z]:[\\/][^\s<>"'，；]+/gu, '[路径已隐藏]')
    .replace(/(^|[\s("'=:：,;，；])\/[^\s,;，；<>"']+/gu, '$1[路径已隐藏]');
}

function originalMessage(value: unknown): string {
  const message = value instanceof Error || isRequestError(value) ? value.message :
    typeof value === 'string' ? value : '未提供可公开的错误说明，请通过日志查询原因';
  return diagnosticText(message);
}

function directReason(value: unknown): string {
  // 固定包装前缀留在诊断详情，用户首先看到服务已经确认的具体原因。
  const reason = originalMessage(value)
    .replace(/^(?:(?:依赖执行失败|工具依赖失败|应用启动失败|输入无效|任务执行失败|操作失败|操作冲突|资源不存在)[：:]\s*)+/u, '')
    .trim();
  return explainPublicError(reason);
}

function isResponseMismatch(error: RequestError): boolean {
  return error.kind === 'protocol' && (
    ['invalid_response', 'invalid_result', 'invalid_job', 'invalid_schema', 'invalid_execution',
      'incompatible_response', 'unsupported_protocol', 'invalid_device_directory',
      'invalid_device_provider', 'invalid_device_providers', 'invalid_device_directories'].includes(error.code) ||
    /^invalid_.*_(?:response|result)$/u.test(error.code)
  );
}

function isStaleReference(error: RequestError): boolean {
  if (['stale_provider', 'stale_device_reference', 'provider_generation_changed'].includes(error.code))
    return true;
  return (error.status === 409 || error.code === 'conflict') &&
    isStaleReason(error.message);
}

function isStaleReason(message: string): boolean {
  return /(?:提供者|设备|插件).*(?:代次|代际|引用).*(?:变化|过期|失效|不匹配|不一致)/u.test(message) ||
    /设备插件已更新.*设备信息已过期/u.test(message);
}

function isCancelled(value: unknown): boolean {
  return (isRequestError(value) && value.kind === 'cancelled') ||
    (value instanceof Error && value.name === 'AbortError');
}

export function describeActionError(error: unknown, refreshPage: () => void): ActionErrorFeedback {
  const reason = directReason(error);
  const request = isRequestError(error) ? error :
    error instanceof JobWaitFailure && isRequestError(error.cause) ? error.cause : null;
  const details: MessageDetail[] = [{ label: '原始错误', message: originalMessage(error) }];
  let logId = publicLogId(error);
  if (request) {
    details.push({ label: '错误代码', message: diagnosticText(request.code) });
    details.push({ label: '错误分类', message: request.kind });
    if (request.status !== null) details.push({ label: 'HTTP 状态', message: String(request.status) });
  }
  // 本次请求缺少编号与旧任务日志分别说明，不能将旧观测伪装成这次失败的响应。
  const missingLogId = request && !publicLogId(request)
    ? request.kind === 'network' && request.status === null
      ? '未收到服务器响应，未取得日志ID'
      : request.status !== null || request.kind === 'http'
        ? '服务器响应未提供日志ID'
        : '本次错误未取得日志ID'
    : null;
  if (missingLogId) details.push({ label: '本次请求日志', message: missingLogId });
  if (error instanceof JobFailure || error instanceof JobWaitFailure) {
    details.push({ label: '任务 ID', message: error.job.id });
    details.push({ label: '任务状态', message: error.job.status });
    if (error.submitLogId) details.push({
      label: '提交请求日志', message: '任务最初提交的请求；后台执行沿用此日志 ID。', logId: error.submitLogId,
    });
    if (error.logId) details.push({
      label: error instanceof JobWaitFailure ? '等待中断请求日志' : '任务响应日志',
      message: error instanceof JobWaitFailure
        ? '导致本次等待中断的请求，不代表任务最终结果。'
        : '返回任务状态的响应；查询成功不代表任务执行成功。',
      logId: error.logId,
    });
    if (error instanceof JobWaitFailure) {
      logId ??= error.lastKnownLogId;
      if (error.lastKnownLogId) details.push({
        label: '最近任务观测日志', message: '上次收到任务状态的响应，不代表当前任务已结束。',
        logId: error.lastKnownLogId,
      });
    }
    logId ??= error.submitLogId;
  }
  function feedback(
    title: string,
    description: string,
    refresh = false,
    level: ActionErrorFeedback['level'] = 'error',
  ): ActionErrorFeedback {
    const guidance = missingLogId ? `${missingLogId}。${description}` : description;
    return { level, title, options: {
      description: reason && reason !== title
        ? `${reason}${/[。！？.!?]$/u.test(reason) ? '' : '。'}${guidance}`
        : guidance,
      logId, details,
      ...(refresh ? { action: { label: '刷新页面', onClick: refreshPage } } : {}),
    } };
  }

  // 先看任务语义，不能把成功的查询响应或取消等待当成服务器任务终态。
  if (error instanceof JobFailure) {
    if (error.job.status === 'cancelled') return feedback('任务已取消',
      '服务器已报告任务取消，可在任务列表查看记录；已完成的部分不一定已回滚。', false, 'info');
    const stale = isStaleReason(error.message);
    return feedback(reason || '任务执行失败', stale
      ? '请先查询已有任务状态，再刷新页面并重新选择设备；不会自动重放本次操作。'
      : '请先处理上述原因，再决定是否重新执行；不会自动重放本次操作。', stale);
  }
  if (error instanceof JobWaitFailure) {
    if (isCancelled(error.cause)) return feedback('已停止等待任务',
      '仅停止当前页面等待，未确认服务器任务已取消。请按任务 ID 查询真实状态，不要直接重复提交。', false, 'info');
    const mismatch = request !== null && isResponseMismatch(request);
    return feedback('暂时无法确认任务状态', mismatch
      ? '任务已提交，但返回格式不兼容，页面可能落后于服务版本。请先保留任务 ID，再刷新页面查询真实状态，不要直接重复提交。'
      : '任务已提交，但状态等待中断。请检查服务连接，再按任务 ID 查询真实状态，不要直接重复提交。', mismatch, 'warning');
  }
  if (request) {
    if (isCancelled(request)) return feedback('已停止等待',
      '仅停止当前页面等待，操作是否已生效尚未确认。请先查询状态，不要直接重复提交。', false, 'info');
    if (request.kind === 'network') return feedback('暂时无法连接服务',
      '请检查服务是否运行及网络连接。操作是否已生效尚未确认，请先查询状态，不要直接重复提交。');
    if (isStaleReference(request)) return feedback(reason || '设备或插件引用已过期',
      '插件可能已更新，页面里的设备信息还未更新。请先查询已有任务状态，再刷新页面并重新选择设备；不会自动重放本次操作。', true);
    if (request.code === 'dependency_failed') return feedback(reason || '操作依赖不可用',
      '请按具体原因处理后再决定是否继续；刷新页面不能修复依赖问题。');
    if (request.status === 409 || request.code === 'conflict') return feedback(reason || '当前操作存在冲突',
      '请查看具体原因并查询最新任务或设备状态，确认对应资源是否仍在占用；不要直接重复提交。');
    if (isResponseMismatch(request)) return feedback('页面无法读取服务返回的数据',
      '页面可能落后于服务版本。请先保留任务信息，再刷新页面加载当前界面；刷新后先查询操作结果，不会自动重放操作。', true);
    if (request.status === 401 || request.status === 403) return feedback(reason || '服务拒绝访问',
      '请检查服务访问配置；恢复连接后先查询当前状态，再决定是否继续。');
    if (request.status === 429) return feedback(reason || '当前请求过多',
      '请稍后查询任务或资源状态，确认结果后再决定是否继续，不要连续重复提交。');
    if (request.kind === 'protocol') return feedback(reason || '请求未能通过检查',
      '请查看具体原因，核对输入和当前设备或插件状态后再继续。');
  }
  return feedback(reason || '操作未能完成', '请查看具体原因并查询当前状态，确认结果后再决定是否重新执行。');
}
