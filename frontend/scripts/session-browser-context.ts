import type { ComponentType } from 'react';
import type { ProductServices } from '../src/app/product/services.ts';
import type { createSessionFixture } from './session-test-fixtures.ts';

export interface SessionBrowserContext {
  readonly target: HTMLElement;
  readonly services: ProductServices;
  readonly fixture: Awaited<ReturnType<typeof createSessionFixture>>;
  readonly mount: (page: ComponentType<{ services: ProductServices }>) => Promise<void>;
  readonly passed: (name: string) => void;
}
