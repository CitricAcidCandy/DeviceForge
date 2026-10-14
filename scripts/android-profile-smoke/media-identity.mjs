import assert from 'node:assert/strict';

// nonce、scid 与每个场景的原身份绑定；不宽匹配任意路径或脚本。
export function canonicalMediaArgv(args, fixture, mode) {
  const nonces = new Set(), scids = new Set();
  for (const arg of args) {
    for (const match of arg.matchAll(/df_profile_video_([a-f0-9]{64})/g)) nonces.add(match[1]);
    for (const match of arg.matchAll(/(?:scid=|localabstract:scrcpy_|--nice-name=)([a-f0-9]{8})/g)) scids.add(match[1]);
  }
  fixture.mediaNonces ??= new Map();
  let nonce = fixture.mediaNonces.get(mode);
  if (nonces.size) {
    assert.equal(nonces.size, 1, 'PROFILE-MEDIA-SAME-NONCE'); const candidate = [...nonces][0];
    if (nonce !== undefined) assert.equal(candidate, nonce, 'PROFILE-MEDIA-FIXED-NONCE'); else { nonce = candidate; fixture.mediaNonces.set(mode, nonce); }
  }
  if (!nonce) { assert.equal(scids.size, 0, 'PROFILE-MEDIA-SCID-BEFORE-NONCE'); return args; }
  const scid = Math.max(1, Number.parseInt(nonce.slice(0, 8), 16) & 0x7fffffff).toString(16).padStart(8, '0');
  for (const candidate of scids) assert.equal(candidate, scid, 'PROFILE-MEDIA-SCID-FROM-NONCE');
  return args.map(arg => arg.replaceAll(nonce, '@VIDEO_TOKEN@').replaceAll(scid, '@SCID@'));
}
