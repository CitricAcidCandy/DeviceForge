import { ApiError } from '@deviceforge/plugin-sdk';
import type {
  HostContext, JsonValue, PointContributionInfo, PointDefinitionInfo, WorkspaceCatalog,
  WorkspaceDefinitionInfo, WorkspaceInstance, WorkspacePageInfo, WorkspaceViewInfo,
} from '@deviceforge/plugin-sdk';
import { isRecord } from '@deviceforge/business-kit/api';
import { isJsonData } from '@deviceforge/business-kit/jobs';

const ref = { id: 'host.ui-directory', version: '1' };
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const mode = (value: unknown) => value === 'append' || value === 'replace';
function pointProvider(value: unknown) { return isRecord(value) && text(value.pluginId) && natural(value.generation); }
function definition(value: unknown): value is PointDefinitionInfo {
  return isRecord(value) && text(value.id) && text(value.version) && text(value.title) && isJsonData(value.inputSchema) &&
    Array.isArray(value.modes) && value.modes.every(mode) && pointProvider(value.provider);
}
function contribution(value: unknown): value is Omit<PointContributionInfo, 'data'> {
  return isRecord(value) && text(value.id) && isRecord(value.point) && text(value.point.id) && text(value.point.version) &&
    typeof value.order === 'number' && Number.isFinite(value.order) && mode(value.mode) &&
    pointProvider(value.provider) && ['waiting', 'version_mismatch', 'invalid', 'active'].includes(String(value.state)) &&
    (value.reason === null || ['point_missing', 'version_mismatch', 'mode_not_allowed', 'data_invalid'].includes(String(value.reason))) &&
    typeof value.selected === 'boolean' && !Object.hasOwn(value, 'payload') && !Object.hasOwn(value, 'data');
}
function workspace(value: unknown): value is WorkspaceDefinitionInfo {
  return isRecord(value) && text(value.id) && text(value.pluginId) && natural(value.generation) && text(value.title);
}
function page(value: unknown): value is WorkspacePageInfo {
  if (!isRecord(value) || !workspace(value) || !text(value.route) ||
      !(value.workspaceId === null || text(value.workspaceId)) ||
      !(value.viewId === undefined || value.viewId === null || text(value.viewId)) ||
      !(value.operations === undefined || Array.isArray(value.operations) && value.operations.every(text)) ||
      !(value.taskPolicy === undefined || value.taskPolicy === 'listed' || value.taskPolicy === 'all')) return false;
  if (value.navigation === undefined) return true;
  const navigation = value.navigation;
  return isRecord(navigation) && ['group', 'icon', 'description'].every((key) =>
    navigation[key] === undefined || typeof navigation[key] === 'string') &&
    (navigation.order === undefined || typeof navigation.order === 'number' && Number.isFinite(navigation.order)) &&
    (navigation.hidden === undefined || typeof navigation.hidden === 'boolean');
}
function view(value: unknown): value is WorkspaceViewInfo {
  return isRecord(value) && workspace(value) && Array.isArray(value.provides) && value.provides.every(text);
}
function instance(value: unknown): value is Omit<WorkspaceInstance, 'target'> {
  return isRecord(value) && text(value.instanceId) && text(value.pluginId) && text(value.workspaceId) &&
    (value.provider === null || isRecord(value.provider) && text(value.provider.pluginId) && text(value.provider.viewId)) &&
    typeof value.visible === 'boolean' && natural(value.generation) &&
    (value.providerGeneration === null || natural(value.providerGeneration)) &&
    ['ready', 'missing', 'unselected'].includes(String(value.state)) &&
    (value.reason === null || ['provider_missing', 'owner_inactive', 'provider_unselected'].includes(String(value.reason))) &&
    !Object.hasOwn(value, 'target');
}
export interface UiDirectory {
  readonly revision: number;
  readonly slots: { readonly known: boolean; readonly entries: readonly {
    readonly id: string; readonly modes: readonly ('append' | 'replace')[]; readonly ready: boolean;
  }[] };
  readonly points: { readonly known: boolean; readonly definitions: readonly PointDefinitionInfo[];
    readonly contributions: readonly Omit<PointContributionInfo, 'data'>[] };
  readonly ui: { readonly known: boolean; readonly catalog: WorkspaceCatalog;
    readonly instances: readonly Omit<WorkspaceInstance, 'target'>[] };
}
export function decodeUiDirectory(value: JsonValue, logId: string | null): UiDirectory {
  const invalid = () => new ApiError('protocol', 'invalid_marketplace_ui_directory', '界面目录格式不兼容，无法确认挂载状态', null, logId);
  function array<T>(value: unknown, guard: (entry: unknown) => entry is T): readonly T[] {
    if (!Array.isArray(value)) throw invalid();
    const entries: readonly unknown[] = value;
    if (!entries.every(guard)) throw invalid();
    return entries;
  }
  if (!isRecord(value) || value.snapshotVersion !== 1 || !natural(value.revision)) throw invalid();
  const { slots, points, ui } = value;
  if (!isRecord(slots) || typeof slots.known !== 'boolean' || !Array.isArray(slots.entries) ||
      !slots.entries.every((entry: unknown) => isRecord(entry) && text(entry.id) &&
        Array.isArray(entry.modes) && entry.modes.every(mode) && typeof entry.ready === 'boolean') ||
      !isRecord(points) || typeof points.known !== 'boolean' || !Array.isArray(points.definitions) ||
      !points.definitions.every(definition) || !Array.isArray(points.contributions) || !points.contributions.every(contribution) ||
      !isRecord(ui) || typeof ui.known !== 'boolean' || !isRecord(ui.catalog) ||
      !Array.isArray(ui.catalog.pages) || !ui.catalog.pages.every(page) ||
      !Array.isArray(ui.catalog.workspaces) || !ui.catalog.workspaces.every(workspace) ||
      !Array.isArray(ui.catalog.views) || !ui.catalog.views.every(view) ||
      !Array.isArray(ui.instances) || !ui.instances.every(instance)) throw invalid();
  return {
    revision: value.revision,
    slots: { known: slots.known, entries: slots.entries.map((entry) => {
      if (!isRecord(entry) || !text(entry.id) || !Array.isArray(entry.modes) || !entry.modes.every(mode) || typeof entry.ready !== 'boolean') throw invalid();
      return { id: entry.id, ready: entry.ready, modes: entry.modes };
    }) },
    points: { known: points.known, definitions: array(points.definitions, definition), contributions: array(points.contributions, contribution) },
    ui: { known: ui.known, catalog: {
      pages: array(ui.catalog.pages, page), workspaces: array(ui.catalog.workspaces, workspace), views: array(ui.catalog.views, view),
    }, instances: array(ui.instances, instance) },
  };
}
export function createUiDirectoryClient(context: HostContext) {
  return {
    async snapshot(signal: AbortSignal) {
      if (!context.services) throw new ApiError('protocol', 'marketplace_ui_directory_unavailable', '宿主未提供界面目录');
      const result = await context.services.call(ref, { action: 'snapshot' }, signal);
      return { data: decodeUiDirectory(result.data, result.logId), logId: result.logId };
    },
    subscribe(listener: () => void) {
      return context.extensions?.subscribeEvent('host.ui-directory.changed', listener) ?? (() => undefined);
    },
  };
}
