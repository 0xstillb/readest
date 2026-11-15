import { afterEach, describe, expect, it } from 'vitest';
import '@/styles/globals.css';

afterEach(() => {
  document.documentElement.removeAttribute('data-eink');
  document.documentElement.removeAttribute('data-theme');
  document.body.replaceChildren();
});

describe('Simple UI Continue Reading button contrast', () => {
  it.each(['default-light', 'default-dark'])('keeps text visible in e-ink %s', (theme) => {
    document.documentElement.setAttribute('data-eink', 'true');
    document.documentElement.setAttribute('data-theme', theme);
    const button = document.createElement('button');
    button.className = 'simpleui-continue-reading eink-contrast';
    button.style.backgroundColor = 'var(--color-base-content)';
    button.style.color = 'var(--color-base-100)';
    button.textContent = 'Continue Reading';
    document.body.append(button);
    const style = getComputedStyle(button);
    expect(style.color).not.toBe(style.backgroundColor);
  });
});
