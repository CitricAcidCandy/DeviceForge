import * as React from 'react';

export type PortalReporter = (element: HTMLElement) => () => void;
const PortalContext = React.createContext<PortalReporter | null>(null);

/** 只报告实际弹层节点及释放，不解释调用方身份、Portal位置或业务含义。 */
export function PortalBoundary({
  report, children,
}: { readonly report: PortalReporter; readonly children: React.ReactNode }) {
  return <PortalContext.Provider value={report}>{children}</PortalContext.Provider>;
}

/** 合并外部ref，兼容React 19回调释放，且不改变Content的其他属性。 */
export function usePortalContentRef<Element extends HTMLElement>(
  forwarded: React.Ref<Element> | undefined,
): React.RefCallback<Element> {
  const report = React.useContext(PortalContext);
  return React.useCallback((element) => {
    if (element === null) {
      if (typeof forwarded === 'function') forwarded(null);
      else if (forwarded) forwarded.current = null;
      return;
    }
    const release = report?.(element);
    let externalCleanup: void | (() => void);
    try {
      if (typeof forwarded === 'function') externalCleanup = forwarded(element);
      else if (forwarded) forwarded.current = element;
    } catch (error) {
      release?.();
      throw error;
    }
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      try { release?.(); }
      finally {
        if (typeof externalCleanup === 'function') externalCleanup();
        else if (typeof forwarded === 'function') forwarded(null);
        else if (forwarded) forwarded.current = null;
      }
    };
  }, [report, forwarded]);
}
