import { npmTgz } from '../../backend/scripts/online-plugins/fixtures.mjs';

export const observationKey = 'deviceforge.browser-theme-smoke.contexts';

function fixture(id, color, width, colorScheme, { dynamic = false, failing = false } = {}) {
  const descriptor = {
    name: 'deviceforge-' + id,
    version: '1.0.0',
    type: 'module',
    deviceforge: {
      kind: 'browser',
      manifest: 'plugin.json',
      entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } },
    },
  };
  const source = `
const run = crypto.randomUUID();
let releaseDynamic;
function observe(kind, context) {
  if (!context.themes) throw new Error('公开主题上下文缺失');
  const events = [];
  context.themes.subscribe(snapshot => events.push(snapshot.selected?.id ?? null));
  globalThis[Symbol.for('${observationKey}')]?.push({ id: '${id}', kind, run, themes: context.themes, events });
}
export default {
  id: '${id}', version: '1.0.0', apiVersion: 2,
  configuration: {
    version: 1, apply_policy: 'plugin_reload',
    schema: { type: 'object', additionalProperties: false, required: ['color', 'borderWidth', 'colorScheme'], properties: {
      color: { type: 'string', title: '强调色', minLength: 1 },
      borderWidth: { type: 'integer', title: '边框宽度', minimum: 0, maximum: 64 },
      colorScheme: { type: 'string', title: '浏览器配色', enum: ['dark', 'light', 'normal'] }
    } },
    defaults: { color: '${color}', borderWidth: ${width}, colorScheme: '${colorScheme}' }
  },
  panels: [{ id: '${id}.panel', title: '主题验收作用域', async mount(target, context) {
    observe('panel', context); target.textContent = '主题子作用域'; return () => { target.textContent = ''; };
  }}],
  contributions: {
    commands: [{ id: '${id}.release_dynamic', title: '释放动态主题', async execute(input, context, signal) {
      if (releaseDynamic) { await releaseDynamic(); releaseDynamic = undefined; }
      const reply = await context.listOperations(signal); return { data: { released: true }, logId: reply.logId };
    }}]
  },
  async activate(context) {
    const values = context.configuration?.get() ?? this.configuration.defaults;
    context.extensions.register({ themes: [{ id: '${id}.main', title: '在线主题', variables: {
      '--df-theme-smoke-color': values.color, '--df-theme-smoke-extra': '本代主题变量'
    }, css: '.theme-smoke-probe { border-top-width: ' + values.borderWidth + 'px !important; }', colorScheme: values.colorScheme }] });
    observe('plugin', context);
    ${
      dynamic
        ? `releaseDynamic = context.extensions.register({ themes: [{ id: '${id}.dynamic', title: '动态主题',
      variables: { '--df-theme-smoke-color': 'rgb(1, 2, 3)' }, colorScheme: 'normal' }] });`
        : ''
    }
    ${failing ? `context.themes.select('${id}.main'); throw new Error('主题激活失败夹具');` : ''}
  }
};
`;
  const archive = npmTgz([
    { path: 'package.json', bytes: JSON.stringify(descriptor) },
    { path: 'plugin.json', bytes: JSON.stringify({ id, version: '1.0.0', api_version: 2 }) },
    { path: 'dist/index.js', bytes: source },
  ]);
  return { id, archive };
}

export function themeFixtures() {
  return {
    first: fixture('theme_probe_a', 'rgb(71, 81, 91)', 7, 'dark', { dynamic: true }),
    second: fixture('theme_probe_b', 'rgb(121, 131, 141)', 9, 'light'),
    failing: fixture('theme_probe_fail', 'rgb(211, 221, 231)', 11, 'dark', { failing: true }),
  };
}
