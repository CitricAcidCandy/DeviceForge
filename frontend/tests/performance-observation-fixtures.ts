import type { PerformanceDeviceObservation, PerformanceReading } from '../src/features/performance/index.ts';

export function deviceObservation(): PerformanceDeviceObservation {
  return {
    api_version: 1, scope: 'device', device_id: 'emulator-5554',
    battery: { observed_at: 1000, source: 'linux.power_supply.battery', access: 'adb_shell', voltage_uv: 4000000,
      current_ua: -2000000, current_polarity: 'positive_charging', status: 'discharging', supply_state: 'battery' },
    temperatures: [{ observed_at: 1000, source: 'android.thermalservice', access: 'adb_shell', sensor_kind: 'battery',
      sensor_name: '电池', sensor_type: 2, temperature_celsius: 36.5, status: 0 }],
  };
}

export function observationReading(): PerformanceReading {
  return { sequence: 1, captured_at: 1001, pid: 1, logical_cpus: 8, cpu_share_percent: null, cpu_core_percent: null,
    pss_kib: 100, rss_kib: null, fps: 0, device_observation: deviceObservation(), battery_net_power_mw: -8000 };
}
