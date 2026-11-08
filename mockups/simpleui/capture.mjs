import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 1120 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: join(here, 'preview-home.png') });
  await page.locator('#library-tab').evaluate((button) => button.click());
  await page.locator('#library-title-toggle').evaluate((button) => button.click());
  await page.locator('.title-mode-option[data-mode="hidden"]').click();
  await page.screenshot({ path: join(here, 'preview-library-hidden.png') });
  await page.locator('#library-title-toggle').evaluate((button) => button.click());
  await page.locator('.title-mode-option[data-mode="cover"]').click();
  await page.screenshot({ path: join(here, 'preview-library-cover.png') });
  await page.locator('#library-title-toggle').evaluate((button) => button.click());
  await page.locator('.title-mode-option[data-mode="below"]').click();
  await page.screenshot({ path: join(here, 'preview-library-below.png') });
  await page.locator('#settings-toggle').click();
  await page.screenshot({ path: join(here, 'preview-settings.png') });
} finally {
  await browser.close();
}
