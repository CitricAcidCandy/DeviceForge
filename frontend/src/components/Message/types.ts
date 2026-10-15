export type MessageLevel = 'success' | 'info' | 'warning' | 'error' | 'loading';

export interface MessageDetail {
  readonly label: string;
  readonly message: string;
  readonly logId?: string | null;
}

export interface MessageOptions {
  readonly id?: string;
  readonly description?: string;
  readonly logId?: string | null;
  readonly details?: readonly MessageDetail[];
  readonly action?: { readonly label: string; readonly onClick: () => void };
}

export interface GlobalMessage extends MessageOptions {
  readonly id: string;
  readonly level: MessageLevel;
  readonly title: string;
}

export interface MessageController {
  success(title: string, options?: MessageOptions): string;
  info(title: string, options?: MessageOptions): string;
  warning(title: string, options?: MessageOptions): string;
  error(title: string, options?: MessageOptions): string;
  loading(title: string, options?: MessageOptions): string;
  dismiss(id: string): void;
  clear(): void;
  snapshot(): readonly GlobalMessage[];
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
