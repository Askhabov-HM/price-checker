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

test('last changes survive unchanged checks and errors and filter by 7, 14, or 30 days', async ({page}) => {
  await refresh(page, 'initial'); await refresh(page, 'drop');
  const primary = lab.tracker.db.rows('cart').find(row => row.sku === 'TEST-EDP-15');
  const detected = primary.last_change.checked_at;
  await refresh(page, 'drop'); await refresh(page, 'error');
  const primaryRow = page.locator(`tr[data-id="${primary.id}"]`);
  await expect(primaryRow.locator('time')).toHaveAttribute('datetime', detected);
  await expect(primaryRow).toContainText('20,0%');
  await expect(primaryRow).toContainText('Нет свежих данных');

  const day = 86400000, now = Date.now(), stamp = age => new Date(now - age * day).toISOString();
  const secondary = lab.tracker.db.rows('cart').find(row => row.sku === 'TEST-EDT-15');
  lab.tracker.db.observation(secondary.id, {price_kopecks: 50000, in_stock: true}, 'public', null, stamp(11));
  lab.tracker.db.observation(secondary.id, {price_kopecks: 60000, in_stock: true}, 'public', null, stamp(10));
  const older = lab.tracker.db.variant({url: 'https://randewoo.ru/product/test-older-change', sku: 'OLD-20', brand: 'Test Lab', name: 'Older Change', variant: 'EDP 1,5мл'});
  lab.tracker.db.addMembers('cart', [older]);
  lab.tracker.db.observation(older, {price_kopecks: 90000, in_stock: true}, 'public', null, stamp(21));
  lab.tracker.db.observation(older, {price_kopecks: 70000, in_stock: true}, 'public', null, stamp(20));
  await page.reload();
  await page.getByLabel('Фильтр товаров').selectOption('changed');
  await expect(page.locator('#product-rows tr[data-id]')).toHaveCount(1);
  await expect(page.locator('#metric-drops')).toHaveText('1');
  await expect(page.locator('#metric-rises')).toHaveText('0');
  await page.getByLabel('Период изменений').selectOption('14');
  await expect(page.locator('#product-rows tr[data-id]')).toHaveCount(2);
  await expect(page.locator('#metric-rises')).toHaveText('1');
  await page.getByLabel('Период изменений').selectOption('30');
  await expect(page.locator('#product-rows tr[data-id]')).toHaveCount(3);
  await expect(page.locator('#metric-drops')).toHaveText('2');
  await page.getByRole('button', {name: 'Показать подорожавшие за 30 дней'}).click();
  await expect(page.locator('#product-rows tr[data-id]')).toHaveCount(1);
  await expect(page.locator('#product-rows tr[data-id]').first()).toHaveAttribute('data-id', String(secondary.id));
  await page.reload();
  await expect(page.getByLabel('Период изменений')).toHaveValue('30');
  await expect(page.getByLabel('Фильтр товаров')).toHaveValue('rises');
  await page.getByLabel('Период изменений').selectOption('7');
  await expect(page.locator('#product-rows tr[data-id]')).toHaveCount(0);
  await page.getByLabel('Период изменений').selectOption('14');
  await page.locator('#product-rows tr[data-id]').click();
  await page.getByRole('button', {name: 'Всё время'}).click();
  await expect(page).toHaveURL(/changeDays=14/);
  await expect(page).toHaveURL(/days=0/);
  await page.keyboard.press('Escape');
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

test('personal cart has its own route, discount, editable selection, and survives refresh and restart', async ({page}) => {
  await refresh(page, 'initial');
  const accountBefore = lab.tracker.db.rows('cart').map(({id, sku, quantity}) => ({id, sku, quantity}));
  await page.locator('#price-context').selectOption('cart');
  await page.locator('#navigation [data-list="favorites"]').click();
  const chosen = lab.tracker.db.rows('favorites').find(row => row.sku === 'TEST-EDP-15');
  await page.locator(`tr[data-id="${chosen.id}"]`).getByRole('button', {name: 'Добавить в мою корзину'}).click();
  await expect(page.locator('#count-my-cart')).toHaveText('1');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('#navigation [data-list="my-cart"]').click();
  await expect(page).toHaveURL(/\/my-cart\?/);
  await expect(page.locator('#page-title')).toContainText('Моя корзина');
  await expect(page.locator('#metric-total')).toContainText('1 000');
  await page.getByRole('checkbox', {name: 'Скидка 10%'}).check();
  await expect(page.locator('#metric-total')).toHaveText('900 ₽');
  await expect(page.locator('#my-cart-total')).toHaveText('900 ₽');
  await expect(page.locator('#price-context')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#product-rows tr[data-id]')).toHaveCount(1);
  const previousCheck = lab.tracker.db.checks()[0].id;
  await page.getByRole('button', {name: 'Проверить цены'}).click();
  await expect(page.locator('[data-dashboard]')).toHaveAttribute('data-check-id', String(previousCheck + 1));
  await expect(page.locator('[data-dashboard]')).toHaveAttribute('data-running', 'false');
  await expect(page.locator('#product-rows tr[data-id]')).toHaveCount(1);
  expect(lab.tracker.db.rows('cart').map(({id, sku, quantity}) => ({id, sku, quantity}))).toEqual(accountBefore);
  const port = Number(new URL(lab.url).port);
  await lab.close(); lab = await startLab({root, port});
  await page.goto(lab.url + '/my-cart?context=cart');
  await expect(page.locator('#metric-count')).toHaveText('1');
  await expect(page.locator('#my-cart-total')).toHaveText('900 ₽');
  await expect(page.locator('#export-button a, a#export-button')).toHaveAttribute('href', '/api/export?list=my-cart&context=public');
  await page.getByRole('button', {name: 'Убрать из моей корзины'}).click();
  await expect(page.locator('#metric-count')).toHaveText('0');
  expect(lab.tracker.db.rows('cart')).toHaveLength(2);
  await page.locator('#add-side').click();
  await expect(page.getByRole('dialog')).toContainText('Добавить в мою корзину');
  await page.getByLabel('Ссылка на товар Randewoo').fill(PRODUCT_URL);
  await page.locator('#add-submit').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#metric-count')).toHaveText('2');
  expect(lab.tracker.db.rows('watching')).toHaveLength(0);
  await page.setViewportSize({width: 390, height: 844});
  await expect(page.getByRole('link', {name: 'Моя корзина', exact: true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('10% discount toggles independently in both carts, persists, and leaves source prices intact', async ({page}) => {
  await refresh(page, 'initial');
  const chosen = lab.tracker.db.rows('cart').find(row => row.sku === 'TEST-EDP-15');
  lab.tracker.db.personalCart(chosen.id);
  const publicBefore = lab.tracker.db.rows('cart').map(({sku, price}) => ({sku, price}));
  const accountBefore = lab.tracker.db.rows('cart', 'cart').map(({sku, price}) => ({sku, price}));
  const historyBefore = lab.tracker.db.detail(chosen.id, 'public', 0).points;
  const mutations = [];
  page.on('request', request => {if (request.method() === 'POST') mutations.push(request.url());});
  const checkbox = page.getByRole('checkbox', {name: 'Скидка 10%'});
  await expect(checkbox).not.toBeChecked();
  await expect(page.locator('#metric-total')).toContainText('1 600');
  await checkbox.focus(); await page.keyboard.press('Space');
  await expect(page.locator('#metric-total')).toContainText('1 440');
  await expect(page.locator('#cart-total')).toContainText('1 440');
  await page.locator('#price-context').selectOption('cart');
  await expect(page.locator('#metric-total')).toContainText('1 305');
  await expect(page.locator('#cart-total')).toContainText('1 305');
  await page.reload();
  await expect(checkbox).toBeChecked();
  await expect(page.locator('#metric-total')).toContainText('1 305');
  await page.locator('#navigation [data-list="my-cart"]').click();
  await expect(checkbox).not.toBeChecked();
  await expect(page.locator('#my-cart-total')).toContainText('1 000');
  await checkbox.check();
  await expect(page.locator('#metric-total')).toHaveText('900 ₽');
  await page.locator('#navigation [data-list="cart"]').click();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(page.locator('#metric-total')).toContainText('1 600');
  await page.locator('#navigation [data-list="my-cart"]').click();
  await expect(checkbox).toBeChecked();
  await expect(page.locator('#my-cart-total')).toHaveText('900 ₽');
  await page.reload();
  await expect(checkbox).toBeChecked();
  await page.setViewportSize({width: 390, height: 844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#navigation [data-list="favorites"]').click();
  await expect(checkbox).toHaveCount(0);
  await expect(page.locator('#metric-total')).toContainText('1 600');
  expect(lab.tracker.db.rows('cart').map(({sku, price}) => ({sku, price}))).toEqual(publicBefore);
  expect(lab.tracker.db.rows('cart', 'cart').map(({sku, price}) => ({sku, price}))).toEqual(accountBefore);
  expect(lab.tracker.db.detail(chosen.id, 'public', 0).points).toEqual(historyBefore);
  expect(mutations).toEqual([]);
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

test('phone connection handles incorrect codes, succeeds on mobile and clears transient fields', async ({page}) => {
  const requests = []; let confirms = 0;
  await page.route('**/api/randewoo/*', async route => {
    const path = new URL(route.request().url()).pathname, data = route.request().postDataJSON();
    requests.push({path, data});
    const result = path.endsWith('/prepare') ? {challenge_id: 'test-challenge', captcha: null}
      : path.endsWith('/send-code') ? {sent: true, resend_after: 60}
      : path.endsWith('/confirm') ? ++confirms === 1 ? {error: 'Код не подошёл или истёк'} : {connected: true}
      : {ok: true};
    await route.fulfill({status: result.error ? 400 : 200, json: result});
  });
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#settings-button').click();
  await page.getByLabel('Телефон Randewoo', {exact: true}).fill('+7 (999) 123-45-67');
  await page.getByRole('button', {name: 'Получить код Randewoo'}).click();
  const code = page.getByLabel('Код Randewoo', {exact: true});
  await expect(code).toBeVisible();
  await expect(page.getByRole('button', {name: /Повторить через/})).toBeDisabled();
  await code.fill('1111'); await page.getByRole('button', {name: 'Подтвердить код'}).click();
  await expect(page.getByRole('alert')).toContainText('Код не подошёл');
  await code.fill('1234'); await page.getByRole('button', {name: 'Подтвердить код'}).click();
  await expect(page.getByRole('region', {name: 'Подключение Randewoo'})).toContainText('Randewoo подключён');
  await expect(code).toHaveCount(0);
  expect(requests.filter(request => request.path.endsWith('/send-code'))).toHaveLength(1);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toMatch(/999|1234|test-challenge/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape'); await page.locator('#settings-button').click();
  await expect(page.getByLabel('Телефон Randewoo', {exact: true})).toHaveValue('');
});

test('closing settings cancels only the pending phone login and clears its code', async ({page}) => {
  const cancelled = [];
  await page.route('**/api/randewoo/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/cancel')) cancelled.push(route.request().postDataJSON().challenge_id);
    await route.fulfill({json: path.endsWith('/prepare') ? {challenge_id: 'pending-id', captcha: null}
      : path.endsWith('/send-code') ? {sent: true, resend_after: 60} : {ok: true}});
  });
  await page.locator('#settings-button').click();
  await page.getByLabel('Телефон Randewoo', {exact: true}).fill('+79991234567');
  await page.getByRole('button', {name: 'Получить код Randewoo'}).click();
  await page.getByLabel('Код Randewoo', {exact: true}).fill('1234');
  await page.keyboard.press('Escape');
  await expect.poll(() => cancelled).toEqual(['pending-id']);
  await page.locator('#settings-button').click();
  await expect(page.getByLabel('Телефон Randewoo', {exact: true})).toHaveValue('');
  await expect(page.getByLabel('Код Randewoo', {exact: true})).toHaveCount(0);
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
