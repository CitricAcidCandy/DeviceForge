import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import { abortable } from "../api/index.js";
export function useSnapshot(source) {
    const store = useMemo(() => {
        let current = source.snapshot();
        return {
            get: () => current,
            subscribe: (notify) => {
                const release = source.subscribe((next) => { current = next; notify(); });
                return () => { void release(); };
            },
        };
    }, [source]);
    return useSyncExternalStore(store.subscribe, store.get, store.get);
}
function logId(error) {
    if (!error || typeof error !== 'object')
        return null;
    for (const field of ['logId', 'lastKnownLogId', 'submitLogId']) {
        if (field in error) {
            const value = Reflect.get(error, field);
            if (typeof value === 'string')
                return value;
        }
    }
    return null;
}
export function useAction() {
    const [state, setState] = useState({
        pending: false, error: null, result: null, logId: null,
    });
    const active = useRef(null), mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; active.current?.abort(); };
    }, []);
    const cancel = useCallback(() => {
        active.current?.abort();
        active.current = null;
        if (mounted.current)
            setState((current) => ({ ...current, pending: false }));
    }, []);
    const run = useCallback(async (action, _options = {}) => {
        active.current?.abort();
        const current = new AbortController();
        active.current = current;
        setState((previous) => ({ ...previous, pending: true, error: null }));
        try {
            const result = await abortable(action(current.signal), current.signal);
            if (mounted.current && active.current === current && !current.signal.aborted)
                setState({ pending: false, error: null, result, logId: logId(result) });
            return result;
        }
        catch (error) {
            if (mounted.current && active.current === current && !current.signal.aborted)
                setState((previous) => ({ ...previous, pending: false, error, logId: logId(error) }));
            return undefined;
        }
        finally {
            if (active.current === current)
                active.current = null;
        }
    }, []);
    return { ...state, run, cancel };
}
export function ErrorNotice({ error }) {
    if (!error)
        return null;
    const { ErrorNotice: Notice } = hostUi();
    return _jsx(Notice, { message: error instanceof Error ? error.message : '操作未完成，请查询真实状态', logId: logId(error) });
}
export function ActionFeedback(props) {
    const { Button } = hostUi();
    return _jsxs(_Fragment, { children: [props.pending && _jsxs("div", { role: "status", className: "flex flex-wrap items-center gap-2 text-xs text-muted-foreground", children: ["\u6B63\u5728\u7B49\u5F85\u7ED3\u679C", _jsx(Button, { variant: "ghost", size: "xs", onClick: props.cancel, children: "\u505C\u6B62\u7B49\u5F85" }), _jsx("span", { children: "\u4EC5\u505C\u6B62\u9875\u9762\u7B49\u5F85\uFF0C\u4E0D\u4EE3\u8868\u540E\u53F0\u4EFB\u52A1\u5DF2\u53D6\u6D88\u3002" })] }), _jsx(ErrorNotice, { error: props.error })] });
}
export function useOperationAvailable(services, operation) {
    return useSnapshot(services.operations).result?.data.some((item) => item.id === operation) ?? false;
}
export function OperationNotice(props) {
    const state = useSnapshot(props.services.operations);
    if (state.pending)
        return _jsx("p", { className: "text-xs text-muted-foreground", children: "\u6B63\u5728\u6838\u5BF9\u80FD\u529B" });
    return state.result?.data.some((item) => item.id === props.operation) ? null :
        _jsx("p", { className: "text-xs text-muted-foreground", children: "\u5F53\u524D\u670D\u52A1\u5668\u5C1A\u672A\u63D0\u4F9B\u6B64\u529F\u80FD\uFF0C\u8BF7\u52A0\u8F7D\u5BF9\u5E94\u63D2\u4EF6\u540E\u5237\u65B0\u76EE\u5F55\u3002" });
}
