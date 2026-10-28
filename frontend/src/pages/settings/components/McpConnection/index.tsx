import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../../components/Button/index.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../../components/Table/index.tsx';
import { errorLogId, useAction } from '../../../../app/product/hooks.ts';
import type { ProductServices } from '../../../../app/product/services.ts';
import { settingsButtonClass, SettingsFailure } from '../../primitives.tsx';

export function McpConnection({ services }: { services: ProductServices }) {
  const [snapshot, setSnapshot] = useState(() => services.runtime.mcp.snapshot());
  const [listening, setListening] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  const release = useRef<(() => Promise<void>) | null>(null);
  const action = useAction();
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const origin =
    services.connection?.baseUrl ??
    (typeof location === 'undefined' ? 'http://localhost:7031' : location.origin);
  return (
    <section className="flex flex-col gap-4 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[15px]! font-medium! text-ink">MCP 连接</h3>
        <span className="text-[12px] text-muted-foreground">{listening ? '已订阅目录变化' : '未订阅'}</span>
      </div>
      <p>
        服务地址：<span className="break-all font-mono">{new URL('/mcp', origin).href}</span>
      </p>
      <p className="text-[12px] leading-6 text-muted-foreground">
        供支持 MCP 的客户端接入。这里核对真实工具目录；工具执行仍由对应客户端发起。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          className={settingsButtonClass}
          disabled={action.pending}
          onClick={() =>
            void action.run(async (signal) => {
              const result = await services.runtime.mcp.listTools(signal);
              if (!signal.aborted) setSnapshot(result);
              return result;
            })
          }
        >
          读取 MCP 工具目录
        </Button>
        <Button
          variant="outline"
          className={settingsButtonClass}
          disabled={listening || action.pending}
          onClick={() =>
            void action.run(async (signal) => {
              controller.current?.abort();
              const current = new AbortController();
              controller.current = current;
              setFailure(null);
              const active = AbortSignal.any([signal, current.signal]);
              const stop = await services.runtime.mcp.subscribe(
                {
                  changed: (next) => {
                    if (!active.aborted) setSnapshot(next);
                  },
                  error: (error) => {
                    if (!active.aborted) {
                      setFailure(error);
                      setListening(false);
                    }
                  },
                },
                active,
              );
              if (active.aborted) {
                await stop();
                return;
              }
              release.current = stop;
              setListening(true);
              return { logId: services.runtime.mcp.snapshot().logId };
            })
          }
        >
          订阅目录变化
        </Button>
        <Button
          variant="ghost"
          className={settingsButtonClass}
          disabled={!listening}
          onClick={() =>
            void action.run(async () => {
              controller.current?.abort();
              await release.current?.();
              release.current = null;
              setListening(false);
            })
          }
        >
          停止订阅
        </Button>
      </div>
      <SettingsFailure error={failure ?? action.error} logId={failure ? errorLogId(failure) : action.logId} />
      {snapshot.version === 0 ? (
        <p className="text-[12px] leading-6 text-muted-foreground">尚未读取 MCP 目录。目录来源与 HTTP 操作目录独立核对。</p>
      ) : snapshot.tools.length === 0 ? (
        <p className="text-[12px] leading-6 text-muted-foreground">服务器返回空工具目录。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>工具</TableHead>
              <TableHead>说明</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshot.tools.map((tool) => (
              <TableRow key={tool.name}>
                <TableCell>
                  {tool.title ?? tool.name}
                  <small className="block break-all font-mono text-[12px] text-muted-foreground">{tool.name}</small>
                </TableCell>
                <TableCell>
                  {tool.description ?? '没有公开说明'}
                  <details>
                    <summary>输入契约</summary>
                    <pre className="max-w-full overflow-x-auto py-3 font-mono text-[12px]">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                  </details>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
