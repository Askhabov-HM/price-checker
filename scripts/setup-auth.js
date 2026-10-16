import {mkdirSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {createCredentials} from '../src/auth.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let login, password;
if (process.argv.includes('--stdin')) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 4096) throw new Error('Слишком большой запрос настройки входа.');
  }
  ({login, password} = JSON.parse(input));
} else {
  let muted = false;
  const output = new Writable({write(chunk, encoding, callback) {if (!muted) process.stdout.write(chunk, encoding); callback();}});
  const terminal = createInterface({input: process.stdin, output, terminal: Boolean(process.stdin.isTTY)});
  try {
    login = (await terminal.question('Логин: ')).trim();
    process.stdout.write('Пароль: ');
    muted = true;
    password = await terminal.question('');
    muted = false;
    process.stdout.write('\n');
  } finally {terminal.close();}
}
const credentials = await createCredentials(login, password);
const directory = join(root, '.secrets'), path = join(directory, 'price-checker-auth.json');
mkdirSync(directory, {recursive: true, mode: 0o700});
writeFileSync(path + '.tmp', JSON.stringify(credentials, null, 2) + '\n', {mode: 0o600});
renameSync(path + '.tmp', path);
console.log('Вход Price Checker настроен. Перезапустите приложение, чтобы применить изменения.');
