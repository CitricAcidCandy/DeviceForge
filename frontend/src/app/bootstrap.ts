import { createFrontendRuntime } from './runtime.ts';
import type { RuntimeOptions } from './runtime.ts';

export interface FrontendBootstrapOptions
  extends Omit<RuntimeOptions, 'panelTarget' | 'componentTarget' | 'moduleTarget' | 'themeTarget'> {
  readonly target: HTMLElement;
  readonly panelTarget?: RuntimeOptions['panelTarget'];
  readonly componentTarget?: RuntimeOptions['componentTarget'];
  readonly moduleTarget?: RuntimeOptions['moduleTarget'];
  readonly themeTarget?: HTMLElement;
}

export type FrontendBootstrap = ReturnType<typeof createFrontendBootstrap>;

export function createFrontendBootstrap(options: FrontendBootstrapOptions) {
  const runtime = createFrontendRuntime({
    ...options,
    panelTarget: options.panelTarget ?? (() => options.target),
    componentTarget: options.componentTarget ?? (() => options.target),
    moduleTarget: options.moduleTarget ?? (() => options.target),
    themeTarget: options.themeTarget ?? options.target,
  });
  let disposal: Promise<void> | null = null;
  return {
    runtime,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposal = runtime.dispose();
      return disposal;
    },
  };
}
