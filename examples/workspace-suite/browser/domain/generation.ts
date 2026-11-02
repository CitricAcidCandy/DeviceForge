let sequence = 0;

/** 仅区分本次激活，不作为凭据；局域网 HTTP 不保证提供 randomUUID。 */
export function activationGeneration(randomId: (() => string) | undefined = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)): string {
  if (randomId) return randomId();
  return `activation-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
}
