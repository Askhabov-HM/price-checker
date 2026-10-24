import test from 'node:test';
import assert from 'node:assert/strict';
import {agentCycle,runAgent} from '../apps/lamoda-windows/agent.js';

const credentials = {directory:'unused',load:async () => ({origin:'https://prices.example',token:'synthetic-token'})};
const config = (time,overrides = {}) => ({mode:'staging',server_time:new Date(time).toISOString(),
  schedule:{enabled:true,next_check:new Date(time).toISOString(),interval_minutes:3},not_before:null,...overrides});

test('Desktop agent obeys server schedule and pause without opening a browser',async () => {
  const now = Date.now(),calls = [];
  const apiFactory = () => ({config:async token => {assert.equal(token,'synthetic-token');return config(now);}});
  const collect = async options => {calls.push(options);return {count:154,received_at:new Date(now).toISOString()};};
  assert.equal((await agentCycle({credentials,apiFactory,collect})).collected,true);
  assert.equal(calls.length,1);assert.equal(calls[0].scheduled,true);
  const paused = await agentCycle({credentials,apiFactory:() => ({config:async () => config(now,{not_before:new Date(now+60000).toISOString()})}),collect});
  assert.equal(paused.collected,false);assert.equal(calls.length,1);
  const disabled = await agentCycle({credentials,apiFactory:() => ({config:async () => config(now,{schedule:{enabled:false,next_check:null}})}),collect});
  assert.equal(disabled.collected,false);assert.equal(calls.length,1);
});

test('Desktop agent holds one instance and stops after cancellation',async () => {
  const controller = new AbortController(),events = [];
  let released = false;
  await runAgent({credentials,signal:controller.signal,acquire:async () => async () => {released=true;},
    cycle:async () => ({collected:true,result:{count:2,received_at:'2026-10-24T00:00:00.000Z'}}),
    wait:async () => {controller.abort();},log:event => events.push(event)});
  assert.equal(released,true);assert.equal(events.length,1);assert.equal(events[0].event,'snapshot_saved');
});
