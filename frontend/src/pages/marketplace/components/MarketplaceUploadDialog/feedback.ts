export function publicationErrorMessage(reason: unknown, fallback: string): string {
  const message = reason instanceof Error ? reason.message : fallback;
  if (reason && typeof reason === 'object' && 'logId' in reason && typeof reason.logId === 'string')
    return `${message}（日志 ID：${reason.logId}）`;
  return message;
}
