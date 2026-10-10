// 只校验本示例命令的业务参数；不声明或复制 HTTP DTO。
export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function object(value, required, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key))) {
    fail('example_input', label + '的字段不符合示例约定');
  }
  return value;
}

export function text(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('example_input', label + '必须是非空字符串');
  }
  return value;
}

export function reference(value) {
  object(value, ['providerId', 'generation', 'localId'], '设备引用');
  for (const key of ['providerId', 'generation', 'localId']) text(value[key], key);
  return value;
}

export function action(value) {
  object(value, ['providerId', 'generation', 'deviceId', 'capability', 'version', 'input'], '设备动作');
  for (const key of ['providerId', 'generation', 'capability']) text(value[key], key);
  if (value.deviceId !== null) text(value.deviceId, 'deviceId');
  if (!Number.isSafeInteger(value.version) || value.version < 1) fail('example_input', '能力版本必须是正安全整数');
  if (typeof value.input !== 'object' || value.input === null || Array.isArray(value.input)) {
    fail('example_input', '设备动作 input 必须是业务对象');
  }
  return value;
}
