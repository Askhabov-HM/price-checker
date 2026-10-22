import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {FirebaseSender,PushError} from '../src/providers/lamoda/push.js';
import {LamodaService} from '../src/providers/lamoda/service.js';
import {temporary,cleanup} from './helpers.js';

const {privateKey,publicKey} = generateKeyPairSync('rsa',{modulusLength:2048});
const credentials = {type:'service_account',project_id:'synthetic-project',client_email:'push@synthetic-project.iam.gserviceaccount.com',
  private_key:privateKey.export({type:'pkcs8',format:'pem'})};
const clock = 1792620000000;
const response = (value,status = 200,headers = {}) => new Response(JSON.stringify(value),{status,headers});

test('FCM uses a signed scoped OAuth assertion, caches access tokens and sends only a bounded reminder',async () => {
  const calls = [],sender = new FirebaseSender('',{credentials,current:() => clock,fetcher:async (url,options) => {
    calls.push({url,options});return url.includes('oauth2.') ? response({access_token:'synthetic-access',expires_in:3600}) : response({name:'synthetic-message'});
  }});
  assert.equal(sender.configured(),true);
  const job = {id:'0123456789abcdef0123456789abcdef',expires:clock+45*60000};
  await sender.send('synthetic-registration-token',job);await sender.send('synthetic-registration-token',job,{validateOnly:true});
  assert.equal(calls.length,3);
  const jwt = calls[0].options.body.get('assertion'),[header,payload,signature] = jwt.split('.');
  assert.equal(verify('RSA-SHA256',Buffer.from(header+'.'+payload),publicKey,Buffer.from(signature,'base64url')),true);
  assert.deepEqual(JSON.parse(Buffer.from(payload,'base64url')),{iss:credentials.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',
    aud:'https://oauth2.googleapis.com/token',iat:clock/1000,exp:clock/1000+3600});
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[1].url,'https://fcm.googleapis.com/v1/projects/synthetic-project/messages:send');
  const sent = JSON.parse(calls[1].options.body);
  assert.equal(sent.message.android.ttl,'2700s');assert.equal(sent.message.android.restricted_package_name,'ru.pricechecker.lamoda');
  assert.deepEqual(sent.message.data,{lamoda_job:job.id,lamoda_expires:String(job.expires)});
  // A system-rendered notification would bypass the app's background callback
  // and leave collection waiting for a tap instead of starting WorkManager.
  assert.equal(sent.message.notification,undefined);assert.equal(sent.message.android.notification,undefined);
  assert.equal(sent.message.android.priority,'HIGH');assert.equal(sent.message.android.collapse_key,'lamoda-reminder');
  assert.equal(JSON.parse(calls[2].options.body).validate_only,true);
  assert.doesNotMatch(JSON.stringify(sent),/customer|wishlist|Bearer|synthetic-access/);
});

test('FCM respects Retry-After, distinguishes expired tokens from payload errors, and hides provider details',async t => {
  let status = 429,details = [],headers = {'Retry-After':'180'};
  const sender = new FirebaseSender('',{credentials,current:() => clock,fetcher:async url => url.includes('oauth2.') ? response({access_token:'synthetic-access',expires_in:3600})
    : response({error:{message:'synthetic-private-do-not-return',details}},status,headers)});
  const send = () => sender.send('synthetic-registration-token',{id:'0123456789abcdef0123456789abcdef',expires:clock+600000});
  await assert.rejects(send(),error => error.code === 'rate_limited' && error.retry === 180000 && !error.message.includes('private'));
  status = 400;headers = {};details = [{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'INVALID_ARGUMENT'}];
  await assert.rejects(send(),error => !error.invalidToken);
  status = 404;details[0].errorCode = 'UNREGISTERED';await assert.rejects(send(),error => error.invalidToken);
  assert.equal(new FirebaseSender(temporary(t)).configured(),false);
});

function setup(t,{send = async () => {},current = () => clock} = {}) {
  const root = temporary(t),sender = {project:'synthetic-project',configured:() => true,send};
  const lamoda = new LamodaService(root,{current,pushSender:sender,logger:() => {}});
  cleanup(t,() => lamoda.close());
  lamoda.mobile.pair(lamoda.mobile.pairing().code,'Synthetic Android');
  const register = (token = 'synthetic-registration-token',enabled = true) => lamoda.push.register({token,enabled,project_id:sender.project});
  return {lamoda,register};
}

test('Push retry is independent of collection, durable, deduplicated and honors the source delay',async t => {
  let now = clock,attempts = 0;
  const {lamoda,register} = setup(t,{current:() => now,send:async () => {if (++attempts === 1) throw new PushError('rate_limited',{retry:180000});}});
  register();await lamoda.start({trigger:'schedule'});const job = lamoda.mobile.next();
  await lamoda.push.flush();assert.equal(lamoda.status().running,true);assert.equal(attempts,1);
  assert.equal(lamoda.push.status().error,'rate_limited');
  assert.equal(lamoda.db.db.prepare('SELECT attempts FROM mobile_push_outbox WHERE job_id=?').get(job.id).attempts,1);
  now+=179999;await lamoda.push.flush();assert.equal(attempts,1);
  now++;await Promise.all([lamoda.push.flush(),lamoda.push.flush()]);assert.equal(attempts,2);
  await lamoda.push.flush();assert.equal(attempts,2);assert.ok(lamoda.push.status().accepted_at);
  assert.doesNotMatch(JSON.stringify(lamoda.status()),/synthetic-registration-token/);
});

test('No push for collection started in the app, disabled permissions, completed, canceled or expired jobs',async t => {
  let calls = 0,now = clock;
  const {lamoda,register} = setup(t,{current:() => now,send:async () => {calls++;}});
  register();await lamoda.start({trigger:'android'});await lamoda.push.flush();assert.equal(calls,0);
  lamoda.mobile.fail(lamoda.mobile.next().id,'interrupted');await lamoda.running;
  await lamoda.start();register('synthetic-registration-token',false);await lamoda.push.flush();assert.equal(calls,0);
  register();lamoda.mobile.fail(lamoda.mobile.next().id,'interrupted');await lamoda.push.flush();assert.equal(calls,0);await lamoda.running;
  await lamoda.start();now+=46*60000;await lamoda.push.flush();assert.equal(calls,0);
  lamoda.mobile.revoke();assert.equal(lamoda.push.status().enabled,false);
});

test('Re-pairing clears push access; an expired old token cannot erase a refreshed registration',async t => {
  let finish;
  const {lamoda,register} = setup(t,{send:() => new Promise((resolve,reject) => {finish = reject;})});
  register();await lamoda.start();const flushing = lamoda.push.flush();
  register('synthetic-new-registration-token');finish(new PushError('token_expired',{invalidToken:true}));await flushing;
  assert.equal(lamoda.push.status().enabled,true);
  assert.equal(lamoda.db.db.prepare('SELECT token FROM mobile_push_device').get().token,'synthetic-new-registration-token');
  lamoda.mobile.pair(lamoda.mobile.pairing().code,'Replacement');
  assert.equal(lamoda.push.status().enabled,false);assert.equal(lamoda.db.db.prepare('SELECT count(*) AS n FROM mobile_push_outbox').get().n,0);
  assert.throws(() => register('invalid'));
  assert.throws(() => lamoda.push.register({enabled:true,token:'synthetic-registration-token',project_id:'other-project'}));
});
