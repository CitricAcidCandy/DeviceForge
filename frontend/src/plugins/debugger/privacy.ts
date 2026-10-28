export const sensitiveKey = /password|passwd|secret|token|authorization|cookie|credential|api[-_]?key|^props$|^value$/i;
export function redactText(value: string): string {
  return value.replace(/\bBearer\s+[^\s]+/gi, 'Bearer [已脱敏]')
    .replace(/((?:password|passwd|secret|token|authorization|cookie|credential|api[-_]?key)\s*[=:]\s*)[^\s,;&]+/gi, '$1[已脱敏]');
}
export function sensitiveControl(element: Element): boolean {
  if (!['input', 'textarea', 'select'].includes(element.localName)) return false;
  return element.getAttribute('type')?.toLowerCase() === 'password' ||
    ['name', 'id', 'autocomplete', 'aria-label', 'placeholder'].some((attribute) =>
      sensitiveKey.test(element.getAttribute(attribute) ?? '') || /one-time-code|cc-number|cc-csc/.test(element.getAttribute(attribute) ?? ''));
}
