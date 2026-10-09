import {writeFileSync, readFileSync, unlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));

function argumentsFor(values) {
  const args = {port: 8000, once: false, noBrowser: false};
  for (let i = 0; i < values.length; i++) {
    if (values[i] === '--once') args.once = true;
    else if (values[i] === '--no-browser') args.noBrowser = true;
    else if (values[i] === '--port') {
      const value = values[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 1024 || Number(value) > 65535) throw new Error('Укажите порт от 1024 до 65535');
      args.port = Number(value);
    } else if (['--help', '-h'].includes(values[i])) args.help = true;
    else throw new Error('Неизвестный параметр: ' + values[i]);
  }
  return args;
}

function openBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command, args, {windowsHide: true, detached: true, stdio: 'ignore'});
  child.on('error', () => console.log('Откройте приложение в браузере: ' + url));
  child.unref();
}

async function main() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && (minor < 14 || (minor === 14 && patch < 1)))) {
    console.error('Требуется Node.js 24.14.1 или новее.'); return 1;
  }
  let args;
  try {args = argumentsFor(process.argv.slice(2));} catch (error) {console.error(error.message); return 1;}
  if (args.help) {console.log('node run.js [--no-browser] [--once] [--port 8000]'); return 0;}
  const {acquireInstance, AlreadyRunning} = await import('./src/instance.js');
  let release;
  try {release = await acquireInstance(join(root, '.data/app.lock'));}
  catch (error) {
    if (error instanceof AlreadyRunning) console.error('Приложение уже запущено. После аварийной остановки подождите 10 секунд и повторите запуск.');
    else console.error('Не удалось получить блокировку приложения.');
    return 1;
  }
  let tracker, server, shutdownPromise, resolveStopped;
  const pidFile = join(root, '.data/server.pid'), metaFile = join(root, '.data/server.json');
  const shutdown = () => {
    if (!shutdownPromise) shutdownPromise = (async () => {
      const closed = server?.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      await tracker?.close();
      server?.closeAllConnections();
      await closed;
      resolveStopped?.();
    })();
    return shutdownPromise;
  };
  const signal = () => {shutdown().catch(() => {process.exitCode = 1; resolveStopped?.();});};
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  try {
    const {Tracker} = await import('./src/service.js');
    const {makeServer, listen} = await import('./src/web.js');
    tracker = new Tracker(root);
    if (args.once) {
      const result = await tracker.refreshNow('cli');
      console.log(JSON.stringify(result));
      return result.errors ? 1 : 0;
    }
    server = makeServer(tracker, {onShutdown: signal});
    const port = await listen(server, args.port);
    writeFileSync(pidFile, String(process.pid), 'ascii');
    writeFileSync(metaFile, JSON.stringify({pid: process.pid, port, runtime: 'node.js'}), 'utf8');
    const url = 'http://127.0.0.1:' + port;
    console.log(`Price Checker (Node.js): ${url}\nРасписание: Москва. Для остановки нажмите Ctrl+C.`);
    tracker.startScheduler();
    if (!args.noBrowser) openBrowser(url);
    await new Promise(resolve => {resolveStopped = resolve;});
    return 0;
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? `Порт ${args.port} занят. Закройте предыдущий сервер или укажите другой порт.` : 'Не удалось запустить приложение. Проверьте npm ci и доступ к базе.');
    return 1;
  } finally {
    await shutdown();
    process.off('SIGINT', signal); process.off('SIGTERM', signal);
    try {if (readFileSync(pidFile, 'ascii').trim() === String(process.pid)) {unlinkSync(pidFile); unlinkSync(metaFile);}} catch {}
    await release();
  }
}

main().then(code => {process.exitCode = code;}).catch(() => {console.error('Не удалось завершить приложение.'); process.exitCode = 1;});
