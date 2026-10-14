import assert from 'node:assert/strict';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;

export function authenticatedClient(base, mcp, report, phase, token) {
  const logIds = new Set();
  let requestId = 0;
  const call = async (path, options = {}, context = {}) => {
    const { authenticate = true, ...request } = options;
    const pending = {
      ...context,
      phase,
      path,
      method: request.method ?? 'GET',
      started_at: new Date().toISOString(),
    };
    const headers = new Headers({ 'content-type': 'application/json', ...request.headers });
    if (authenticate && token) headers.set('authorization', `Bearer ${token}`);
    let response, body;
    try {
      response = await fetch(path === '/mcp' ? mcp : base + path, {
        signal: AbortSignal.timeout(20000),
        ...request,
        headers,
      });
      body = await response.json();
      const logId = response.headers.get('x-deviceforge-log-id');
      report.last_request = {
        ...pending,
        status: response.status,
        code: body.error?.code,
        log_id: logId,
      };
      report.requests.push({ ...report.last_request, outcome: 'returned' });
      assert.match(logId, uuid);
      if (path.startsWith('/api/v2/')) assert.equal(body.log_id, logId);
      logIds.add(logId);
      return { status: response.status, body, logId };
    } catch (error) {
      const failed = {
        ...pending,
        status: response?.status,
        log_id: response?.headers.get('x-deviceforge-log-id'),
        error_name: error.name,
        error_code: error.code,
      };
      report.failed_request ??= failed;
      report.requests.push({ ...failed, outcome: 'threw' });
      throw error;
    }
  };
  const json = async (path, options = {}, context = {}) => {
    const { status = 200, code, ...request } = options;
    const reply = await call(path, request, context);
    assert.equal(reply.status, status, path);
    if (code) assert.equal(reply.body.error?.code, code, path);
    else {
      assert.equal(reply.body.error, undefined);
      assert.ok(Object.hasOwn(reply.body, 'data'));
    }
    return code ? reply.body.error : reply.body.data;
  };
  const post = (path, input, options = {}, context = {}) =>
    json(
      path,
      {
        method: 'POST',
        ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
        ...options,
      },
      context,
    );
  const rpc = async (method, params, context = {}) => {
    const id = ++requestId;
    const reply = await call(
      '/mcp',
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          origin: base,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      },
      context,
    );
    assert.equal(reply.status, 200);
    assert.equal(reply.body.id, id);
    assert.equal(reply.body.error, undefined);
    assert.equal(reply.body.result._meta['deviceforge/log_id'], reply.logId);
    return reply.body.result;
  };
  const tool = async (name, input = {}, code, context = {}) => {
    const result = await rpc('tools/call', { name, arguments: input }, { tool: name, ...context });
    assert.equal(result.isError, Boolean(code), name);
    if (code) assert.equal(result.structuredContent.code, code, name);
    return result.structuredContent;
  };
  const job = (id, context = {}) => json(`/api/v2/jobs/${id}`, {}, context);
  const scoped = (context) => ({
    json: (path, options) => json(path, options, context),
    post: (path, input, options) => post(path, input, options, context),
    tool: (name, input, code) => tool(name, input, code, context),
    job: (id) => job(id, context),
  });
  return {
    base,
    mcp,
    logIds,
    call,
    ...scoped({}),
    scope: scoped,
    tools: async () => {
      const names = [];
      let cursor;
      do {
        const page = await rpc('tools/list', cursor ? { cursor } : {});
        names.push(...page.tools.map((item) => item.name));
        assert.ok(names.length <= 4200);
        if (page.nextCursor) assert.notEqual(page.nextCursor, cursor);
        cursor = page.nextCursor;
      } while (cursor);
      return names;
    },
  };
}
