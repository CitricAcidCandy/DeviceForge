import { ApiError, jobEndpoint, logQueryEndpoint, isLogIdentifier, isLogSearchText } from '../../../services/api/index.ts';
import type { ApiClient, ApiResult, JobDto, LogSearchDto, LogOrder } from '../../../services/api/index.ts';

export interface TaskLookup {
  readonly query: string;
  readonly jobs: readonly JobDto[];
  readonly logs: LogSearchDto | null;
  readonly missingJobIds: readonly string[];
}

export async function lookupTask(client: ApiClient, id: string, signal: AbortSignal): Promise<ApiResult<TaskLookup>> {
  if (!isLogIdentifier(id)) throw new ApiError('protocol', 'invalid_input', '请填写完整的任务 ID 或日志 ID');
  return searchTasks(client, id, signal);
}

export async function searchTasks(client: ApiClient, query: string, signal: AbortSignal, order?: LogOrder): Promise<ApiResult<TaskLookup>> {
  const id = query.trim();
  if (!isLogSearchText(id)) throw new ApiError('protocol', 'invalid_input', '请填写 1 至 128 字节的搜索词或完整编号');
  const byId = isLogIdentifier(id);
  // 查不到任务才按日志编号查询；全流程只读，共用五秒预算并继承调用方取消。
  const current = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  if (byId) try {
    const job = await client.call(jobEndpoint, id, current);
    if (job.data.id.toLowerCase() !== id.toLowerCase())
      throw new ApiError('protocol', 'invalid_response', '服务返回的任务编号与本次查询不一致', 200, job.logId);
    return { logId: job.logId, data: { query: id, jobs: [job.data], logs: null, missingJobIds: [] } };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  let logs: ApiResult<LogSearchDto>;
  try { logs = await client.call(logQueryEndpoint, { ...(byId ? { log_id: id } : { q: id }), ...(order ? { order } : {}) }, current); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404)
      throw new ApiError('http', 'log_search_unavailable', '当前服务尚不支持按日志 ID 查询，请升级服务后再试', 404, error.logId);
    if (error instanceof ApiError && error.status === 400 && error.code === 'invalid_input' && order)
      throw new ApiError('http', 'log_search_unavailable', '服务器不接受当前日志查询参数，请更新服务后重试', 400, error.logId);
    throw error;
  }
  if (byId ? logs.data.log_id?.toLowerCase() !== id.toLowerCase() : logs.data.log_id !== null)
    throw new ApiError('protocol', 'invalid_response', '服务返回的日志编号与本次查询不一致', 200, logs.logId);
  const jobs: JobDto[] = [];
  const missingJobIds: string[] = [];
  // 每批最多四个只读请求；日志仍可查看，不因已清理的历史任务整轮失败。
  for (let index = 0; index < logs.data.job_ids.length; index += 4) {
    const found = await Promise.all(logs.data.job_ids.slice(index, index + 4).map(async (jobId) => {
      try {
        const response = await client.call(jobEndpoint, jobId, current);
        if (response.data.id.toLowerCase() !== jobId.toLowerCase())
          throw new ApiError('protocol', 'invalid_response', '服务返回的关联任务编号不一致', 200, response.logId);
        return response.data;
      }
      catch (error) {
        if (error instanceof ApiError && error.status === 404) { missingJobIds.push(jobId); return null; }
        throw error;
      }
    }));
    jobs.push(...found.filter((job): job is JobDto => job !== null));
  }
  if (current.aborted) throw new ApiError('cancelled', 'cancelled', '日志查询等待已结束', null, logs.logId);
  return { logId: logs.logId, data: { query: id, jobs, logs: logs.data, missingJobIds } };
}
