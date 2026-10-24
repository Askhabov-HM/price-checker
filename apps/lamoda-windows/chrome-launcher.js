import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,realpathSync,statSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,sep} from 'node:path';

const filesystem = {existsSync,mkdirSync,realpathSync,statSync};
const lamodaUrl = 'https://www.lamoda.ru/wishlist/';

export function chromePath(environment,fs = filesystem) {
  const override = environment.LAMODA_CHROME_PATH;
  if (override !== undefined && (typeof override !== 'string' || !isAbsolute(override)
    || basename(override).toLowerCase() !== 'chrome.exe')) {
    throw new Error('LAMODA_CHROME_PATH must be an absolute path to chrome.exe');
  }
  const roots = [environment.ProgramFiles,environment['ProgramFiles(x86)'],environment.LOCALAPPDATA];
  const candidates = override ? [override] : roots.filter(Boolean).map(root => join(root,'Google','Chrome','Application','chrome.exe'));
  const found = candidates.find(path => fs.existsSync(path) && fs.statSync(path).isFile());
  if (!found) throw new Error('Google Chrome was not found');
  return found;
}

export function profilePath(environment,fs = filesystem) {
  const local = environment.LOCALAPPDATA;
  if (typeof local !== 'string' || !isAbsolute(local)) throw new Error('LOCALAPPDATA is unavailable');
  const profile = join(local,'PriceChecker','LamodaCollector','Chrome');
  fs.mkdirSync(profile,{recursive:true,mode:0o700});
  const actual = fs.realpathSync(profile);
  if (!fs.statSync(actual).isDirectory()) throw new Error('Chrome profile path is not a directory');
  const ordinary = join(local,'Google','Chrome','User Data');
  const ordinaryActual = fs.existsSync(ordinary) ? fs.realpathSync(ordinary) : ordinary;
  const own = actual.toLowerCase(),shared = ordinaryActual.toLowerCase();
  if (own === shared || own.startsWith(shared+sep)) throw new Error('Chrome profile must be separate from the regular browser');
  return actual;
}

export async function launchLamodaChrome({environment = process.env,platform = process.platform,fs = filesystem,spawnProcess = spawn} = {}) {
  if (platform !== 'win32') throw new Error('Lamoda Chrome launcher requires Windows');
  const chrome = chromePath(environment,fs);
  const profile = profilePath(environment,fs);
  const args = ['--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--new-window',lamodaUrl];
  const child = spawnProcess(chrome,args,{cwd:dirname(chrome),detached:true,stdio:'ignore',windowsHide:false});
  await new Promise((resolve,reject) => {
    child.once('spawn',resolve);
    child.once('error',reject);
  });
  child.unref();
  return {pid:child.pid,profile};
}
