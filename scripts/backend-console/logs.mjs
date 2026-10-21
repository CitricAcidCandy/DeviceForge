import {
  advance,
  checkLimit,
  checkpointMatches,
  recent,
  snapshots,
  trailingState,
  withFile,
  OVERSIZED_LINE,
} from './log-reader.mjs';

const beijing = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hourCycle: 'h23',
});
const correlations = [
  'method',
  'route',
  'status',
  'code',
  'log_id',
  'job_id',
  'plugin_id',
  'plugin_version',
  'request_id',
  'plugin_request_id',
  'operation',
  'target_operation',
  'session_id',
  'generation',
  'cleanup',
  'success',
  'elapsed_us',
  'elapsed_ms',
];

function scalar(value, length = 160) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  return String(value)
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已遮蔽]')
    .replace(
      /\b(token|api[_-]?key|password|authorization|secret)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1=[已遮蔽]',
    )
    .slice(0, length);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function formatLog(record) {
  const source = object(record);
  const values = {};
  // 外层请求、当前任务及事件字段逐级覆盖，只显示受控关联白名单。
  for (const entry of [
    ...(Array.isArray(source.spans) ? source.spans.slice(-32) : []),
    source.span,
    source,
    source.fields,
  ]) {
    const fields = object(entry);
    for (const key of [...correlations, 'message']) {
      if (Object.hasOwn(fields, key)) values[key] = fields[key];
    }
  }
  const timestamp = typeof source.timestamp === 'string' ? new Date(source.timestamp) : null;
  const time =
    timestamp && Number.isFinite(timestamp.valueOf())
      ? `${beijing.format(timestamp)} +08:00`
      : '时间未知';
  const level = typeof source.level === 'string' ? source.level.toUpperCase() : 'INFO';
  const label = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].includes(level)
    ? level
    : 'UNKNOWN';
  const message = scalar(values.message, 512) || '未提供日志消息';
  const details = correlations.flatMap((key) => {
    const value = scalar(values[key]);
    if (!value) return [];
    // 路由仅展示路径或匹配模板，不显示查询及片段中的任意业务内容。
    const safe = key === 'route' ? value.split(/[?#]/, 1)[0] : value;
    return safe ? [`${key}=${safe}`] : [];
  });
  return `${time} [${label}] ${message}${details.length ? ` ${details.join(' ')}` : ''}`;
}

export async function readRecentRecords(logDirectory, limit = 20) {
  checkLimit(limit);
  return recent(await snapshots(logDirectory), limit);
}

export function createLogFollower(logDirectory, { write = console.log, initialLines = 20 } = {}) {
  checkLimit(initialLines);
  if (typeof write !== 'function') throw new Error('日志输出回调必须为函数');
  let initialized = false;
  let closed = false;
  let queue = Promise.resolve();
  let states = new Map();
  const notify = (message) => write(`[日志跟随] ${message}`);
  const emit = (item) => {
    if (item.notice) notify(item.notice);
    if (item.record) write(formatLog(item.record));
  };

  async function run() {
    if (closed) return;
    const files = await snapshots(logDirectory);
    if (!initialized) {
      const first = new Map();
      // 使用同一批 EOF 快照：历史显示后追加的字节留给下一轮，避免漏读。
      for (const file of files) {
        const state = await withFile(file, (handle) => trailingState(handle, file.size));
        if (state) {
          if (state.dropping) notify(OVERSIZED_LINE);
          first.set(file.identity, state);
        }
      }
      const records = await recent(files, initialLines, notify);
      for (const record of records) write(formatLog(record));
      states = first;
      initialized = true;
      return;
    }
    const next = new Map();
    for (const file of files) {
      // 同一 inode 改名后继续原偏移；真正新文件从第 0 字节跟随。
      const previous = next.get(file.identity) ?? states.get(file.identity);
      const state = previous ?? {
        offset: 0,
        pending: Buffer.alloc(0),
        dropping: false,
        checkpoint: Buffer.alloc(0),
      };
      const present = await withFile(file, async (handle, info) => {
        if (info.size < state.offset || !(await checkpointMatches(handle, state))) {
          state.offset = 0;
          state.pending = Buffer.alloc(0);
          state.dropping = false;
          state.checkpoint = Buffer.alloc(0);
          notify('检测到日志截断或改写，已从文件开头重新读取。');
        }
        await advance(handle, info.size, state, emit);
        return true;
      });
      if (present) next.set(file.identity, state);
    }
    states = next;
  }

  return {
    poll() {
      if (closed) return Promise.reject(new Error('日志跟随器已关闭'));
      const current = queue.then(run);
      // 仅保持串行队列可继续；本轮原始 Promise 的错误仍明确交给调用者。
      queue = current.catch(() => {});
      return current;
    },
    async close() {
      closed = true;
      await queue;
      states.clear();
    },
  };
}
