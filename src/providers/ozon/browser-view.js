import {createServer, connect} from 'node:net';
import {mkdirSync, chmodSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function ready(port, child) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Browser view stopped');
    const opened = await new Promise(resolve => {
      const socket = connect({host:'127.0.0.1',port});
      socket.setTimeout(200);
      socket.once('connect',() => {socket.destroy();resolve(true);});
      socket.once('error',() => resolve(false));
      socket.once('timeout',() => {socket.destroy();resolve(false);});
    });
    if (opened) return;
    await pause(100);
  }
  throw Error('Browser view unavailable');
}

// The VNC endpoints stay on loopback. The authenticated application proxies them.
export async function createBrowserView(display, launch) {
  const directory = join('/var/lib/price-checker-ozon-browser','login-'+randomBytes(12).toString('hex'));
  mkdirSync(directory,{mode:0o700});
  const password = randomBytes(6).toString('base64url'), auth = join(directory,'vnc-auth');
  try {
    await new Promise((resolve,reject) => {
      const child = launch('/usr/bin/x11vnc',['-storepasswd',password,auth]);
      child.once('error',reject);child.once('exit',code => code === 0 ? resolve() : reject(Error('Browser view unavailable')));
    });
    chmodSync(auth,0o600);
    const vncPort = await unusedPort();
    const vnc = launch('/usr/bin/x11vnc',['-display',':'+display,'-localhost','-rfbport',String(vncPort),'-rfbauth',auth,'-forever','-shared','-noxdamage','-quiet']);
    await ready(vncPort,vnc);
    const port = await unusedPort();
    const web = launch('/usr/bin/python3',['-m','websockify','127.0.0.1:'+port,'127.0.0.1:'+vncPort],
      {env:{...process.env,PYTHONPATH:'/opt/price-checker-ozon-remote/extracted/usr/lib/python3/dist-packages'}});
    await ready(port,web);
    return {port,password,remove:() => rmSync(directory,{recursive:true,force:true})};
  } catch (error) {rmSync(directory,{recursive:true,force:true});throw error;}
}
