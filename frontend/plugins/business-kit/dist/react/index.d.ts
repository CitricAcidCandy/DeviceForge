import type { Dispose } from '@deviceforge/plugin-sdk';
import type { OperationSource } from "../platform.js";
export interface SnapshotSource<T> {
    snapshot(): T;
    subscribe(listener: (snapshot: T) => void): Dispose;
}
export declare function useSnapshot<T>(source: SnapshotSource<T>): T;
export interface ActionOptions {
    readonly quiet?: boolean;
    readonly errorFeedback?: 'message' | 'inline';
    readonly pending?: string;
    readonly success?: string | null;
}
export declare function useAction(): {
    run: (action: (signal: AbortSignal) => Promise<unknown>, _options?: ActionOptions) => Promise<unknown>;
    cancel: () => void;
    pending: boolean;
    error: unknown;
    result: unknown;
    logId: string | null;
};
export declare function ErrorNotice({ error }: {
    error: unknown;
}): import("react").JSX.Element | null;
export declare function ActionFeedback(props: {
    pending: boolean;
    error: unknown;
    logId: string | null;
    cancel(): void;
}): import("react").JSX.Element;
export declare function useOperationAvailable(services: {
    readonly operations: OperationSource;
}, operation: string): boolean;
export declare function OperationNotice(props: {
    readonly services: {
        readonly operations: OperationSource;
    };
    readonly operation: string;
}): import("react").JSX.Element | null;
