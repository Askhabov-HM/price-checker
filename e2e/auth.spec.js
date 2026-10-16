import {test, expect} from '@playwright/test';
import {mkdtempSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {Authentication, createCredentials} from '../src/auth.js';
import {startLab} from '../scripts/test-lab/fixture.js';
import {ensureFrontend} from '../scripts/build-frontend.js';

let lab, root, credentials, serverAuth;
test.beforeAll(async () => {await ensureFrontend(); credentials = await createCredentials('test-admin', 'test-access-password');});
test.beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'price-checker-login-'));
  serverAuth = new Authentication(credentials);
  lab = await startLab({root, port: 0, auth: serverAuth});
});
test.afterEach(async () => {
  await lab?.close();
  if (root && dirname(root) === resolve(tmpdir()) && basename(root).startsWith('price-checker-login-')) rmSync(root, {recursive: true, force: true});
});

test('login handles wrong passwords, preserves the requested list, remembers reloads and logs out', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(lab.url + '/favorites?q=Test');
  await expect(page.getByRole('heading', {name: 'Вход в Price Checker'})).toBeVisible();
  await expect(page.locator('#navigation')).toHaveCount(0);
  expect((await page.request.get(lab.url + '/api/dashboard')).status()).toBe(401);
  await page.getByLabel('Логин', {exact: true}).fill('test-admin');
  await page.getByLabel('Пароль', {exact: true}).fill('incorrect');
  await page.getByRole('button', {name: 'Войти', exact: true}).click();
  await expect(page.getByRole('alert')).toHaveText('Неверный логин или пароль');
  await expect(page.getByLabel('Пароль', {exact: true})).toHaveValue('');
  await page.getByLabel('Пароль', {exact: true}).fill('test-access-password');
  await page.getByLabel('Пароль', {exact: true}).press('Enter');
  await expect(page.locator('#page-title')).toContainText('Избранное');
  await expect(page).toHaveURL(/\/favorites\?q=Test/);
  await expect(page.locator('#search')).toHaveValue('Test');
  const cookie = (await page.context().cookies()).find(value => value.name === 'pricechecker_session');
  expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe('Strict');
  expect(await page.evaluate(() => document.cookie)).not.toContain('pricechecker_session');
  await page.reload();
  await expect(page.locator('#page-title')).toContainText('Избранное');
  await page.getByRole('button', {name: 'Выйти из Price Checker'}).click();
  await expect(page.getByRole('heading', {name: 'Вход в Price Checker'})).toBeVisible();
  await expect(page.locator('#navigation')).toHaveCount(0);
  expect((await page.request.get(lab.url + '/api/export')).status()).toBe(401);
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Вход в Price Checker'})).toBeVisible();
  expect(errors).toEqual([]);
});

test('the login form fits a phone and returns when the server session expires', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto(lab.url);
  await expect(page.getByRole('button', {name: 'Войти', exact: true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await page.locator('.auth-card').boundingBox();
  expect(Math.abs(bounds.x - (390 - bounds.x - bounds.width))).toBeLessThan(2);
  mkdirSync('.data/auth-preview', {recursive: true});
  await page.screenshot({path: '.data/auth-preview/login-mobile.png', fullPage: true});
  await page.getByLabel('Логин', {exact: true}).fill('test-admin');
  await page.getByLabel('Пароль', {exact: true}).fill('test-access-password');
  await page.getByRole('button', {name: 'Войти', exact: true}).click();
  await expect(page.locator('#metric-count')).toHaveText('0');
  const cookie = (await page.context().cookies()).find(value => value.name === 'pricechecker_session');
  // Expire the server-side session while the browser still holds its cookie.
  const session = serverAuth.sessions.get(cookie.value);
  expect(session).toBeDefined();
  session.expires = 0;
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Вход в Price Checker'})).toBeVisible();
});
