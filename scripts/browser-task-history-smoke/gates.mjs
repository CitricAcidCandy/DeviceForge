// 门闩只延迟已经取得的真实HTTP回执；不创造业务响应或日志ID。
export function createGates(evidence) {
  const entries = new Map();
  let sequence = 0;
  let closed = false;
  evidence.gates = [];
  function find(id) {
    const entry = entries.get(id);
    if (!entry) throw new Error('未知验收门闩');
    return entry;
  }
  const snapshot = (entry) => ({
    id: entry.id,
    path: entry.path,
    state: entry.state,
    logId: entry.logId ?? null,
    status: entry.status ?? null,
    timedOut: entry.timedOut,
    disconnected: entry.disconnected,
    delivered: entry.delivered,
  });
  return {
    arm(path) {
      if (
        closed ||
        entries.size >= 16 ||
        typeof path !== 'string' ||
        !/^\/api\/v2\/jobs(?:\/[^/?]+(?:\/events)?)?(?:\?[^#]*)?$/.test(path)
      ) {
        throw new Error('验收门闩路径或数量非法');
      }
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const entry = {
        id: 'gate-' + ++sequence,
        path,
        state: 'armed',
        timedOut: false,
        disconnected: false,
        delivered: false,
      };
      Object.defineProperties(entry, { wait: { value: wait }, release: { value: release } });
      entries.set(entry.id, entry);
      evidence.gates.push(entry);
      return snapshot(entry);
    },
    status(id) {
      return snapshot(find(id));
    },
    release(id) {
      const entry = find(id);
      if (entry.state !== 'ready') throw new Error('门闩尚无真实回执');
      entry.state = 'released';
      entry.release();
      return snapshot(entry);
    },
    async hold(id, path, receipt, response) {
      const entry = find(id);
      if (closed || entry.path !== path || entry.state !== 'armed')
        throw new Error('门闩身份或路径不匹配');
      entry.state = 'ready';
      entry.logId = receipt.logId;
      entry.status = receipt.status;
      const disconnected = () => {
        entry.disconnected = true;
        entry.release();
      };
      response.once('close', disconnected);
      const timer = setTimeout(() => {
        entry.timedOut = true;
        entry.release();
      }, 6000);
      try {
        await entry.wait;
      } finally {
        clearTimeout(timer);
        response.off('close', disconnected);
      }
      return () => {
        entry.delivered = true;
      };
    },
    close() {
      closed = true;
      for (const entry of entries.values()) entry.release();
    },
  };
}
