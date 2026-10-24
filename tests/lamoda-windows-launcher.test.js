import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchLamodaChrome} from '../apps/lamoda-windows/chrome-launcher.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'lamoda-launcher-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const programFiles = join(root,'Program Files');
  const localAppData = join(root,'Local');
  const chrome = join(programFiles,'Google','Chrome','Application','chrome.exe');
  mkdirSync(join(programFiles,'Google','Chrome','Application'),{recursive:true});
  mkdirSync(localAppData,{recursive:true});
  writeFileSync(chrome,'synthetic executable');
  return {chrome,localAppData,environment:{ProgramFiles:programFiles,LOCALAPPDATA:localAppData}};
}

test('Windows launcher uses its own persistent profile and starts only the installed Chrome',async t => {
  const {chrome,localAppData,environment} = fixture(t);
  let invocation,unrefed = false;
  const spawnProcess = (...args) => {
    invocation = args;
    const child = new EventEmitter();child.pid = 1234;child.unref = () => {unrefed = true;};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const result = await launchLamodaChrome({environment,platform:'win32',spawnProcess});
  assert.equal(result.pid,1234);
  assert.equal(result.profile,join(localAppData,'PriceChecker','LamodaCollector','Chrome'));
  assert.equal(invocation[0],chrome);
  assert.deepEqual(invocation[1],['--user-data-dir='+result.profile,'--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0','--new-window','https://www.lamoda.ru/wishlist/']);
  assert.equal(invocation[2].windowsHide,false);
  assert.equal(invocation[2].detached,true);
  assert.equal(invocation[2].stdio,'ignore');
  assert.equal(unrefed,true);
});

test('Windows launcher rejects missing Chrome and reports process start errors',async t => {
  const {environment} = fixture(t);
  await assert.rejects(launchLamodaChrome({environment:{LOCALAPPDATA:environment.LOCALAPPDATA},platform:'win32'}),/not found/);
  let unrefed = false;
  const spawnProcess = () => {
    const child = new EventEmitter();child.unref = () => {unrefed = true;};
    queueMicrotask(() => child.emit('error',new Error('launch denied')));
    return child;
  };
  await assert.rejects(launchLamodaChrome({environment,platform:'win32',spawnProcess}),/launch denied/);
  assert.equal(unrefed,false);
});
