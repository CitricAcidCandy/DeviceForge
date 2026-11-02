import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { publicWorkspaceTheme } from '../scripts/workspace-ui-theme.ts';

test('独立插件主题只包含公开令牌和显式暗色变体，不复制宿主业务规则', async () => {
  const source = await readFile(new URL('../src/app/styles.css', import.meta.url), 'utf8');
  const theme = publicWorkspaceTheme(source);
  assert.equal(theme.formatVersion, 1);
  assert.match(theme.theme, /--color-ink: var\(--text-strong\)/);
  assert.match(theme.theme, /--shadow-pop:/);
  assert.match(theme.theme, /--text-sm: 0\.9375rem/);
  assert.match(theme.theme, /@custom-variant dark/);
  assert.doesNotMatch(theme.theme, /:root|product-page|@import|prefers-color-scheme/);
});
test('主题派生拒绝选择器和非令牌声明，不静默发布一份不完整默认主题', () => {
  assert.throws(() => publicWorkspaceTheme('@theme inline { .private { color: red; } }'), /主题令牌/);
  assert.throws(() => publicWorkspaceTheme('@theme inline { color: red; }'), /只能包含命名令牌/);
});
