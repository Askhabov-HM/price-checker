import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {Randewoo} from '../src/client.js';
import {now} from '../src/time.js';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const output = outputIndex < 0 ? null : args[outputIndex + 1];
const url = args.find((value, index) => !value.startsWith('--') && (outputIndex < 0 || index !== outputIndex + 1)) || 'https://randewoo.ru/product/alfred-dunhill-icon';
const client = new Randewoo(resolve('.secrets/randewoo-session.json'));
try {
  if (outputIndex >= 0 && !output) throw new Error('Укажите файл после --output');
  const result = {checked_at_utc: now(), price_context: 'public_without_login', items: await client.products(url)};
  const text = JSON.stringify(result, null, 2) + '\n';
  if (output) {mkdirSync(dirname(output), {recursive: true}); writeFileSync(output, text, 'utf8'); console.log(`Сохранено вариантов: ${result.items.length}`);}
  else console.log(text);
} catch (error) {console.error(error.message); process.exitCode = 1;}
finally {client.close();}
