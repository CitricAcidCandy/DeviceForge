/** 发行装配只补样式所有权，身份仍由单清单的 CLI 包装注入。 */
export function workspacePluginEntry(): string {
  return `import implementation from './index.js';
import { acquireStyles } from './styles.js';
export default async function createPlugin(identity) {
  const plugin = typeof implementation === 'function' ? await implementation(identity) : implementation;
  if (!plugin || typeof plugin !== 'object') throw new Error('插件入口没有返回 SDK 对象');
  return { ...plugin, async activate(context) {
    context.signal.throwIfAborted();
    const release = acquireStyles(globalThis.document);
    context.onDispose(release);
    try { await plugin.activate?.call(plugin, context); }
    catch (error) { release(); throw error; }
  } };
}
`;
}
