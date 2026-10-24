import {createInterface} from 'node:readline/promises';
import {DesktopApi,DesktopCredentials,defaultServer,serverOrigin} from './desktop-api.js';

try {
  const origin = serverOrigin(process.argv[2] || defaultServer);
  const terminal = createInterface({input:process.stdin,output:process.stdout});
  let code;
  try {code = (await terminal.question('Код подключения ПК из Price Checker: ')).trim();}
  finally {terminal.close();}
  if (!/^[a-f0-9]{32}$/.test(code)) throw new Error('Неверный формат кода подключения');
  const {token} = await new DesktopApi(origin).pair(code);
  await new DesktopCredentials().save(origin,token);
  console.log('ПК подключён для пробных снимков Lamoda.');
} catch (error) {
  console.error('Подключение ПК не выполнено: '+error.message);
  process.exitCode = 1;
}
