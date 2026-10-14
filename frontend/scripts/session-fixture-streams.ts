import type { SessionInfo, SessionOutputPage } from '../src/shared/api/index.ts';

export const fixtureReply = (data: unknown, status = 200) => Response.json({log_id: 'session-fixture-log', data}, {status, headers: {'x-deviceforge-log-id': 'session-fixture-log'}});
export const fixtureObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sdkThread = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const cliThread = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const encoder = new TextEncoder();
interface RecordState {info: SessionInfo; chunks: SessionOutputPage['chunks']; result: unknown; automatic: boolean}

export function createSessionStreamFixture() {
  const records = new Map<string, RecordState>(); const held = new Map<string, () => void>();
  const heldOperations = new Set<string>(); let aborted = 0;
  function seed(operation: string, input: Record<string, unknown>, automatic: boolean) {
    const sdk = operation === 'plugin.ai-sdk.sdk.stream'; const terminal = operation === 'plugin.terminal.open';
    const thread = typeof input['thread_id'] === 'string' ? input['thread_id'] : sdk ? sdkThread : cliThread;
    const text = sdk ? 'SDK 实时中文🙂' : 'CLI 实时中文🙂';
    const events = [{format_version: 1, type: 'thread.started', thread_id: thread}, {format_version: 1, type: 'turn.started'},
      {format_version: 1, type: 'item.started', item: {id: 'item_1', type: 'agent_message', text: '实时'}},
      {format_version: 1, type: 'item.updated', item: {id: 'item_1', type: 'agent_message', text}},
      {format_version: 1, type: 'item.completed', item: {id: 'item_1', type: 'agent_message', text}}, {format_version: 1, type: 'turn.completed'}];
    const bytes = encoder.encode(terminal ? '终端中文🙂\n' : events.map(event => JSON.stringify(event)).join('\r\n') + '\r\n');
    const chunks: SessionOutputPage['chunks'] = [];
    // 刻意让中文和表情跨字节片段，验证真实页面解码与序号消费。
    const size = terminal ? 2 : 37;
    for (let offset = 0; offset < bytes.length; offset += size) chunks.push({sequence: chunks.length + 1, stream: 'stdout', bytes: [...bytes.subarray(offset, offset + size)]});
    const id = crypto.randomUUID();
    const info: SessionInfo = {id, operation, plugin_id: terminal ? 'terminal' : sdk ? 'ai-sdk' : 'ai-assistant', generation: 'fixture-generation', created_at: 1, status: 'running', output_sequence: chunks.length, completion: null};
    const result = terminal ? null : {project_id: input['project_id'], thread_id: thread, text, turns: input['thread_id'] ? '2' : '1',
      ...(sdk ? {provider: 'codex_sdk', sdk_version: '0.162.1', resource_scope: 'sdk_worker_proxy_and_cli'} : {provider: 'codex_cli', stream_format_version: 1, resource_scope: 'direct_process'})};
    records.set(id, {info, chunks, result, automatic}); return id;
  }
  function complete(id: string) {
    const state = records.get(id); if (!state) throw new Error('受控会话不存在');
    state.info = {...state.info, status: 'finished', completion: {outcome: {result: state.result, error: null, artifacts: []}, cleanup: 'complete', process_exited: true, sequence: 1, failure: null}};
    held.get(id)?.();
  }
  const sdkRecovery = seed('plugin.ai-sdk.sdk.stream', {project_id: 'sdk-project'}, true);
  const cliRecovery = seed('plugin.ai-assistant.cli.stream', {project_id: 'cli-project'}, true);
  async function handle(url: URL, method: string, input: unknown, signal: AbortSignal | null | undefined): Promise<Response | null> {
    if (url.pathname === '/api/v2/session-definitions') return fixtureReply({revision: 1, sessions: ['plugin.terminal.open', 'plugin.ai-sdk.sdk.stream', 'plugin.ai-assistant.cli.stream'].map(id => ({id, title: id, input_schema: {type: 'object'}, execution: {api_version: 1, source: 'declared', total_timeout_ms: 600000}}))});
    if (url.pathname === '/api/v2/sessions') {
      if (method === 'GET') return fixtureReply([...records.values()].map(state => state.info));
      if (!fixtureObject(input) || !fixtureObject(input['input']) || typeof input['operation'] !== 'string') throw new Error('受控会话输入形状无效');
      const id = seed(input['operation'], input['input'], !heldOperations.has(input['operation']) && input['operation'] !== 'plugin.terminal.open');
      const state = records.get(id); if (!state) throw new Error('会话种子未建立');
      return fixtureReply({...state.info, status: 'opening', output_sequence: 0}, 202);
    }
    const match = /^\/api\/v2\/sessions\/([^/]+)(?:\/(output|input|eof|cancel))?$/.exec(url.pathname);
    if (!match?.[1]) return null;
    const id = match[1]; const state = records.get(id); if (!state) throw new Error(`受控会话未登记：${id}`);
    if (method === 'DELETE') {records.delete(id); return fixtureReply({id});}
    if (match[2] === 'input' || match[2] === 'eof') return fixtureReply({id, accepted: true});
    if (match[2] === 'cancel') {state.info = {...state.info, status: 'stopping'}; return fixtureReply(state.info);}
    if (match[2] !== 'output') {if (state.info.status === 'stopping') complete(id); return fixtureReply(state.info);}
    const after = Number(url.searchParams.get('after') ?? 0); const limit = Number(url.searchParams.get('limit') ?? 50);
    const page = () => {
      const chunks = state.chunks.slice(after, after + limit);
      return fixtureReply({session: state.info, chunks, next_sequence: after + chunks.length});
    };
    if (state.automatic && state.info.status !== 'finished') complete(id);
    if (after < state.chunks.length || state.info.status === 'finished') return page();
    return new Promise<Response>((resolve, reject) => {
      const finish = () => {held.delete(id); signal?.removeEventListener('abort', cancelled); resolve(page());};
      const cancelled = () => {aborted++; held.delete(id); reject(new DOMException('受控输出等待已取消', 'AbortError'));};
      held.set(id, finish); signal?.addEventListener('abort', cancelled, {once: true});
      if (signal?.aborted) cancelled();
    });
  }
  return {handle, complete, sdkRecovery, cliRecovery, hold(operation: string) {heldOperations.add(operation);},
    latest(operation: string) {return [...records.values()].filter(state => state.info.operation === operation).at(-1)?.info.id;},
    pending: () => held.size, aborted: () => aborted, dispose() {for (const id of held.keys()) complete(id);}};
}
