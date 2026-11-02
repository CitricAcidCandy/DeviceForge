import { manifestPluginSources } from './manifest-sources.ts';

const manifests = import.meta.glob<unknown>('../../../plugins/*/manifest.json', { eager: true, import: 'default' });
const entries = import.meta.glob<unknown>('../../../plugins/*/src/index.ts');

export const officialSources = manifestPluginSources(manifests, entries);
