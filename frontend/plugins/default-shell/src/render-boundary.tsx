import { Component } from 'react';
import type { ReactNode } from 'react';

interface Props { readonly children: ReactNode; readonly onFailure: (error: Error) => void }
interface State { readonly failure: Error | null; readonly history: readonly string[] }

/** 宿主已接纳挂载后的异常也必须可见；显式重试不重建业务挂载池或重放任务。 */
export class ShellRenderBoundary extends Component<Props, State> {
  override state: State = { failure: null, history: [] };
  static getDerivedStateFromError(error: unknown): Pick<State, 'failure'> {
    return { failure: error instanceof Error ? error : new Error('工作区渲染失败') };
  }
  override componentDidCatch(error: Error) {
    this.setState((current) => ({ history: [...current.history, error.message].slice(-20) }));
    this.props.onFailure(error);
  }
  override render() {
    const { failure, history } = this.state;
    if (!failure) return <>
      {this.props.children}
      {history.length > 0 && <span className="sr-only">显示故障历史 {history.length}</span>}
    </>;
    return <section role="alert" className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-3 overflow-auto bg-[#F5F6FB] p-6 text-center text-[#222631]">
      <h2 className="text-base font-semibold">工作区显示中断</h2>
      <p className="max-w-xl break-words text-sm text-[#A65D0D]">{failure.message}</p>
      <p className="max-w-xl text-xs leading-6 text-[#596479]">已保留工作区登记、布局和可复用的业务视图。重新显示不会重新派发之前的任务。</p>
      <button type="button" onClick={() => this.setState({ failure: null })}
        className="rounded-md border border-[#E6EAF3] bg-white px-4 py-2 text-sm text-[#6C4CF5] hover:bg-[#F0EBFF] focus-visible:outline-2 focus-visible:outline-[#6C4CF5]">
        重新显示工作区
      </button>
      <span className="text-xs text-[#8790A2]">显示故障历史 {history.length}</span>
    </section>;
  }
}
