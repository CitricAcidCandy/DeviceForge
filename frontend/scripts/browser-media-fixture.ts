import type {
  DeviceDirectoryDto,
  DeviceProviderDto,
  OperationDto,
  SessionInfo,
} from '../src/services/api/index.ts';
import { dfml, dfmlChunks, digest, pcm } from './browser-media-stream.ts';
import type { MediaMaterial } from './browser-media-stream.ts';

export const mediaSessionId = '42345678-1234-4234-8234-123456789abc';
const screenshotId = '52345678-1234-4234-8234-123456789abc';
const movieId = '62345678-1234-4234-8234-123456789abc';
export interface MediaRequest {
  readonly method: string;
  readonly path: string;
  readonly input: unknown;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export async function createMediaFixture(material: MediaMaterial) {
  const requests: MediaRequest[] = [];
  const blobs = new Map<string, Blob>([[screenshotId, material.screenshot]]);
  if (material.movie) blobs.set(movieId, material.movie);
  const artifact = async (id: string, filename: string, blob: Blob) => ({
    id,
    filename,
    media_type: blob.type,
    size: blob.size,
    sha256: await digest(blob),
    created_at: 1,
  });
  const screenshot = await artifact(screenshotId, 'screenshot.png', material.screenshot);
  const movie = material.movie ? await artifact(movieId, 'screen.mp4', material.movie) : null;
  const providers: DeviceProviderDto[] = ['media.first', 'media.second'].map((id) => ({
    id,
    generation: 'generation-1',
    version: '1.0.0',
    definition: {
      api_version: 1,
      platform: '受控 Android 能力提供者',
      discover_operation: 'plugin.android-device.discover',
      capabilities: [
        {
          id: 'screenshot',
          version: 1,
          operation: 'plugin.android-device.screenshot',
          scope: 'device',
          access: 'read',
        },
      ],
    },
  }));
  const operations: OperationDto[] = [
    'plugin.android-device.screenshot',
    'plugin.mirroring.record',
    'plugin.mirroring.runtime.status',
  ].map((id) => ({ id, title: id, input_schema: { type: 'object' } }));
  const directory = (provider: DeviceProviderDto): DeviceDirectoryDto => ({
    provider,
    observed_at: 1,
    discovery_job_id: 'fixture-discovery',
    devices: [
      {
        reference: {
          provider_id: provider.id,
          generation: provider.generation,
          local_id: 'emulator-fixture',
        },
        model: '受控媒体设备',
        state: 'online',
        capabilities: [{ id: 'screenshot', version: 1, available: true, reason: null }],
      },
    ],
  });
  const first = material.frames[0];
  if (!first) throw new Error('原生媒体素材缺少首帧');
  let chunks: readonly number[][] = dfmlChunks([
    dfml(5, { state: 'connecting', attempt: 0 }),
    dfml(1, { codec: 'h264', format: 'annexb', width: 64, height: 64 }),
    dfml(2, material.configuration, 2),
    dfml(5, { state: 'streaming', attempt: 0 }),
    dfml(2, first.bytes, 1, first.timestamp),
    dfml(3, { codec: 'pcm_s16le', sample_rate: 48000, channels: 2 }),
    dfml(4, pcm()),
  ]);
  const firstCount = chunks.length;
  let abortedOutput = 0;
  let sequence = 0;
  let session: SessionInfo = {
    id: mediaSessionId,
    operation: 'plugin.mirroring.open',
    plugin_id: 'mirroring',
    generation: 'generation-1',
    created_at: 1,
    output_sequence: 0,
    status: 'opening',
  };
  const jobs = new Map<string, unknown>();
  const held = new Set<{ after: number; finish(): void; reject(): void }>();
  const response = (data: unknown, status = 200) =>
    new Response(JSON.stringify({ log_id: 'media-fixture-log', data }), {
      status,
      headers: { 'content-type': 'application/json', 'x-deviceforge-log-id': 'media-fixture-log' },
    });
  function page(after: number, limit: number) {
    const selected = chunks.slice(after, after + limit);
    return {
      session: { ...session, output_sequence: chunks.length },
      chunks: selected.map((bytes, index) => ({
        sequence: after + index + 1,
        stream: 'stdout',
        bytes,
      })),
      next_sequence: after + selected.length,
    };
  }
  const transport: typeof fetch = async (resource, options) => {
    const url = resource instanceof Request ? new URL(resource.url) : new URL(String(resource));
    const method = options?.method ?? 'GET';
    const input: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
    requests.push({ method, path: url.pathname + url.search, input });
    const signal = options?.signal;
    if (signal?.aborted) throw new DOMException('媒体受控请求已取消', 'AbortError');
    if (url.pathname === '/api/v2/operations') return response(operations);
    if (url.pathname === '/api/v2/device-providers') return response(providers);
    if (url.pathname === '/api/v2/devices') return response(providers.map(directory));
    if (url.pathname === '/api/v2/session-definitions')
      return response({
        revision: 1,
        sessions: [
          {
            id: 'plugin.mirroring.open',
            title: '受控原生媒体直播',
            input_schema: { type: 'object' },
          },
        ],
      });
    if (url.pathname === '/api/v2/sessions' && method === 'POST') {
      session = { ...session, status: 'opening', output_sequence: 0 };
      return response(session, 201);
    }
    if (url.pathname === `/api/v2/sessions/${mediaSessionId}/output`) {
      const after = Number(url.searchParams.get('after'));
      const limit = Number(url.searchParams.get('limit'));
      if (after < chunks.length || session.status === 'finished') {
        if (session.status !== 'finished')
          session = { ...session, status: 'running', output_sequence: chunks.length };
        return response(page(after, limit));
      }
      return new Promise<Response>((resolve, reject) => {
        const cleanup = () => {
          held.delete(entry);
          signal?.removeEventListener('abort', entry.reject);
        };
        const entry = {
          after,
          finish() {
            cleanup();
            resolve(response(page(after, limit)));
          },
          reject() {
            cleanup();
            abortedOutput++;
            reject(new DOMException('输出等待已取消', 'AbortError'));
          },
        };
        held.add(entry);
        signal?.addEventListener('abort', entry.reject, { once: true });
      });
    }
    if (
      url.pathname === `/api/v2/sessions/${mediaSessionId}/input` ||
      url.pathname.endsWith('/eof')
    )
      return response({ id: mediaSessionId, accepted: true });
    if (url.pathname === `/api/v2/sessions/${mediaSessionId}/cancel`) {
      session = {
        ...session,
        status: 'finished',
        output_sequence: chunks.length,
        completion: { cleanup: 'complete', process_exited: true },
      };
      for (const entry of [...held]) entry.finish();
      return response(session);
    }
    if (url.pathname === `/api/v2/sessions/${mediaSessionId}`)
      return response({ ...session, output_sequence: chunks.length });
    if (url.pathname.startsWith('/api/v2/artifacts/') && url.pathname.endsWith('/content')) {
      const id = url.pathname.slice('/api/v2/artifacts/'.length, -'/content'.length);
      const blob = blobs.get(id);
      if (!blob) throw new Error('受控媒体产物不存在');
      return new Response(blob, {
        headers: { 'content-type': blob.type, 'x-deviceforge-log-id': 'media-fixture-download' },
      });
    }
    if (
      url.pathname === '/api/v2/device-actions' ||
      (url.pathname === '/api/v2/jobs' && method === 'POST')
    ) {
      if (!object(input)) throw new Error('受控媒体任务输入无效');
      const body = object(input['input']) ? input['input'] : {};
      const operation = url.pathname.endsWith('device-actions')
        ? 'plugin.android-device.screenshot'
        : String(input['operation']);
      const result = operation.endsWith('.screenshot')
        ? { result: {}, artifacts: [screenshot] }
        : operation.endsWith('.record') && movie
          ? {
              result: {
                device_id: body['device_id'],
                duration_ms: 1000,
                codec: 'h264',
                filename: 'screen.mp4',
                size: movie.size,
                live_stream: false,
              },
              artifacts: [movie],
            }
          : {
              result: {
                available: true,
                version: 'fixture',
                live_stream: true,
                live_configured: true,
                recording: true,
              },
              artifacts: [],
            };
      const job = {
        id: `media-job-${++sequence}`,
        operation,
        input: body,
        created_at: 1,
        status: 'succeeded',
        result,
        error: null,
      };
      jobs.set(job.id, job);
      return response(job, 201);
    }
    if (url.pathname.startsWith('/api/v2/jobs/'))
      return response(jobs.get(url.pathname.slice('/api/v2/jobs/'.length)));
    return response(null, 404);
  };
  return {
    transport,
    requests,
    providers,
    firstCount,
    screenshot,
    movie,
    append(index: number) {
      const frame = material.frames[index];
      if (!frame) throw new Error('原生素材缺少追加帧');
      chunks = [...chunks, ...dfmlChunks([dfml(2, frame.bytes, 1, frame.timestamp)])];
      session = { ...session, output_sequence: chunks.length };
      for (const entry of [...held]) entry.finish();
    },
    held: () => held.size,
    aborted: () => abortedOutput,
    dispose() {
      for (const entry of [...held]) entry.reject();
    },
  };
}
