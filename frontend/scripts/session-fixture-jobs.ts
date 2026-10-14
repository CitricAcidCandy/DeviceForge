import { cliThread, fixtureObject, fixtureReply, sdkThread } from './session-fixture-streams.ts';

interface StoredArtifact {
  readonly metadata: {
    id: string;
    filename: string;
    media_type: string;
    size: number;
    sha256: string;
    created_at: number;
  };
  readonly bytes: Uint8Array<ArrayBuffer>;
}
export async function createSessionJobFixture() {
  const artifacts = new Map<string, StoredArtifact>();
  const names = new Map<string, StoredArtifact>();
  const jobs = new Map<string, unknown>();
  async function store(filename: string, bytes: Uint8Array<ArrayBuffer>, mediaType = 'text/plain') {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    const metadata = {
      id: crypto.randomUUID(),
      filename,
      media_type: mediaType,
      size: bytes.length,
      sha256,
      created_at: 1,
    };
    const artifact = { metadata, bytes };
    artifacts.set(metadata.id, artifact);
    names.set(filename, artifact);
    return artifact;
  }
  for (const name of [
    'operation.json',
    'frida.log',
    'permissions.js',
    'script.js',
    'notices.jsonl',
    'input-trace.log',
  ])
    await store(
      name,
      new TextEncoder().encode(name.endsWith('.log') ? `受控 ${name} 日志🙂` : '{}'),
    );
  await store(
    'recording.msgpack',
    new Uint8Array([0x81, 0xa5, 0x65, 0x76, 0x65, 0x6e, 0x74, 0x01]),
    'application/msgpack',
  );
  function envelope(result: unknown, filenames: readonly string[] = []) {
    return {
      result,
      artifacts: filenames.map((name) => {
        const entry = names.get(name);
        if (!entry) throw new Error(`受控产物未登记：${name}`);
        return entry.metadata;
      }),
    };
  }
  function result(operation: string, request: Record<string, unknown>): unknown {
    const input =
      operation.startsWith('plugin.frida.') && fixtureObject(request['input'])
        ? request['input']
        : request;
    if (operation === 'plugin.frida.server.status')
      return envelope(
        {
          installed: true,
          running: true,
          pids: [321],
          version_output: '16.7.0',
          ownership: 'observed_only',
        },
        ['operation.json', 'frida.log'],
      );
    if (operation === 'plugin.frida.processes')
      return envelope(
        { source: 'frida-ps --json', processes: [{ pid: 123, name: '受控应用进程' }] },
        ['operation.json', 'frida.log'],
      );
    if (operation === 'plugin.frida.server.deploy')
      return envelope({ deployed: true, version_output: '16.7.0', root_required: true }, [
        'operation.json',
        'frida.log',
      ]);
    if (operation === 'plugin.frida.server.run')
      return envelope(
        {
          pid: 321,
          process_start_ticks: 1000,
          duration_ms: input['duration_ms'],
          cleanup: 'confirmed',
          ownership: 'invocation',
        },
        ['operation.json', 'frida.log'],
      );
    if (operation === 'plugin.frida.script.run' || operation === 'plugin.frida.permissions.analyze')
      return envelope(
        {
          package: input['package'],
          mode: input['mode'],
          duration_requested_ms: input['duration_ms'],
          cli_timeout_seconds: Math.ceil(Number(input['duration_ms']) / 1000),
          loaded: true,
          resume: input['mode'] === 'spawn' ? 'cli_default' : 'already_running',
          notice_count: 3,
          hook_summary: [{ type: 'summary', calls: 3 }],
          cleanup: 'direct_cli_confirmed',
          target_process_cleanup: 'not_claimed',
        },
        [
          'operation.json',
          'frida.log',
          operation.endsWith('analyze') ? 'permissions.js' : 'script.js',
          'notices.jsonl',
        ],
      );
    if (
      operation === 'plugin.automation.sequence.run' ||
      operation === 'plugin.automation.click.repeat'
    )
      return envelope({
        device_id: input['device_id'],
        dispatched: Array.isArray(input['steps']) ? input['steps'].length : input['count'],
        completed: true,
        effect_confirmed: false,
      });
    if (operation === 'plugin.automation.windows.mouse.position')
      return envelope({
        x: -1920,
        y: 120,
        coordinate_space: 'virtual_desktop',
        source: 'GetCursorPos',
      });
    const position = fixtureObject(input['position']) ? input['position'] : { x: -1920, y: 120 };
    if (operation === 'plugin.automation.windows.mouse.click')
      return envelope({
        dispatched: 1,
        button: input['button'],
        click: input['click'],
        position,
        effect_confirmed: false,
      });
    if (operation === 'plugin.automation.windows.mouse.repeat') {
      const repeat = fixtureObject(input['repeat']) ? input['repeat'] : {};
      return envelope({
        dispatched: repeat['kind'] === 'count' ? repeat['count'] : 3,
        stop_reason:
          repeat['kind'] === 'count'
            ? 'count_limit'
            : repeat['kind'] === 'duration'
              ? 'duration'
              : 'manual_limit',
        button: input['button'],
        click: input['click'],
        position,
        elapsed_ms: 1000,
        effect_confirmed: false,
      });
    }
    if (operation === 'plugin.automation.input_trace.record')
      return envelope(
        {
          recorded: true,
          event_type: input['event_type'],
          duration_ms: input['duration_ms'],
          events: 5,
          stop: 'stdin_exit',
          format: 'input_trace.msgpack.v1',
          effect_confirmed: false,
        },
        ['recording.msgpack', 'operation.json', 'input-trace.log'],
      );
    if (operation === 'plugin.automation.input_trace.playback')
      return envelope(
        {
          completed: true,
          event_type: input['event_type'],
          events: 5,
          format: 'input_trace.msgpack.v1',
          effect_confirmed: false,
        },
        ['operation.json', 'input-trace.log'],
      );
    const sdk = operation.startsWith('plugin.ai-sdk.');
    if (operation.endsWith('runtime.status'))
      return envelope(
        sdk
          ? {
              provider: 'codex_sdk',
              sdk_version: '0.162.1',
              profile: 'codex_sdk_ts_0_162_1_node24',
              configured: true,
              node_version: '24.0.0',
              cli_version: '0.162.1',
              sdk_loaded: true,
              process_scope_qualified: true,
              model_verified: true,
              ready: true,
              projects: ['sdk-project'],
              reason: null,
              resource_scope: 'sdk_worker_proxy_and_cli',
            }
          : { configured: true, provider: 'codex_cli', projects: ['cli-project'] },
      );
    if (operation.endsWith('session.get') || operation.endsWith('session.close'))
      return envelope({
        project_id: input['project_id'],
        thread_id: input['thread_id'],
        turns: '2',
        closed: operation.endsWith('close'),
        uncertain: false,
        ...(sdk
          ? {
              provider: 'codex_sdk',
              sdk_version: '0.162.1',
              profile: 'codex_sdk_ts_0_162_1_node24',
              resource_scope: 'sdk_worker_proxy_and_cli',
            }
          : {}),
      });
    if (operation.startsWith('plugin.ai-')) {
      const thread =
        typeof input['thread_id'] === 'string' ? input['thread_id'] : sdk ? sdkThread : cliThread;
      const text = `${sdk ? 'SDK' : 'CLI'} ${operation.endsWith('single') ? '单次' : operation.endsWith('assistant.run') ? '编排' : '续聊'}回答`;
      return envelope({
        project_id: input['project_id'],
        thread_id: thread,
        text,
        ...(sdk
          ? {
              provider: 'codex_sdk',
              sdk_version: '0.162.1',
              turns: '1',
              resource_scope: 'sdk_worker_proxy_and_cli',
              ...(operation.endsWith('assistant.run')
                ? { assistant_turns: '1', stream_output: false }
                : {}),
            }
          : {
              events: [{ type: 'thread.started', thread_id: thread }, { type: 'turn.completed' }],
            }),
      });
    }
    throw new Error(`未列出的受控任务：${operation}`);
  }
  async function handle(
    url: URL,
    method: string,
    input: unknown,
    body: BodyInit | null | undefined,
  ): Promise<Response | null> {
    if (url.pathname === '/api/v2/jobs' && method === 'POST') {
      if (
        !fixtureObject(input) ||
        typeof input['operation'] !== 'string' ||
        !fixtureObject(input['input'])
      )
        throw new Error('受控任务输入形状无效');
      const id = crypto.randomUUID();
      const job = {
        id,
        operation: input['operation'],
        input: input['input'],
        created_at: 1,
        status: 'succeeded',
        result: result(input['operation'], input['input']),
      };
      jobs.set(id, job);
      return fixtureReply(job, 201);
    }
    if (url.pathname.startsWith('/api/v2/jobs/')) {
      const job = jobs.get(url.pathname.slice('/api/v2/jobs/'.length));
      if (!job) throw new Error('受控任务不存在');
      return fixtureReply(job);
    }
    if (url.pathname === '/api/v2/artifacts' && method === 'POST') {
      if (!(body instanceof Blob)) throw new Error('上传未使用原字节 Blob');
      const entry = await store(
        url.searchParams.get('filename') ?? 'upload.bin',
        new Uint8Array(await body.arrayBuffer()),
        body.type || 'application/octet-stream',
      );
      return fixtureReply(entry.metadata, 201);
    }
    const match = /^\/api\/v2\/artifacts\/([^/]+)(?:\/(content))?$/.exec(url.pathname);
    if (!match?.[1]) return null;
    const entry = artifacts.get(match[1]);
    if (!entry) throw new Error('受控产物身份不存在');
    return match[2]
      ? new Response(entry.bytes, {
          headers: {
            'content-type': entry.metadata.media_type,
            'x-deviceforge-log-id': 'session-fixture-log',
          },
        })
      : fixtureReply(entry.metadata);
  }
  return { handle, recordingId: names.get('recording.msgpack')?.metadata.id };
}
