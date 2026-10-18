import {readFileSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireInstance} from '../src/instance.js';
import {importOzonConnection} from '../src/providers/ozon/connection.js';
import {OzonDatabase} from '../src/providers/ozon/database.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let release;
try {
  const [input, cookies] = process.argv.slice(2);
  if (!input || !cookies || process.argv.length !== 4) throw Error('arguments');
  const read = file => {if (statSync(resolve(file)).size > 1024*1024) throw Error('size'); return JSON.parse(readFileSync(resolve(file),'utf8').replace(/^\uFEFF/,''));};
  release = await acquireInstance(join(root,'.data/ozon/collector.lock'));
  const result = await importOzonConnection(root,read(input),read(cookies));
  const db = new OzonDatabase(root);
  try {db.updateState({action_required:0,message:''});} finally {db.close();}
  console.log(JSON.stringify(result));
} catch {console.error('Импорт Ozon не выполнен. Нужны два приватных JSON: запрос с эталоном контекста и экспорт cookies из серверного браузера.'); process.exitCode = 1;}
finally {await release?.();}
