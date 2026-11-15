import { afterEach, expect, it } from 'vitest';
import '@/styles/globals.css';

const sources = import.meta.glob<string>('../../components/simpleui/SimpleUIBottomBar.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

afterEach(() => {
  document.documentElement.removeAttribute('data-eink');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('--color-base-content');
  document.querySelector('#shadow-test-style')?.remove();
  document.querySelector('#shadow-test-target')?.remove();
});

it.each([
  'default-light',
  'default-dark',
])('uses a sharp opaque e-ink cover shadow in %s', (theme) => {
  const source = Object.values(sources)[0];
  const css = source?.split('<style jsx global>{`')[1]?.split('`}</style>')[0];
  expect(css).toBeTruthy();
  expect(css).toContain("html:not([data-eink='true']) #simpleui-library .bookitem-main");
  const style = document.createElement('style');
  style.id = 'shadow-test-style';
  style.textContent = css!;
  document.head.append(style);
  document.documentElement.setAttribute('data-eink', 'true');
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.setProperty(
    '--color-base-content',
    theme.endsWith('-dark') ? '#fff' : '#000',
  );
  const target = document.createElement('div');
  target.id = 'shadow-test-target';
  target.innerHTML =
    '<div class="simpleui-cover-frame"></div><div id="simpleui-library"><div class="bookitem-main"></div></div>';
  document.body.append(target);
  for (const cover of target.querySelectorAll('.simpleui-cover-frame, .bookitem-main')) {
    expect(
      cover.matches(
        "html[data-eink='true'] .simpleui-cover-frame, html[data-eink='true'] #simpleui-library .bookitem-main",
      ),
      cover.className,
    ).toBe(true);
    expect(
      getComputedStyle(cover).getPropertyValue('--color-base-content').trim(),
      cover.className,
    ).toBe(theme.endsWith('-dark') ? '#fff' : '#000');
    expect(getComputedStyle(cover).boxShadow, cover.className).toContain('4px 4px 0px 0px');
    expect(getComputedStyle(cover).boxShadow).not.toContain('rgba(');
  }
});
