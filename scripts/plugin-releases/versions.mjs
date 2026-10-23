// 源码可以声明兼容范围，成品保留已核验固定版本；兼容厂商四段版本等原有标识。
import semver from 'semver';

const bounded = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 100 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);

export function fixedVersion(value) {
  return (
    bounded(value) &&
    /^[A-Za-z0-9._+-]+$/.test(value) &&
    !['.', '..', 'unresolved'].includes(value) &&
    (semver.valid(value) !== null || semver.validRange(value) === null)
  );
}

export function sourceVersion(value) {
  return (
    bounded(value) &&
    (value === 'unresolved' || fixedVersion(value) || semver.validRange(value) !== null)
  );
}

export function versionSatisfied(declaration, actual) {
  if (!fixedVersion(actual)) return false;
  if (declaration === 'unresolved') return true;
  if (fixedVersion(declaration)) return declaration === actual;
  return (
    sourceVersion(declaration) &&
    semver.valid(actual) !== null &&
    semver.satisfies(actual, declaration)
  );
}
