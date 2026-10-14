import {existsSync} from 'node:fs';
import {defineConfig} from '@playwright/test';

const executablePath = [process.env.PRICE_CHECKER_TEST_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path => path && existsSync(path));
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 60000,
  use: {headless: true, viewport: {width: 1440, height: 1100}, locale: 'ru-RU', timezoneId: 'Europe/Moscow', trace: 'retain-on-failure', launchOptions: executablePath ? {executablePath} : {}},
  reporter: [['list'], ['html', {open: 'never'}]],
});
