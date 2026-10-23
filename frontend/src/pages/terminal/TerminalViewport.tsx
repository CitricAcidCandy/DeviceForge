import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { SessionChunkView, TerminalSize } from '../../features/interactive-sessions/index.ts';
import { createTerminalOutputCursor } from './output-cursor.ts';

export interface TerminalViewportHandle {
  size(): TerminalSize;
  clear(): void;
  focus(): void;
}

interface Props {
  readonly chunks: readonly SessionChunkView[];
  readonly writable: boolean;
  readonly handle: { current: TerminalViewportHandle | null };
  readonly onData: (text: string) => void;
  readonly onResize: (size: TerminalSize) => void;
}

export function TerminalViewport(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const emulator = useRef<Terminal | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(createTerminalOutputCursor());

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('../../../node_modules/@xterm/xterm/css/xterm.css'),
      ]);
      if (disposed || !container.current) return;
      const node = container.current;
      const terminal = new Terminal({
        cols: 120,
        rows: 30,
        scrollback: 5000,
        fontFamily: 'Cascadia Code, Consolas, "Microsoft YaHei", monospace',
        fontSize: 14,
        lineHeight: 1.25,
        cursorBlink: true,
        screenReaderMode: true,
        allowTransparency: true,
        theme: {
          background: '#11140f',
          foreground: '#edf0e5',
          cursor: '#d8e5a5',
          selectionBackground: '#73834f80',
        },
      });
      const fit = new FitAddon();
      // 从第一项资源开始登记释放，初始化的任意一步失败也走同一个收口。
      dispose = () => {
        emulator.current = null;
        terminal.dispose();
      };
      terminal.loadAddon(fit);
      terminal.open(node);
      emulator.current = terminal;
      terminal.options.disableStdin = !latest.current.writable;
      terminal.textarea?.setAttribute('aria-label', '终端输入');
      const data = terminal.onData((text) => {
        if (latest.current.writable) latest.current.onData(text);
      });
      const disposeTerminal = dispose;
      dispose = () => {
        data.dispose();
        disposeTerminal();
      };
      terminal.attachCustomKeyEventHandler((event) => {
        // 普通Ctrl+C始终交给终端；显式复制组合键不落成程序输入。
        if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
          event.preventDefault();
          if (event.type === 'keydown' && terminal.hasSelection()) {
            if (navigator.clipboard) {
              void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {
                if (!disposed) setError('复制失败，请使用浏览器的复制菜单');
              });
            } else document.execCommand('copy');
          }
          return false;
        }
        return true;
      });
      let frame = 0;
      const disposeEvents = dispose;
      dispose = () => {
        cancelAnimationFrame(frame);
        disposeEvents();
      };
      const resize = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (disposed || node.clientWidth === 0 || node.clientHeight === 0) return;
          const proposed = fit.proposeDimensions();
          if (!proposed) return;
          const size = {
            cols: Math.max(20, Math.min(500, proposed.cols)),
            rows: Math.max(5, Math.min(200, proposed.rows)),
          };
          if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
            terminal.resize(size.cols, size.rows);
            latest.current.onResize(size);
          }
        });
      };
      const observer = new ResizeObserver(resize);
      const disposeFrame = dispose;
      dispose = () => {
        observer.disconnect();
        disposeFrame();
      };
      observer.observe(node);
      const handle: TerminalViewportHandle = {
        size: () => ({ cols: terminal.cols, rows: terminal.rows }),
        clear: () => terminal.write('\u001b[2J\u001b[H\u001b[3J'),
        focus: () => terminal.focus(),
      };
      latest.current.handle.current = handle;
      const disposeObserver = dispose;
      dispose = () => {
        if (latest.current.handle.current === handle) latest.current.handle.current = null;
        disposeObserver();
      };
      resize();
      setReady(true);
      terminal.focus();
    })().catch((failure: unknown) => {
      dispose();
      dispose = () => {};
      if (!disposed) setError(failure instanceof Error ? failure.message : '终端显示组件加载失败');
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    const terminal = emulator.current;
    if (!terminal || !ready) return;
    // 首次测量可能早于会话可写；启用按键前补发当前尺寸，仍走页面的串行输入队列。
    if (props.writable) latest.current.onResize({ cols: terminal.cols, rows: terminal.rows });
    terminal.options.disableStdin = !props.writable;
  }, [props.writable, ready]);

  useEffect(() => {
    const terminal = emulator.current;
    if (!terminal || !ready) return;
    cursor.current.append(props.chunks, (bytes) => terminal.write(bytes));
  }, [props.chunks, ready]);

  return (
    <div
      className="terminal-viewport relative min-h-[320px] flex-1 bg-[#11140f]"
      aria-label="终端输出"
    >
      <div
        ref={container}
        className="terminal-emulator absolute inset-3 [&_.xterm]:h-full [&_.xterm]:p-0 [&_.xterm-viewport]:[scrollbar-width:thin] [&_.xterm-helper-textarea]:min-h-0 [&_.xterm-helper-textarea]:min-w-0"
      />
      {error && (
        <p role="alert" className="relative z-10 p-4 text-sm text-red-300">
          终端加载失败：{error}
        </p>
      )}
      {!ready && !error && <p className="relative z-10 p-4 text-sm text-white/60">正在准备终端…</p>}
    </div>
  );
}
