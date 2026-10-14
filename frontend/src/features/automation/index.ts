// 功能公开门面；调用者不依赖内部目录布局。
export * from './models/automation.ts';
export * from './models/http-factory.ts';
export { requireRepeat, requireSequence } from './utils/rules.ts';
export { requireDesktopClick, requireInputTrace } from './utils/desktop-rules.ts';
export { decodeAutomationResult } from './utils/results.ts';
export {
  decodeDesktopClick,
  decodeDesktopPosition,
  decodeDesktopRepeat,
  decodeInputTracePlayback,
  decodeInputTraceRecord,
} from './utils/desktop-results.ts';
