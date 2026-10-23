export interface Observation {
  at: string;
  owner_pid: number;
  processes: { pid: number; parent: number; executable: string }[];
  console_windows: { handle: string; pid: number; class_name: string }[];
}
export function windowsObservation(ownerPid: number): Promise<Observation>;
export function newConsoleWindows(before: Observation, after: Observation): Observation['console_windows'];
