import {createServer} from 'node:net';
import {RECOVERY_LIMIT} from './recovery.js';
import {validateCapturedRequest} from './network-capture.js';

async function* messages(socket) {
  let buffer = Buffer.alloc(0),first = true;
  for await (const chunk of socket) {
    buffer = Buffer.concat([buffer,chunk]);
    if (buffer.length > (first ? 262144 : 16384)) throw Error('Browser request too large');
    let newline;
    while ((newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0,newline);buffer = buffer.subarray(newline+1);first = false;
      yield JSON.parse(line.toString('utf8'));
    }
  }
  if (buffer.length) throw Error('Incomplete browser request');
}

export function createRecoveryServer(pool,{readLastError = () => null,monitorOnly = false,closePool = true} = {}) {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    const controller = new AbortController();
    socket.on('error',() => controller.abort());
    socket.on('close',() => {sockets.delete(socket);controller.abort();});
    socket.setTimeout(60000,() => socket.destroy());
    void (async () => {
      let lease,timer,sequence = 0,login = false;
      try {
        for await (const input of messages(socket)) {
          if (input.version !== 2 || input.id !== ++sequence) throw Error('Invalid browser sequence');
          const inspecting = input.inspect === true && input.id === 1 && Object.keys(input).every(key => ['version','id','inspect'].includes(key));
          if (!inspecting && (monitorOnly || input.inspect !== undefined)) throw Error('Observation only');
          if (inspecting) {
            const result={...await pool.inspect(),available:true,last_error:readLastError(),version:2,id:input.id};
            const output=JSON.stringify(result)+'\n';
            if (Buffer.byteLength(output)>RECOVERY_LIMIT) throw Error('Browser response too large');
            await new Promise((resolve,reject) => socket.write(output,error => error ? reject(error) : resolve()));
            break;
          }
          if (!lease) {
            if (input.close === true) {socket.end(JSON.stringify({version:2,id:input.id,released:true})+'\n');break;}
            if (input.resume === true && !pool.available) {
              await new Promise((resolve,reject) => socket.write(JSON.stringify({version:2,id:input.id,available:false})+'\n',error => error ? reject(error) : resolve()));
              break;
            }
            if (input.resume !== true) {
              const request = validateCapturedRequest(input.request);
              if (!['favorites','product','cart'].includes(request.operation)) throw Error('Invalid browser target');
              login = input.login === 'start';
              if (input.login && !login || login && (request.operation !== 'favorites' || !/^\+7\d{10}$/.test(input.phone || ''))) throw Error('Invalid browser login');
            }
            lease = await pool.acquire({login,signal:controller.signal});
            if (controller.signal.aborted) throw Error('Browser disconnected');
            timer = setTimeout(() => socket.destroy(),login ? 21*60000 : 590000);
            socket.setTimeout(login ? 21*60000 : 60000);
          }
          let result;
          if (input.close === true) {
            await lease.release();result = {version:2,browser_closed:login,released:!login};
          } else if (input.resume === true && input.id === 1) {
            result = {version:2,available:true};
          } else {
            // Release is reserved for the server; a caller cannot reset read limits.
            if (input.release !== undefined || input.resume !== undefined || input.warmup !== undefined || input.inspect !== undefined) throw Error('Invalid browser action');
            const {version,id,...message} = input;
            result = await lease.send(message);
          }
          const output = JSON.stringify({...result,version:2,id:input.id})+'\n';
          if (Buffer.byteLength(output) > RECOVERY_LIMIT) throw Error('Browser response too large');
          await new Promise((resolve,reject) => socket.write(output,error => error ? reject(error) : resolve()));
          if (input.close === true) break;
        }
      } catch { /* Raw requests, cookies and browser errors never enter logs. */ }
      finally {clearTimeout(timer);await lease?.release();socket.destroy();}
    })();
  });
  return {
    server,
    async close() {
      const stopped = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      if (closePool) await pool.close();await stopped;
    },
  };
}
