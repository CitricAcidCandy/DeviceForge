import { isRecord } from '../../shared/api/validation.ts';

const allowedKeys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).every((key) => names.includes(key));
const integer = (value: unknown, minimum: number, maximum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const source = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 80 && /^[a-zA-Z0-9._-]+$/.test(value);
const access = (value: unknown) => value === 'adb_shell' || value === 'root_shell';
const observed = (value: unknown, capturedAt: number) => integer(value, 0, Number.MAX_SAFE_INTEGER) && value <= capturedAt && capturedAt - value <= 10000;
const optional = (value: unknown) => value === undefined || value === null;

function validBattery(value: unknown, capturedAt: number): boolean {
  if (!isRecord(value) || !allowedKeys(value, ['observed_at', 'source', 'access', 'voltage_uv', 'current_ua', 'current_polarity', 'status', 'supply_state'])
    || !observed(value.observed_at, capturedAt) || !source(value.source) || !access(value.access)
    || !integer(value.voltage_uv, 1, 50000000)
    || !(optional(value.current_ua) || integer(value.current_ua, -100000000, 100000000))
    || !(typeof value.current_polarity === 'string' && ['positive_charging', 'positive_discharging', 'unknown'].includes(value.current_polarity))
    || !(optional(value.status) || typeof value.status === 'string' && ['unknown', 'charging', 'discharging', 'not_charging', 'full'].includes(value.status))
    || !(typeof value.supply_state === 'string' && ['battery', 'external', 'unknown'].includes(value.supply_state))) return false;
  if (optional(value.current_ua)) return value.current_polarity === 'unknown';
  if (value.current_polarity === 'unknown') return true;
  if (typeof value.current_ua !== 'number') return false;
  const chargingCurrent = value.current_polarity === 'positive_charging' ? value.current_ua : -value.current_ua;
  return !(value.status === 'charging' && chargingCurrent < 0 || value.status === 'discharging' && chargingCurrent > 0
    || value.supply_state === 'battery' && chargingCurrent > 0);
}

function validTemperature(value: unknown, capturedAt: number): boolean {
  if (!isRecord(value) || !allowedKeys(value, ['observed_at', 'source', 'access', 'sensor_kind', 'sensor_name', 'sensor_type', 'temperature_celsius', 'status'])
    || !observed(value.observed_at, capturedAt) || !source(value.source) || !access(value.access)
    || !(typeof value.sensor_kind === 'string' && ['cpu', 'gpu', 'battery', 'skin', 'other'].includes(value.sensor_kind))
    || typeof value.sensor_name !== 'string' || value.sensor_name.length === 0 || new TextEncoder().encode(value.sensor_name).length > 128
    || /[\u0000-\u001f\u007f-\u009f\ufffd]/.test(value.sensor_name)
    || !(optional(value.sensor_type) || integer(value.sensor_type, 0, 64) && ![6, 7, 8].includes(value.sensor_type))
    || typeof value.temperature_celsius !== 'number' || !Number.isFinite(value.temperature_celsius)
    || value.temperature_celsius < -273.15 || value.temperature_celsius > 400
    || !(optional(value.status) || integer(value.status, 0, 6))) return false;
  if (optional(value.sensor_type)) return true;
  if (typeof value.sensor_type !== 'number') return false;
  const kinds = ['cpu', 'gpu', 'battery', 'skin'];
  return value.sensor_kind === (kinds[value.sensor_type] ?? 'other');
}

// 缺省与 null 兼容历史；校验不修改输入、不查询当前设备目录。
export function isDeviceObservation(value: unknown, deviceId: string, capturedAt: number): boolean {
  if (optional(value)) return true;
  if (!isRecord(value) || !allowedKeys(value, ['api_version', 'scope', 'device_id', 'battery', 'temperatures'])
    || value.api_version !== 1 || value.scope !== 'device' || value.device_id !== deviceId
    || typeof value.device_id !== 'string' || value.device_id.trim().length === 0 || value.device_id.startsWith('-')
    || new TextEncoder().encode(value.device_id).length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(value.device_id)
    || !integer(capturedAt, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(value.temperatures) || value.temperatures.length > 32
    || !(optional(value.battery) || validBattery(value.battery, capturedAt))) return false;
  const temperatures: unknown[] = value.temperatures;
  if (optional(value.battery) && temperatures.length === 0) return false;
  const identities = new Set<string>();
  for (const temperature of temperatures) {
    if (!validTemperature(temperature, capturedAt) || !isRecord(temperature)) return false;
    const identity = JSON.stringify([temperature.source, temperature.sensor_type ?? null, temperature.sensor_name]);
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

