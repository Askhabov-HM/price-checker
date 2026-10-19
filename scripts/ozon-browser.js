import {spawn} from 'node:child_process';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {createServer,request as httpRequest} from 'node:http';
import {randomBytes} from 'node:crypto';
import {acquireInstance} from '../src/instance.js';
import {importOzonConnection} from '../src/providers/ozon/connection.js';
import {accountMatches} from '../src/providers/ozon/account-context.js';
import {validateCapturedRequest} from '../src/providers/ozon/network-capture.js';

const directory = dirname(fileURLToPath(import.meta.url));
const root = '/opt/price-checker/current';
const assets = '/opt/price-checker-ozon-remote/extracted/usr/share/novnc';
const report = state => console.log(JSON.stringify({at:new Date().toISOString(),...state}));

// The store alone runs as pricechecker, preserving ownership of private files.
async function store() {
  let release,config,request;
  try {
    for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
      if (Buffer.byteLength(line) > 12*1024*1024) throw Error('Input too large');
      const input = JSON.parse(line);
      let result;
      try {
        if (input.action === 'open' && !release) {
          release = await acquireInstance(join(root,'.data/ozon/collector.lock'));
          config = JSON.parse(readFileSync(join(root,'.secrets/ozon/connection.json'),'utf8'));
          const phone = JSON.parse(readFileSync(join(root,'.secrets/ozon/login.json'),'utf8')).phone;
          request = validateCapturedRequest({method:'GET',url:'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url='+encodeURIComponent('/my/favorites?sorting=last_added'),headers:config.headers});
          if (!/^[1-9]\d{0,19}$/.test(config.reference?.account_id) || !/^\+7\d{10}$/.test(phone)) throw Error('Configuration unavailable');
          result = {request,phone};
        } else if (input.action === 'save' && release) {
          const value = input.result;
          if (value?.http_status !== 200 || value.outcome !== 'json_received' || value.request_url !== request.url
            || !accountMatches(value.data,config.reference,{requireLoginFlag:true}) || !value.exported?.cookies?.length
            || typeof value.user_agent !== 'string' || !value.user_agent) throw Error('Account not confirmed');
          const headers = {...request.headers,'user-agent':value.user_agent};
          const imported = await importOzonConnection(root,{request:{...request,headers},reference:config.reference},value.exported);
          result = {saved:true,cookies:imported.cookies};
        } else if (input.action === 'close') {
          await release?.();release=null;
          process.stdout.write(JSON.stringify({version:2,id:input.id,closed:true})+'\n');
          break;
        }
        else throw Error('Unsupported operation');
        process.stdout.write(JSON.stringify({version:2,id:input.id,...result})+'\n');
      } catch {process.stdout.write(JSON.stringify({version:2,id:input.id,error:'Authorization was not saved'})+'\n');}
    }
  } finally {await release?.();}
}

function channel(child) {
  let sequence=0,buffer='',pending;
  child.stdout.setEncoding('utf8');
  const fail = () => {if(pending){clearTimeout(pending.timer);pending.reject(Error('Channel closed'));pending=null;}};
  child.on('error',fail);child.once('exit',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);
  child.stdout.on('data',chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 12*1024*1024) {fail();child.kill();return;}
    let end;
    while ((end=buffer.indexOf('\n')) >= 0) {
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      try {
        const value=JSON.parse(line);
        if (!pending || value.id!==pending.id || value.version!==2) {fail();continue;}
        const item=pending;pending=null;clearTimeout(item.timer);
        value.error ? item.reject(Error('Authorization was not saved')) : item.resolve(value);
      } catch {fail();}
    }
  });
  return message => new Promise((resolve,reject) => {
    if (pending || child.exitCode!==null || child.signalCode!==null) return reject(Error('Channel unavailable'));
    const id=++sequence,timer=setTimeout(() => {fail();},60000);
    pending={id,timer,resolve,reject};child.stdin.write(JSON.stringify({version:2,id,...message})+'\n');
  });
}

