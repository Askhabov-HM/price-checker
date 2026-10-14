import {test, expect} from '@playwright/test';
import {mkdtempSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {startLab, setScenario, PRODUCT_URL} from '../scripts/test-lab/fixture.js';
import {ensureFrontend} from '../scripts/build-frontend.js';

let lab, root;
test.beforeAll(async () => {await ensureFrontend();});
test.beforeEach(async ({page}) => {
  root = mkdtempSync(join(tmpdir(), 'price-checker-react-'));
  lab = await startLab({root, port: 0});
  page.on('request', request => {expect(new URL(request.url()).hostname).toBe('127.0.0.1');});
  await page.goto(lab.url);
  await expect(page.locator('#metric-count')).toHaveText('0');
});
test.afterEach(async () => {
  await lab?.close();
  if (root && dirname(root) === resolve(tmpdir()) && basename(root).startsWith('price-checker-react-')) rmSync(root, {recursive: true, force: true});
});
async function refresh(page, scenario) {
  setScenario(lab.source, scenario);
  const previous = lab.tracker.db.checks()[0]?.id || 0;
  await page.getByRole('button', {name: 'Проверить цены'}).click();
  await expect(page.locator('[data-dashboard]')).toHaveAttribute('data-check-id', String(previous + 1));
  await expect(page.locator('[data-dashboard]')).toHaveAttribute('data-running', 'false');
  await expect(page.locator('#product-rows tr[data-id]')).toHaveCount(2);
}

test('refresh updates prices and SVG charts; list URLs, filters, and scale survive reload', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await refresh(page, 'initial'); await refresh(page, 'drop');
  await expect(page.locator('#metric-total')).toContainText('1 400');
  await expect(page.locator('#metric-drops')).toHaveText('1');
  await expect(page.locator('#overview-chart .recharts-line-dot')).toHaveCount(2);
  await page.locator('.overview-card [data-chart-scale="checks"]').click();
  await page.getByLabel('Фильтр товаров').selectOption('drops');
  await expect(page.locator('#product-rows tr[data-id]')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#filter')).toHaveValue('drops');
  await expect(page.locator('.overview-card [data-chart-scale="checks"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#overview-chart')).toHaveAttribute('data-scale', 'checks');
  await page.locator('#navigation [data-list="favorites"]').click();
  await expect(page).toHaveURL(/\/favorites\?/);
  await page.reload(); await expect(page.locator('#page-title')).toContainText('Избранное');
  expect(errors).toEqual([]);
});

test('product details support keyboard selection, periods, context, and closing', async ({page}) => {
  await refresh(page, 'initial'); await refresh(page, 'drop');
  const row = page.locator('tr[data-id]').first();
  await row.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#detail-history tr')).toHaveCount(2);
  await expect(page.locator('#detail-chart .recharts-line-dot')).toHaveCount(2);
  await page.getByRole('button', {name: 'Всё время'}).click();
  await expect(page).toHaveURL(/days=0/);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Тип цены').selectOption('cart');
  await expect(page.locator('#metric-total')).toContainText('1 250');
  await row.click(); await expect(page.locator('#detail-label')).toContainText('цена варианта в корзине');
});

test('watch buttons and adding a URL update the lists without opening history', async ({page}) => {
  await refresh(page, 'initial');
  await page.getByRole('button', {name: 'Добавить в наблюдение', exact: true}).first().click();
  await expect(page.locator('#count-watching')).toHaveText('1');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('#navigation [data-list="watching"]').click();
  await expect(page.locator('#product-rows tr[data-id]')).toHaveCount(1);
  await page.getByRole('button', {name: 'Убрать из наблюдения'}).click();
  await expect(page.locator('#count-watching')).toHaveText('0');
  await page.locator('#add-side').click();
  await page.getByLabel('Ссылка на товар Randewoo').fill(PRODUCT_URL);
  await page.getByRole('button', {name: 'Добавить товар', exact: true}).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#product-rows tr[data-id]')).not.toHaveCount(0);
});

test('settings validate schedules and never persist session fields in browser storage', async ({page}) => {
  await page.locator('#settings-button').click();
  await page.getByLabel('Время проверок по Москве').fill('25:00');
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.getByLabel('Время проверок по Москве').fill('09:00, 20:00');
  await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(lab.tracker.status().schedule).toEqual(['09:00', '20:00']);
  await page.locator('#settings-button').click();
  await page.getByText('Обновить данные авторизации', {exact: true}).click();
  await page.getByLabel('Cookie', {exact: true}).fill('synthetic-transient-fixture');
  await page.keyboard.press('Escape');
  await page.locator('#settings-button').click();
  await page.getByText('Обновить данные авторизации', {exact: true}).click();
  await expect(page.getByLabel('Cookie', {exact: true})).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify({...localStorage}))).not.toContain('synthetic-transient-fixture');
});

test('mobile layout keeps navigation and settings accessible without page overflow', async ({page}) => {
  await refresh(page, 'initial');
  await page.setViewportSize({width: 390, height: 844});
  await expect(page.locator('#settings-button')).toBeVisible();
  await expect(page.locator('#add-side')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Настройки', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Добавить товар', exact: true})).toBeVisible();
  await expect(page.locator('.sidebar-action-label').first()).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#settings-button').click(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  mkdirSync('.data/react-preview', {recursive: true});
  await page.screenshot({path: '.data/react-preview/mobile.png', fullPage: true});
  await page.setViewportSize({width: 1440, height: 1100});
  await page.screenshot({path: '.data/react-preview/desktop.png', fullPage: true});
});
