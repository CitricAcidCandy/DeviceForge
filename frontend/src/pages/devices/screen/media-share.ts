export interface MediaShareInfo {
  readonly deviceId: string;
  readonly control: boolean;
}

export function resolveMediaShareControl(requested: boolean, inherited: boolean | null): boolean {
  return requested && inherited !== false;
}

const deviceIdPattern = /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/;

export function parseMediaShare(hash: string): MediaShareInfo | null {
  const value = hash.replace(/^#\/?/, '');
  const separator = value.indexOf('?');
  if (separator < 0 || value.slice(0, separator) !== 'devices') return null;
  const query = new URLSearchParams(value.slice(separator + 1));
  const deviceId = query.get('share_device');
  const control = query.get('share_control');
  if (!deviceId || !deviceIdPattern.test(deviceId) || (control !== '0' && control !== '1')) return null;
  return Object.freeze({ deviceId, control: control === '1' });
}

export function createMediaShareUrl(info: MediaShareInfo): string {
  if (!deviceIdPattern.test(info.deviceId)) throw new Error('分享设备标识无效');
  const query = new URLSearchParams({
    share_device: info.deviceId,
    share_control: info.control ? '1' : '0',
  });
  return `${window.location.origin}${window.location.pathname}#devices?${query.toString()}`;
}
