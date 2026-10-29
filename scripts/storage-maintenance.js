#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import {acquireInstance,AlreadyRunning} from '../src/instance.js';
import {checkStores,existingStores} from '../src/storage-maintenance.js';

const [command,location] = process.argv.slice(2),root = resolve(location || '.');
const output = value => process.stdout.write(JSON.stringify(value)+'\n');
if (command === 'check') {
  const result = checkStores(root);output(result);process.exitCode = result.ok ? 0 : 1;
} else if (command === 'hold') {
  const releases = [];
  try {
    const deadline = Date.now()+90000;
    for (const path of ['app.lock','ozon/collector.lock','lamoda/collector.lock','collection.lock']) {
      while (true) {
        try {releases.push(await acquireInstance(join(root,'.data',path)));break;}
        catch (error) {if (!(error instanceof AlreadyRunning) || Date.now()>=deadline) throw error;await delay(250);}
      }
    }
    output({ok:true,locked:true,stores:existingStores(root)});
    for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
      if (line === 'prepare') {
        try {
          const result = await new Promise((resolve,reject) => {
            const worker = new Worker(new URL('../src/storage-worker.js',import.meta.url),{workerData:{root}});
            worker.once('message',resolve);worker.once('error',reject);
            worker.once('exit',code => {if (code) reject(new Error('Storage worker failed'));});
          });
          output(result);
        }
        catch {output({ok:false,reason:'storage_preparation_failed'});}
      } else if (line === 'release') break;
      else output({ok:false,reason:'invalid_command'});
    }
  } catch {output({ok:false,reason:'storage_lock_failed'});process.exitCode = 1;}
  finally {for (const release of releases.reverse()) await release();}
} else {output({ok:false,reason:'usage: check|hold ROOT'});process.exitCode = 1;}
