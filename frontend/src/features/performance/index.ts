// 功能公开门面；调用者不依赖内部目录布局。
export * from './models/performance.ts';
export * from './models/http-factory.ts';
export {
  decodePerformanceCapabilities,
  isPerformancePage,
  isPerformanceSession,
  isPerformanceSessions,
  requireSession,
} from './utils/results.ts';
export { isDeviceObservation, isReadingDeviceObservation } from './utils/device-observation.ts';
