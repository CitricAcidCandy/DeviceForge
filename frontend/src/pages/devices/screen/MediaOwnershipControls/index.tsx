import { useEffect } from 'react';
import { Button } from '../../../components/Button/index.tsx';
import { ActionFeedback } from '../../../app/product/feedback.tsx';
import { useAction } from '../../../app/product/hooks.ts';
import type { createWebRtcMirroring, MirroringOwnership } from '../../../features/mirroring-streaming/index.ts';

type OwnershipActions = Pick<ReturnType<typeof createWebRtcMirroring>,
  'requestControl' | 'respondControl' | 'reclaimControl' | 'releaseControl'>;

export function MediaOwnershipControls({ state, ready, actions }: {
  readonly state: MirroringOwnership | null;
  readonly ready: boolean;
  readonly actions: OwnershipActions;
}) {
  const action = useAction();
  useEffect(() => () => { action.cancel(); }, [action.cancel, ready, state?.clientId]);
  if (!state) return <p className="muted" role="status">正在确认设备控制权，画面可继续观看。</p>;
  if (!state.canControl) return <p className="muted" role="status">当前为只读观看，无法操作设备或接收设备剪贴板。</p>;
  const disabled = !ready || action.pending || state.transitioning || state.blocked;
  const requested = state.requests.some((request) => request.clientId === state.clientId);
  const status = state.blocked ? '设备控制暂不可用，画面可继续观看。'
    : state.transitioning ? '正在交接设备控制权…'
      : state.hasControl ? '你正在控制设备，设备内复制的文字只同步到你的电脑。'
        : state.ownerId === null ? '当前没有控制者，可以申请接管。'
          : requested ? '已申请接管，等待当前控制者处理。'
            : '其他客户端正在控制设备，你可以申请接管。';
  return (
    <section className="settings-group media-ownership" aria-label="设备控制权">
      <p role="status">{status}</p>
      <div className="action-row">
        {!state.hasControl && (
          <Button
            variant="outline"
            disabled={disabled || requested}
            onClick={() => void action.run(actions.requestControl, { pending: '正在申请控制权…' })}
          >
            {requested ? '等待接管批准' : '申请接管'}
          </Button>
        )}
        {state.isMaster && !state.hasControl && (
          <Button
            disabled={!ready || action.pending}
            onClick={() => void action.run(actions.reclaimControl, { pending: '正在抢回控制权…' })}
          >
            主控抢回
          </Button>
        )}
        {state.hasControl && (
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void action.run(actions.releaseControl, { pending: '正在释放控制权…' })}
          >
            释放控制权
          </Button>
        )}
      </div>
      {state.hasControl && state.requests.length > 0 && (
        <ul aria-label="待处理控制申请">
          {state.requests.map((request) => (
            <li key={request.clientId}>
              <span>{request.isMaster ? '主控客户端' : `观看者 ${request.clientId.slice(0, 8)}`}申请接管</span>
              <Button
                disabled={disabled}
                onClick={() => void action.run((signal) => actions.respondControl(request.clientId, true, signal),
                  { pending: '正在批准接管…' })}
              >同意</Button>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => void action.run((signal) => actions.respondControl(request.clientId, false, signal),
                  { pending: '正在拒绝接管…' })}
              >拒绝</Button>
            </li>
          ))}
        </ul>
      )}
      <ActionFeedback {...action} />
    </section>
  );
}
