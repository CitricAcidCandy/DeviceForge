export interface GeneratedPluginService {
  readonly id: string;
  readonly version: string;
  readonly operation: string;
  readonly exportName: string;
}
export interface GeneratedPluginContracts {
  readonly source: string;
  readonly services: readonly GeneratedPluginService[];
}
