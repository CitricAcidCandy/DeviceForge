// 配置只由结构化业务输入序列化，不执行字符串表达式。
'use strict';
const configuration = __DEVICEFORGE_CONFIGURATION__;
function diagnosis(value) {
  console.log('__DEVICEFORGE_HOOK__' + JSON.stringify(value));
}
function safeText(value) {
  try { return String(value).slice(0, 4096); } catch (_) { return '[不可转换]'; }
}
function notice(spec, args, result) {
  if (!configuration.show_log) return;
  try {
    const strings = args.map(safeText);
    if (spec.args && !spec.args.every(value => strings.indexOf(value) >= 0)) return;
    if (spec.content_only && !/(contacts|calendar|browser|media)/i.test(strings[0] || '')) return;
    if (spec.module === 'packages' &&
        ['getApplicationInfo','getPackageInfoAsUser','getInstallerPackageName'].indexOf(spec.method) >= 0 &&
        strings[0] === configuration.package) return;
    const exception = Java.use('java.lang.Exception').$new();
    let stacks = '';
    try { stacks = Array.prototype.map.call(exception.getStackTrace(), safeText).join('\n'); }
    finally { exception.$dispose(); }
    console.log('__DEVICEFORGE_NOTICE__' + JSON.stringify({
      type: 'notice', time: new Date().toISOString(), module: spec.module || '',
      class: spec.class, method: spec.method,
      action: spec.action, messages: spec.messages, arg: strings.join('\n'),
      stacks: stacks.slice(0, 65536), result: safeText(result)
    }));
  } catch (error) { diagnosis({type:'notice_error',class:spec.class,method:spec.method,error:safeText(error)}); }
}
Java.perform(function () {
  let installed = 0;
  let missing = 0;
  const groups = Object.create(null);
  configuration.hooks.forEach(function (spec) {
    const identity = spec.class + '#' + spec.method;
    if (!groups[identity]) groups[identity] = [];
    groups[identity].push(spec);
  });
  Object.keys(groups).forEach(function (identity) {
    const specs = groups[identity];
    const spec = specs[0];
    try {
      const klass = Java.use(spec.class);
      const method = klass[spec.method];
      if (!method || !method.overloads) throw new Error('方法不存在');
      method.overloads.forEach(function (overload) {
        overload.implementation = function () {
          const args = Array.prototype.slice.call(arguments);
          // 调用原重载，参数过滤仅限制报告，不改变原返回值和异常。
          const result = overload.apply(this, args);
          specs.forEach(function (configured) { notice(configured, args, result); });
          return result;
        };
        installed++;
      });
      diagnosis({type:'installed',class:spec.class,method:spec.method,overloads:method.overloads.length});
    } catch (error) {
      missing++;
      diagnosis({type:'missing',class:spec.class,method:spec.method,error:safeText(error)});
    }
  });
  diagnosis({type:'summary',installed_overloads:installed,missing_methods:missing});
});
