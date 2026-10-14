import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export function authority(ip, port) {
  return `${ip.includes(':') ? `[${ip}]` : ip}:${port}`;
}
export function networkConfig(ip, webPort, mcpPort, interfaces = networkInterfaces()) {
  if (!isIP(ip)) throw new Error('--ip 必须为 IPv4 或 IPv6 地址');
  const wildcard = ['0.0.0.0', '::'].includes(ip);
  const addresses = wildcard
    ? [
        ...new Set([
          '127.0.0.1',
          ...(ip === '::' ? ['::1'] : []),
          ...Object.values(interfaces)
            .flat()
            .filter(Boolean)
            .filter(
              (entry) =>
                !entry.internal &&
                !entry.address.includes('%') &&
                (ip === '::' || entry.family === 'IPv4'),
            )
            .map((entry) => entry.address),
        ]),
      ]
    : [ip];
  const hosts = addresses.flatMap((address) => [
    authority(address, webPort),
    authority(address, mcpPort),
  ]);
  if (wildcard || ['127.0.0.1', '::1'].includes(ip))
    hosts.push(`localhost:${webPort}`, `localhost:${mcpPort}`);
  return {
    ip,
    hosts,
    origins: hosts.map((host) => `http://${host}`),
    urls: addresses.map((address) => ({
      web: `http://${authority(address, webPort)}`,
      mcp: `http://${authority(address, mcpPort)}/mcp`,
    })),
    external: !['127.0.0.1', '::1'].includes(ip),
  };
}
