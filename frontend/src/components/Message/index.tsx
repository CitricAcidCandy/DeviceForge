import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { AlertCircle, CheckCircle2, Info, LoaderCircle, X } from 'lucide-react';
import { Button } from '../Button/index.tsx';
import { copyText } from '../../shared/clipboard/index.ts';
import type { GlobalMessage, MessageController } from './types.ts';
import './styles.css';

export { createMessageController } from './controller.ts';
export type {
  GlobalMessage,
  MessageController,
  MessageDetail,
  MessageLevel,
  MessageOptions,
} from './types.ts';

const MessageContext = createContext<MessageController | null>(null);

export function useMessage(): MessageController | null {
  return useContext(MessageContext);
}

function MessageItem({ item, controller }: { item: GlobalMessage; controller: MessageController }) {
  const Icon =
    item.level === 'success'
      ? CheckCircle2
      : item.level === 'loading'
        ? LoaderCircle
        : item.level === 'info'
          ? Info
          : AlertCircle;
  const diagnostics = item.details ?? [];
  const logId = item.logId?.trim() ? item.logId : null;
  const hasDetails = Boolean(logId || diagnostics.length || item.level === 'error');
  async function copyLogId(value: string) {
    if (await copyText(value)) {
      controller.success('日志 ID 已复制', { id: 'message-copy' });
    } else {
      controller.warning('复制失败，请手动选择日志 ID', { id: 'message-copy', logId: value });
    }
  }
  return (
    <ToastPrimitive.Root
      className="global-message"
      data-message-id={item.id}
      data-message-kind={item.level}
      open
      type={item.level === 'error' ? 'foreground' : 'background'}
      duration={
        item.level === 'loading'
          ? 2_147_483_647
          : item.level === 'error' || item.level === 'warning'
            ? 9000
            : 3500
      }
      onOpenChange={(open) => {
        if (!open) controller.dismiss(item.id);
      }}
    >
      <Icon
        className={item.level === 'loading' ? 'message-icon inline-spinner' : 'message-icon'}
        aria-hidden="true"
      />
      <div className="message-content">
        <ToastPrimitive.Title className="message-title">{item.title}</ToastPrimitive.Title>
        {item.description && (
          <ToastPrimitive.Description className="message-description">
            {item.description}
          </ToastPrimitive.Description>
        )}
        {item.action && (
          <Button
            variant="ghost"
            size="sm"
            className="message-action"
            onClick={item.action.onClick}
          >
            {item.action.label}
          </Button>
        )}
        {logId && (
          <div className="message-log">
            <code className="select-text">{logId}</code>
            <Button
              variant="ghost"
              size="sm"
              aria-label="复制消息日志 ID"
              onClick={() => { void copyLogId(logId); }}
            >
              复制
            </Button>
          </div>
        )}
        {hasDetails && (
          <details className="message-diagnostics" data-message-details>
            <summary>查看详情</summary>
            <div className="message-diagnostics-content">
              {item.level === 'error' && <p>{item.title}</p>}
              {diagnostics.map((detail, index) => (
                <div className="message-detail" key={`${detail.label}-${index}`}>
                  <strong>{detail.label}</strong>
                  <p>{detail.message}</p>
                  {detail.logId?.trim() && (
                    <div className="message-log">
                      <code className="select-text">{detail.logId}</code>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`复制${detail.label}日志 ID`}
                        onClick={() => {
                          void copyLogId(detail.logId ?? '');
                        }}
                      >
                        复制
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
      <ToastPrimitive.Close asChild>
        <Button variant="ghost" size="icon" className="message-close" aria-label="关闭消息">
          <X />
        </Button>
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

export function MessageProvider({
  controller,
  children,
}: {
  controller: MessageController;
  children: ReactNode;
}) {
  const messages = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  return (
    <MessageContext.Provider value={controller}>
      <ToastPrimitive.Provider label="全局消息" swipeDirection="up">
        {children}
        {messages.map((item) => (
          <MessageItem key={item.id} item={item} controller={controller} />
        ))}
        <ToastPrimitive.Viewport
          className="global-message-viewport"
          data-global-message-root
          aria-label="全局消息提示"
        />
      </ToastPrimitive.Provider>
    </MessageContext.Provider>
  );
}
