import assert from 'node:assert/strict';
import test from 'node:test';
import { activationGeneration } from '../browser/domain/generation.ts';

test('局域网 HTTP 没有随机 UUID 时仍生成独立激活标记，不用作鉴权', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    const first = activationGeneration(), second = activationGeneration();
    assert.match(first, /^activation-/);
    assert.notEqual(first, second);
    assert.equal(activationGeneration(() => 'actual-random-id'), 'actual-random-id');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});
