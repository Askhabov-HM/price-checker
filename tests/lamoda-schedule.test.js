import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LamodaService} from '../src/providers/lamoda/service.js';
import {temporary,cleanup} from './helpers.js';

const script = fileURLToPath(new URL('../scripts/lamoda-schedule.js',import.meta.url));
const command = (root,...args) => spawnSync(process.execPath,[script,'--root',root,...args],{encoding:'utf8',timeout:15000});
function setup(t) {
  const root = temporary(t),service = new LamodaService(root,{logger:() => {},pushSender:{configured:() => false}});
  cleanup(t,() => service.close());return {root,service};
}

test('Schedule command never creates a new database or enables an unconfirmed account',t => {
  const missing = temporary(t),absent = command(missing,'--apply');
  assert.equal(absent.status,1);assert.equal(existsSync(join(missing,'.data')),false);
  const {root,service} = setup(t),before = service.config();
  assert.equal(command(root,'--apply').status,1);assert.deepEqual(service.config(),before);
  service.db.bindAccount('42');service.settings({schedule_enabled:true});service.db.updateState({action_required:1});
  const blocked = service.config();assert.equal(command(root,'--apply').status,1);assert.deepEqual(service.config(),blocked);
});

test('Schedule command enables only Lamoda after explicit apply and preserves source delay and the next due check on repeats',t => {
  const {root,service} = setup(t);service.db.bindAccount('42');
  service.settings({schedule_enabled:false,schedule_mode:'hours',schedule:['08:00','20:00'],interval_minutes:120});
  const notBefore = new Date(Date.now()+80*60000).toISOString();service.db.updateState({not_before:notBefore});
  for (const store of ['ozon','randewoo']) {
    const directory = join(root,'.data',store);mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,'prices.sqlite3'),'synthetic unrelated database');
  }
  const before = service.config(),shown = command(root);assert.equal(shown.status,0,shown.stderr);
  assert.equal(JSON.parse(shown.stdout).applied,false);assert.deepEqual(service.config(),before);
  const applied = command(root,'--apply');assert.equal(applied.status,0,applied.stderr);
  const after = service.config();assert.equal(JSON.parse(applied.stdout).changed,true);
  assert.equal(after.schedule_enabled,true);assert.equal(after.schedule_mode,'interval');assert.equal(after.interval_minutes,30);
  assert.deepEqual(after.schedule,before.schedule);assert.equal(after.not_before,notBefore);
  assert.ok(Date.parse(after.next_check)>=Date.parse(notBefore));
  // Reapplying must not postpone a check that has already become due.
  const due = new Date(Date.now()-1000).toISOString();service.db.updateState({next_check:due});
  const repeated = command(root,'--apply');assert.equal(repeated.status,0,repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).changed,false);assert.equal(service.config().next_check,due);
  assert.equal(service.config().schedule_anchor,after.schedule_anchor);
  for (const store of ['ozon','randewoo']) assert.equal(readFileSync(join(root,'.data',store,'prices.sqlite3'),'utf8'),'synthetic unrelated database');
});

test('Schedule command leaves an active Android collection and its pending pages intact',async t => {
  const {root,service} = setup(t);service.db.bindAccount('42');
  service.mobile.pair(service.mobile.pairing().code,'Synthetic Android');await service.start({trigger:'android'});
  const job = service.mobile.next(),checks = service.db.checks();
  const applied = command(root,'--apply');assert.equal(applied.status,0,applied.stderr);
  assert.deepEqual(service.mobile.next(),job);assert.deepEqual(service.db.checks(),checks);
  assert.equal(service.controller.signal.aborted,false);assert.equal(service.config().schedule_enabled,true);
  await service.stopMobile(job.id);
});
