import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {startLab,setScenario,SCENARIOS} from './test-lab/fixture.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const run = 'run-'+randomUUID().slice(0,8), directory = join(repository,'.data/test-lab'), root = join(directory,'runs',run);
const browserPath = [process.env.PRICE_CHECKER_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find(path=>path && existsSync(path));
if (!browserPath) throw new Error('Set PRICE_CHECKER_TEST_BROWSER to an installed Chrome/Edge/Chromium executable.');
mkdirSync(join(root,'screenshots'),{recursive:true});
const lab = await startLab({root,port:0});
let browser;
const results = [], errors = [];
try {
  browser = await chromium.launch({executablePath:browserPath,headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1100},locale:'ru-RU',timezoneId:'Europe/Moscow'});
  // Observe real canvas drawing calls without replacing rendering or application data.
  await context.addInitScript(() => {
    window.chartProof = {};
    const prototype = CanvasRenderingContext2D.prototype;
    const scale = prototype.scale, arc = prototype.arc, begin = prototype.beginPath;
    const move = prototype.moveTo, line = prototype.lineTo, stroke = prototype.stroke;
    const key = ctx => ctx.canvas.id || (ctx.canvas.dataset.spark ? 'spark-'+ctx.canvas.dataset.spark : '');
    prototype.scale = function(...args) {const id=key(this); if(id)window.chartProof[id]={generation:(window.chartProof[id]?.generation||0)+1,points:[],segments:[]}; return scale.apply(this,args);};
    prototype.arc = function(x,y,...args) {const proof=window.chartProof[key(this)]; if(proof)proof.points.push({x,y}); this.proofPath=[]; return arc.call(this,x,y,...args);};
    prototype.beginPath = function(...args) {this.proofPath=[]; return begin.apply(this,args);};
    prototype.moveTo = function(x,y) {this.proofPath=[{x,y}]; return move.call(this,x,y);};
    prototype.lineTo = function(x,y) {this.proofPath?.push({x,y}); return line.call(this,x,y);};
    prototype.stroke = function(...args) {
      const proof=window.chartProof[key(this)];
      if(proof && this.proofPath?.length===2 && !this.getLineDash().length && this.lineWidth>=1.8)proof.segments.push([...this.proofPath]);
      return stroke.apply(this,args);
    };
  });
  const page = await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  page.on('request',request=>assert.equal(new URL(request.url()).hostname,'127.0.0.1','Unexpected external request'));
  await page.goto(lab.url); await page.locator('#test-mode-banner').waitFor();
  await page.waitForFunction(()=>document.querySelector('#metric-count').textContent==='0');
  let primaryId;
  const expectedPublic=[],expectedCart=[],expectedTotals=[];
  for (const [index,[name,scenario]] of Object.entries(Object.entries(SCENARIOS))) {
    setScenario(lab.source,name);
    const count = Number(index)+1;
    await page.locator('#refresh-button').click();
    // Wait for the application's own polling to refresh the rendered table and charts.
    await page.waitForFunction(expected=>typeof state!=='undefined' && state.data?.status.checks[0]?.id===expected
      && !state.data.status.running && state.data.items.length===2,count,{timeout:25000});
    const data=await (await fetch(lab.url+'/api/dashboard?list=cart')).json();
    const primary=data.items.find(row=>row.sku==='TEST-EDP-15');primaryId=primary.id;
    assert.equal(data.items.length,2);assert.equal(primary.price,scenario.public);
    assert.equal(primary.minimum,count===1?100000:80000);
    const delta=[null,-20000,40000,0,0,-25000,null,0][Number(index)];
    assert.equal(primary.delta,delta);
    const row=page.locator(`tr[data-id="${primary.id}"]`);
    assert.ok((await row.innerText()).includes(new Intl.NumberFormat('ru-RU').format(scenario.public/100)));
    assert.equal(await page.locator('#metric-drops').textContent(),['drop','recovery'].includes(name)?'1':'0');
    if(name==='drop')assert.ok((await row.innerText()).includes('20,0%'));
    if(name==='rise')assert.ok((await row.innerText()).includes('50,0%'));
    if(scenario.error) {
      assert.ok((await row.innerText()).includes('Последняя известная'));
      assert.ok((await row.innerText()).includes('Нет свежих данных'));
    }
    const total=scenario.error?null:scenario.unavailable?60000:scenario.public+60000;
    expectedTotals.push(total);expectedPublic.push(scenario.error?null:scenario.public);expectedCart.push(scenario.cart);
    const overview=await page.evaluate(()=>window.chartProof['overview-chart']);
    assert.equal(overview.points.length,expectedTotals.filter(price=>price!==null).length);
    if(['drop','rise','unchanged'].includes(name)) {
      const [previous,current]=overview.points.slice(-2);
      assert.ok(name==='drop'?current.y>previous.y:name==='rise'?current.y<previous.y:Math.abs(current.y-previous.y)<0.01);
    }
    assert.equal(overview.segments.length,Math.min(Number(index),3));
    const prefix=String(count).padStart(2,'0')+'-'+name;
    await page.screenshot({path:join(root,'screenshots',prefix+'-overview.png'),fullPage:true});
    const previousGeneration=await page.evaluate(()=>window.chartProof['detail-chart']?.generation||0);
    await row.click(); await page.locator('#product-dialog').waitFor({state:'visible'});
    await page.waitForFunction(expected=>document.querySelectorAll('#detail-history tr').length===expected,count);
    const detail=await (await fetch(lab.url+`/api/product/${primary.id}?days=0`)).json();
    assert.deepEqual(detail.points.map(point=>point.price),expectedPublic);
    await page.waitForFunction(({generation,points})=>window.chartProof['detail-chart']?.generation>generation
      && window.chartProof['detail-chart'].points.length===points,
      {generation:previousGeneration,points:expectedPublic.filter(price=>price!==null).length});
    const detailProof=await page.evaluate(()=>window.chartProof['detail-chart']);
    assert.equal(detailProof.points.length,expectedPublic.filter(price=>price!==null).length);
    assert.equal(detailProof.segments.length,Math.min(Number(index),5));
    await page.screenshot({path:join(root,'screenshots',prefix+'-detail.png'),fullPage:true});
    await page.locator('[data-close="product-dialog"]').click();
    await page.locator('#price-context').selectOption('cart');
    await page.waitForFunction(value=>document.querySelector('#metric-total').textContent.includes(value),
      new Intl.NumberFormat('ru-RU').format((scenario.unavailable?55000:scenario.cart+55000)/100));
    const account=await (await fetch(lab.url+`/api/product/${primary.id}?context=cart&days=0`)).json();
    assert.deepEqual(account.points.map(point=>point.price),expectedCart);
    await page.locator('#price-context').selectOption('public');
    await page.waitForFunction(value=>document.querySelector('#metric-total').textContent===value,
      total==null?'—':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(total/100)+' ₽');
    const requestCount=lab.source.prepare("SELECT COUNT(*) AS n FROM requests WHERE path='/product/test-lab-graph-eau' AND scenario=?").get(name).n;
    assert.equal(requestCount,1);
    results.push({scenario:name,label:scenario.label,public_price:scenario.public/100,cart_price:scenario.cart/100,
      delta:delta==null?null:delta/100,total:total==null?null:total/100,minimum:primary.minimum/100,
      points:detailProof.points.length,overview_points:overview.points.length,status:primary.status,screenshots:prefix});
    console.log(`${name}: OK; public=${scenario.public/100}; cart=${scenario.cart/100}; chart points=${detailProof.points.length}`);
  }
  assert.deepEqual(errors,[]);
  assert.equal(lab.tracker.db.get('SELECT COUNT(*) AS n FROM observations').n,32);
  assert.equal(lab.tracker.db.get('PRAGMA integrity_check').integrity_check,'ok');
  // Reopen the saved SQLite file to verify that chart history survives an application restart.
  await browser.close();browser=null;await lab.close();
  const restarted=await startLab({root,port:0});
  try {
    const detail=await (await fetch(restarted.url+`/api/product/${primaryId}?days=0`)).json();
    assert.deepEqual(detail.points.map(point=>point.price),expectedPublic);
    assert.equal((await (await fetch(restarted.url+'/api/status')).json()).checks.length,8);
  } finally {await restarted.close();}
  writeFileSync(join(root,'report.json'),JSON.stringify({passed:true,run,browser:browserPath,checks:8,observations:32,restart_preserved:true,results},null,2));
  writeFileSync(join(root,'report.md'),`# Проверка тестовой базы и графиков\n\nВсе 8 сценариев прошли в настоящем браузере. Проверены HTTP-загрузка, парсинг, SQLite, таблицы, проценты, суммы, линии и точки Canvas, отдельные цены корзины, сохранение после перезапуска.\n\n| Сценарий | На сайте, ₽ | В корзине, ₽ | Изменение, ₽ | Сумма, ₽ | Минимум, ₽ |\n|---|---:|---:|---:|---:|---:|\n${results.map(row=>`| ${row.label} | ${row.public_price} | ${row.cart_price} | ${row.delta??'—'} | ${row.total??'—'} | ${row.minimum} |`).join('\n')}\n\nИсходные цены: source.sqlite3. Сохранённая история: history.sqlite3. Скриншоты: screenshots/. Проверки: 8; записей истории: 32.\n`);
  writeFileSync(join(directory,'active.json'),JSON.stringify({run},null,2));
  console.log(`PASS: ${join(root,'report.md')}\nStart this saved test database: npm run lab`);
} catch(error) {
  writeFileSync(join(root,'failure.json'),JSON.stringify({run,error:error.stack,results,browser_errors:errors},null,2));
  throw error;
} finally {await browser?.close();await lab.close();}
