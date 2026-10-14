import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {startLab,setScenario,SCENARIOS} from '../scripts/test-lab/fixture.js';
import {temporary,cleanup} from './helpers.js';

test('source database changes pass through HTTP, parsing, refresh, SQLite and chart API', async t => {
  const root = temporary(t), lab = await startLab({root,port:0}); cleanup(t,() => lab.close());
  assert.match(await (await fetch(lab.url)).text(), /id="test-mode-banner"/);
  const publicPrices = [], cartPrices = [];
  for (const [name,scenario] of Object.entries(SCENARIOS)) {
    setScenario(lab.source,name);
    const status = await (await fetch(lab.url+'/api/status')).json();
    const response = await fetch(lab.url+'/api/refresh',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':status.csrf_token},body:'{}'});
    assert.equal(response.status,202); await lab.tracker.refreshPromise;
    const data = await (await fetch(lab.url+'/api/dashboard?list=cart')).json();
    assert.equal(data.items.length,2); assert.ok(!data.items.some(row=>row.sku==='TEST-50'));
    const primary = data.items.find(row=>row.sku==='TEST-EDP-15');
    assert.equal(primary.price,scenario.public); assert.equal(primary.status,scenario.error?'error':'ok');
    publicPrices.push(scenario.error?null:scenario.public);
    const detail = await (await fetch(lab.url+`/api/product/${primary.id}?days=0`)).json();
    assert.deepEqual(detail.points.map(row=>row.price),publicPrices);
    assert.equal(data.history.at(-1).known_total,scenario.error?0:scenario.unavailable?60000:scenario.public+60000);
    const account = await (await fetch(lab.url+'/api/dashboard?list=cart&context=cart')).json();
    const accountPrimary = account.items.find(row=>row.sku===primary.sku);
    assert.equal(accountPrimary.price,scenario.cart); cartPrices.push(scenario.cart);
    assert.deepEqual(lab.tracker.db.detail(primary.id,'cart',0).points.map(row=>row.price),cartPrices);
    const check = lab.tracker.db.checks()[0]; assert.equal(check.status,scenario.error?'partial':'success');
  }
  assert.equal(lab.source.prepare("SELECT COUNT(*) AS n FROM requests WHERE path='/product/test-lab-graph-eau'").get().n,8);
  const saved = new DatabaseSync(join(root,'history.sqlite3'),{readOnly:true});
  try {
    assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM observations').get().n,32);
    assert.equal(saved.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  } finally {saved.close();}
});
