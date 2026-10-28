// 这里只判定地址形式；宿主仍独立核对真实连接，不能相信前端判断或转发头。
export function isLoopbackDebuggerAddress(address: string): boolean {
  try {
    const url = new URL(address);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      !url.search && !url.hash && (url.hostname === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname) ||
      url.hostname === '[::1]' || url.hostname === '[::ffff:7f00:1]');
  } catch { return false; }
}
