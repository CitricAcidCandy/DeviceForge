import { useEffect, useRef, useState } from 'react';
import type { HostContext } from '@deviceforge/plugin-sdk';
import { createShellFacts } from './facts.ts';
import { waiting } from './facts-rules.ts';
import type { ShellFacts } from './facts-rules.ts';

export function useShellFacts(context: HostContext) {
  const [snapshot, setSnapshot] = useState<ShellFacts>(() => ({ endpoint: waiting(), plugins: waiting() }));
  const current = useRef<ReturnType<typeof createShellFacts> | null>(null);
  useEffect(() => {
    const model = createShellFacts(context);
    current.current = model;
    const unsubscribe = model.subscribe(() => setSnapshot(model.snapshot()));
    const release = context.onDispose(model.dispose);
    setSnapshot(model.snapshot()); model.start();
    return () => {
      if (current.current === model) current.current = null;
      void unsubscribe(); void Promise.resolve().then(release).catch(() => undefined);
    };
  }, [context]);
  return { snapshot, refresh: () => current.current?.refresh() };
}
