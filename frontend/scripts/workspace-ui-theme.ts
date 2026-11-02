/** 只发布公开主题令牌，不把宿主业务选择器或基础样式带进独立插件。 */
export function publicWorkspaceTheme(css: string): { readonly formatVersion: 1; readonly theme: string } {
  const block = /@theme\s+inline\s*\{([^{}]*)\}/u.exec(css);
  if (!block?.[1]) throw new Error('宿主缺少可以公开派生的平面主题令牌');
  const tokens = block[1].replace(/\/\*[\s\S]*?\*\//gu, '').trim();
  if (!tokens || tokens.split(';').some((line) => line.trim() && !/^--[a-zA-Z0-9-]+\s*:[^{}]*$/u.test(line.trim())))
    throw new Error('公开主题只能包含命名令牌，不能包含业务选择器');
  return { formatVersion: 1,
    theme: `@custom-variant dark (&:where(.dark, .dark *));\n@theme inline {\n${tokens}\n}\n` };
}
