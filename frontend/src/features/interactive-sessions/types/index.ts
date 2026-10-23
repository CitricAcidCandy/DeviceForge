import type {
  ApiError,
  SessionDefinitions,
  SessionInfo,
  SessionOutputPage,
  SessionOutputQuery,
} from '../../../services/api/index.ts';

export type SessionAction =
  | 'definitions'
  | 'records'
  | 'open'
  | 'resume'
  | 'query'
  | 'output'
  | 'input'
  | 'eof'
  | 'cancel'
  | 'release_record'
  | 'remove_record'
  | 'remove';
export type SessionInfoView = Readonly<SessionInfo>;
export type SessionChunkView = Readonly<
  Omit<SessionOutputPage['chunks'][number], 'bytes'> & { bytes: readonly number[] }
>;
export type SessionDefinitionsView = Readonly<
  Omit<SessionDefinitions, 'sessions'> & {
    sessions: readonly Readonly<SessionDefinitions['sessions'][number]>[];
  }
>;
export type SessionInputState = 'unknown' | 'writable' | 'eof_pending' | 'eof' | 'uncertain';
export interface InteractiveSessionSnapshot {
  readonly definitions: SessionDefinitionsView | null;
  readonly records: readonly SessionInfoView[];
  readonly session: SessionInfoView | null;
  readonly chunks: readonly SessionChunkView[];
  readonly cursor: number;
  readonly inputState: SessionInputState;
  readonly pending: readonly SessionAction[];
  readonly logs: Readonly<Partial<Record<SessionAction, string | null>>>;
  readonly errors: Readonly<Partial<Record<SessionAction, ApiError>>>;
}
export interface InteractiveSessionOptions {
  readonly pollIntervalMs?: number;
}
/** 终端业务协议中的字符网格尺寸，不是浏览器像素。 */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}
export type SessionReadOptions = Pick<SessionOutputQuery, 'limit'>;