async function browser() {
  if (process.platform!=='linux' || process.getuid()!==0) throw Error('Run the browser controller through its server service');
  const profile=process.env.OZON_BROWSER_PROFILE;
  if (!profile || realpathSync(profile)!==profile || !profile.startsWith('/var/lib/price-checker-ozon-browser/')) throw Error('Profile unavailable');
  const launch=(user,script,args=[]) => spawn('/usr/sbin/runuser',['-u',user,'--',process.execPath,script,...args],{env:process.env,stdio:['pipe','pipe','ignore']});
  const storage=launch('pricechecker',fileURLToPath(import.meta.url),['--store']),save=channel(storage);
  let worker,send,server,timer,signature,stopping=false,syncing;
  let syncStatus={saved:false,message:'Ожидаем авторизацию Ozon'};
  const sockets=new Set();
  const update=async (force=false) => {
    if (syncing) return syncing;
    syncing=(async () => {
      const state=await send({login:'state'});
      if (!state.has_auth) {syncStatus={saved:false,message:'Войдите в Ozon — вход сохранится автоматически'};return;}
      if (!force && state.signature===signature) return;
      signature=state.signature;
      syncStatus={saved:false,message:'Подтверждаем аккаунт и сохраняем вход…'};
      const result=await send({login:'finish'});
      const saved=await save({action:'save',result});
      signature=(await send({login:'state'})).signature;
      syncStatus={saved:true,saved_at:new Date().toISOString(),message:'Вход сохранён для HTTP'};
      report(saved);
    })().catch(() => {syncStatus={saved:false,message:'Не удалось подтвердить аккаунт или сохранить вход для HTTP'};report({saved:false,error:'Could not confirm the browser account or save HTTP authorization'});}).finally(() => {syncing=null;});
    return syncing;
  };
  const shutdown=async () => {
    if(stopping)return;stopping=true;clearInterval(timer);
    if(send && worker?.exitCode===null) {await syncing;await update(true);try{await send({close:true});}catch{}}
    for(const socket of sockets)socket.destroy();
    if(server)await new Promise(resolve => server.close(resolve));
    try{await save({action:'close'});}catch{}
    worker?.stdin.end();storage.stdin.end();
    for(const child of [worker,storage])if(child && child.exitCode===null){
      const force=setTimeout(() => child.kill('SIGKILL'),4000);force.unref();child.once('exit',() => clearTimeout(force));child.kill('SIGTERM');
    }
  };
  process.once('SIGTERM',() => {void shutdown();});process.once('SIGINT',() => {void shutdown();});
  try {
    const {request,phone}=await save({action:'open'});
    worker=launch('ozonbrowser',join(directory,'ozon-recovery-worker.js'));send=channel(worker);
    const {view}=await send({login:'start',request,phone});
    const nonce=randomBytes(18).toString('base64url');
    const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Серверный Chrome — Ozon</title><style>html,body{margin:0;width:100%;height:100%;background:#111;color:#ddd;font:14px sans-serif}body{display:flex;flex-direction:column}header{padding:8px 12px}#screen{flex:1;min-height:0}</style><header id="status">Серверный Chrome · подключение…</header><div id="screen"></div><script nonce="${nonce}" type="module">import RFB from '/core/rfb.js';const status=document.getElementById('status');const rfb=new RFB(document.getElementById('screen'),'ws://'+location.host+'/websockify',{credentials:{password:${JSON.stringify(view.password)}}});rfb.scaleViewport=true;rfb.resizeSession=false;let connected=false;rfb.addEventListener('connect',()=>{connected=true;});rfb.addEventListener('disconnect',()=>{connected=false;status.textContent='Серверный Chrome · соединение закрыто';});setInterval(async()=>{if(connected)try{const s=await(await fetch('/status')).json();status.textContent='Серверный Chrome · '+s.message;}catch{}},3000);</script></html>`;
    server=createServer((req,res) => {
      const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:16084; frame-ancestors 'none'`};
      try {
        if(req.method!=='GET' || req.headers.host!=='127.0.0.1:16084'){res.writeHead(403);res.end();return;}
        const path=new URL(req.url,'http://localhost').pathname;
        if(path==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8',...headers});res.end(html);return;}
        if(path==='/status'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(syncStatus));return;}
        if(!/^\/(core|vendor)\/[A-Za-z0-9_./-]+\.js$/.test(path))throw Error();
        const file=realpathSync(resolve(assets,'.'+path));
        if(!file.startsWith(realpathSync(assets)+sep) || !statSync(file).isFile())throw Error();
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8',...headers});res.end(readFileSync(file));
      }catch{res.writeHead(404,headers);res.end();}
    });
    server.on('connection',socket => {sockets.add(socket);socket.once('close',() => sockets.delete(socket));});
    server.on('upgrade',(req,socket,head) => {
      if(req.url!=='/websockify' || req.headers.host!=='127.0.0.1:16084' || req.headers.origin!=='http://127.0.0.1:16084'){socket.destroy();return;}
      const upstream=httpRequest({host:'127.0.0.1',port:view.port,path:'/',headers:{...req.headers,host:'127.0.0.1:'+view.port}});
      upstream.once('upgrade',(response,remote,remoteHead) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([key,value]) => key+': '+value).join('\r\n')+'\r\n\r\n');
        if(head.length)remote.write(head);if(remoteHead.length)socket.write(remoteHead);
        socket.pipe(remote);remote.pipe(socket);socket.on('close',() => remote.destroy());remote.on('close',() => socket.destroy());remote.on('error',() => socket.destroy());
      });
      upstream.once('response',response => {response.resume();socket.destroy();});upstream.on('error',() => socket.destroy());socket.on('error',() => upstream.destroy());upstream.end();
    });
    await new Promise((resolve,reject) => {server.once('error',reject);server.listen(6084,'127.0.0.1',resolve);});
    report({browser_open:true,viewer:'http://127.0.0.1:16084/',automatic_http_session:true});
    await update(true);
    timer=setInterval(() => {if(!stopping)void update();},5000);
    if(worker.exitCode===null && worker.signalCode===null)await new Promise(resolve => worker.once('exit',resolve));
  } finally {await shutdown();}
}

try {
  if(process.argv.includes('--store'))await store();else await browser();
}catch{report({error:'Server browser session stopped without exposing credentials'});process.exitCode=1;}
