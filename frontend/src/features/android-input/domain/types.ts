import type { DeviceAccess, HostResult, Job } from '../../../plugin-sdk/index.ts';

export interface AndroidUnicodeInput {
  readonly text: string;
  readonly enter?: boolean;
}

export interface AndroidAsciiInputResult {
  readonly device_id: string;
  readonly action: 'text';
  readonly dispatched: true;
}

export interface AndroidUnicodeInputResult {
  readonly device_id: string;
  readonly action: 'text';
  readonly transport: 'adb_keyboard_base64';
  readonly bytes: number;
  readonly dispatched: true;
}

export type AndroidInputResult = AndroidAsciiInputResult | AndroidUnicodeInputResult;
export type AndroidInputResponse = HostResult<Job>;
export type AndroidInputDevices = Pick<DeviceAccess, 'snapshot' | 'invoke'>;
