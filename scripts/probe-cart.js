import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {Randewoo} from '../src/client.js';
import {now} from '../src/time.js';

const args = process.argv.slice(2), outputIndex = args.indexOf('--output');
const output = outputIndex < 0 ? null : args[outputIndex + 1];
const client = new Randewoo(resolve('.secrets/randewoo-session.json'));
try {
  if (outputIndex >= 0 && !output) throw new Error('Укажите файл после --output');
  await client.authorizedUser();
  const result = {list: 'cart', authorized: true, checked_at_utc: now(), price_context: 'account_cart', items: await client.cart()};
  const text = JSON.stringify(result, null, 2) + '\n';
  if (output) {mkdirSync(dirname(output), {recursive: true}); writeFileSync(output, text, 'utf8'); console.log(`Сохранено товаров: ${result.items.length}`);}
  else console.log(text);
} catch (error) {console.error(error.message); process.exitCode = 1;}
finally {client.close();}
