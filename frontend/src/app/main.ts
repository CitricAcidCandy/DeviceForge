import { mount } from 'svelte';
import App from './App.svelte';
import './styles.css';
import { createFrontendBootstrap } from './bootstrap.ts';

export function startFrontendApp(documentRef: Document, windowRef: Window) {
  const target = documentRef.getElementById('app');
  if (!target) throw new Error('应用挂载节点不存在');
  mount(App, { target });
  const bootstrap = createFrontendBootstrap({
    target,
    baseUrl: windowRef.location.origin,
    transport: windowRef.fetch.bind(windowRef),
  });
  const dispose = () => { void bootstrap.dispose(); };
  windowRef.addEventListener('pagehide', dispose, { once: true });
  return bootstrap;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') startFrontendApp(document, window);
