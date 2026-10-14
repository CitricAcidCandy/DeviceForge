// 功能公开门面；调用者不依赖内部目录布局。
export * from './models/spreadsheet.ts';
export * from './models/http-factory.ts';
export { decodeInspection, decodePage } from './utils/results.ts';
export { normalizeInspect, normalizeRead } from './utils/rules.ts';
