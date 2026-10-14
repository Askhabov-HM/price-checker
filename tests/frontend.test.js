import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function setup({savedScale = null, storageFails = false} = {}) {
  const elements = new Map(), pending = [], timers = [];
  const storage = new Map(savedScale == null ? [] : [['price-checker-chart-scale', savedScale]]);
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', innerHTML: '', value: '', hidden: false, open: false,
      classList: {toggle() {}}, handlers: new Map(),
      addEventListener(name, handler) {this.handlers.set(name, handler);},
      getBoundingClientRect() {return {width: 0, height: 0};},
      showModal() {this.open = true;},
      close() {this.open = false; this.handlers.get('close')?.();}
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {getElementById: element, querySelectorAll: () => []},
    window: {addEventListener() {}, localStorage: {
      getItem(key) {if (storageFails) throw new Error('Storage unavailable'); return storage.get(key) ?? null;},
      setItem(key, value) {if (storageFails) throw new Error('Storage unavailable'); storage.set(key, value);}
    }}, navigator: {userAgent: 'test'},
    fetch: path => new Promise(resolve => pending.push({path, resolve})),
    requestAnimationFrame: action => action(), setTimeout: (action, delay) => {timers.push(delay); return timers.length;}, clearTimeout() {}, Intl, URL
  });
  vm.runInContext(source, context, {filename: 'public/app.js'});
  element('filter').value = 'all'; element('sort').value = 'name';
  const request = prefix => {
    const index = pending.findIndex(entry => entry.path.startsWith(prefix));
    assert.notEqual(index, -1, `Missing request: ${prefix}`);
    const entry = pending.splice(index, 1)[0];
    return {path: entry.path, respond: (data, ok = true) => entry.resolve({ok, json: async () => data})};
  };
  return {element, request, timers, storage, run: code => vm.runInContext(code, context)};
}

function drawChart(ui, points, options = {}) {
  return JSON.parse(ui.run(`(() => {
    const proof = {points: [], segments: [], labels: []};
    let path = [], dash = [];
    const ctx = {
      scale() {}, beginPath() {path = [];}, moveTo(x, y) {path = [{x, y}];}, lineTo(x, y) {path.push({x, y});},
      setLineDash(value) {dash = value;}, fill() {},
      stroke() {if (!dash.length && path.length === 2 && this.lineWidth >= 1.8) proof.segments.push([...path]);},
      arc(x, y) {proof.points.push({x, y});}, fillText(label) {proof.labels.push(label);}
    };
    const canvas = {getBoundingClientRect: () => ({width: 600, height: 240}), getContext: () => ctx};
    globalThis.getComputedStyle = () => ({getPropertyValue: () => '#aaa'});
    chart(canvas, ${JSON.stringify(points)}, ${JSON.stringify(options)});
    return JSON.stringify(proof);
  })()`));
}

const product = id => ({id, brand: 'Brand', name: `Fragrance ${id}`, label: 'EDP 1.5 ml', sku: String(id), url: 'https://randewoo.ru/product/test'});
const detail = (id, price) => ({product: product(id), context: 'public', points: [{checked_at: '2026-10-10T00:00:00+00:00', price, status: 'ok', in_stock: true}]});
const status = {checks: [{id: 1, completed: 1, status: 'success'}], schedule_enabled: false, running: false, auth_status: 'ok'};
const dashboard = items => ({items, counts: {cart: items.length, watching: 0, favorites: 0}, history: [], status});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a late detail response cannot overwrite the selected period', async () => {
  const ui = setup();
  const old = ui.run('openDetail(1)'), first = ui.request('/api/product/');
  ui.run('state.days = 7');
  const current = ui.run('openDetail(1)'), second = ui.request('/api/product/');
  assert.match(first.path, /days=30/); assert.match(second.path, /days=7/);
  second.respond(detail(1, 10000)); await current;
  first.respond(detail(1, 20000)); await old;
  assert.equal(ui.run('state.days'), 7);
  assert.equal(ui.run('state.detail.points[0].price'), 10000);
});

test('a late product response cannot reopen or replace the selected product', async () => {
  const ui = setup();
  const old = ui.run('openDetail(1)'), first = ui.request('/api/product/');
  const current = ui.run('openDetail(2)'), second = ui.request('/api/product/');
  second.respond(detail(2, 10000)); await current;
  first.respond(detail(1, 20000)); await old;
  assert.equal(ui.run('state.detail.product.id'), 2);
  const refresh = ui.run('openDetail(2)'), last = ui.request('/api/product/');
  ui.element('product-dialog').close(); last.respond(detail(2, 9000)); await refresh;
  assert.equal(ui.element('product-dialog').open, false);
});

test('an older dashboard response cannot replace newer results for the same list', async () => {
  const ui = setup();
  const old = ui.run('loadDashboard()'), first = ui.request('/api/dashboard');
  const current = ui.run('loadDashboard()'), second = ui.request('/api/dashboard');
  second.respond(dashboard([])); assert.equal(await current, true);
  first.respond(dashboard([{...product(1), price: 20000}])); assert.equal(await old, false);
  assert.equal(ui.run('state.data.items.length'), 0);
});

test('polling retries a failed dashboard read even when the check version stays the same', async () => {
  const ui = setup();
  ui.request('/api/status'); // Keep bootstrap separate from the explicit polling calls.
  const first = ui.run('poll()'); ui.request('/api/status').respond(status); await tick();
  ui.request('/api/dashboard').respond({error: 'Temporary failure'}, false); await first;
  assert.equal(ui.run('state.version'), '');
  const second = ui.run('poll()'); ui.request('/api/status').respond(status); await tick();
  ui.request('/api/dashboard').respond(dashboard([])); await second;
  assert.equal(ui.run('state.version'), '1:1:success');
});

test('the minimum-price filter excludes stale prices', () => {
  const ui = setup();
  ui.run(`state.data = {items: [{id: 1, brand: 'Brand', name: 'Name', sku: '1', price: 10000, minimum: 10000, observations: 2, status: 'error'}]}`);
  ui.element('filter').value = 'minimum'; ui.run('renderRows()');
  assert.equal(ui.element('visible-count').textContent, 0);
});

test('failed price comparisons are not labeled as the first check', () => {
  const ui = setup();
  ui.run(`state.data = {items: [{id: 1, brand: 'Brand', name: 'Name', sku: '1', label: 'EDP 1.5 ml', price: 10000, minimum: 10000, delta: null, observations: 6, status: 'error'}]}`);
  ui.run('renderRows()');
  assert.match(ui.element('product-rows').innerHTML,/Нет свежих данных/);
  assert.doesNotMatch(ui.element('product-rows').innerHTML,/Первая проверка/);
});

test('manual refresh loads results and promptly polls an active check', async () => {
  const ui = setup(), active = {...status,running:true,checks:[{id:1,completed:0,status:'running'}]};
  ui.request('/api/status');
  const refresh = ui.element('refresh-button').handlers.get('click')();
  ui.request('/api/refresh').respond({started:true}); await tick();
  ui.request('/api/status').respond(active); await tick();
  ui.request('/api/dashboard').respond({...dashboard([]),status:active}); await refresh;
  assert.equal(ui.run('state.data.status.running'),true);
  assert.equal(ui.timers.at(-1),1800);
});

test('check scale spreads irregular observations evenly without changing prices', () => {
  const ui = setup();
  const points = [
    {checked_at: '2026-10-11T13:01:00Z', price: 10000},
    {checked_at: '2026-10-11T13:01:01Z', price: 8000},
    {checked_at: '2026-10-11T13:02:00Z', price: 12000}
  ];
  const time = drawChart(ui, points, {scale: 'time'}), checks = drawChart(ui, points, {scale: 'checks'});
  const timeSpan = time.points[2].x - time.points[0].x;
  assert.ok(Math.abs((time.points[1].x - time.points[0].x) / timeSpan - 1 / 60) < 1e-10);
  assert.equal(checks.points[1].x - checks.points[0].x, checks.points[2].x - checks.points[1].x);
  assert.deepEqual(checks.points.map(p => p.y), time.points.map(p => p.y));
  assert.deepEqual(checks.labels.filter(label => label.startsWith('№')), ['№1', '№2', '№3']);
  assert.equal(time.segments.length, 2); assert.equal(checks.segments.length, 2);
});

test('check scale separates simultaneous checks and preserves missing-data and composition gaps', () => {
  const ui = setup();
  const points = [
    {price: 10000, composition: 'a'}, {price: 9000, composition: 'a'}, {price: null, composition: 'a'},
    {price: 8000, composition: 'b'}, {price: 7000, composition: 'c'}
  ].map(p => ({...p, checked_at: '2026-10-11T13:01:00Z'}));
  const checks = drawChart(ui, points, {scale: 'checks', total: true});
  const step = checks.points[1].x - checks.points[0].x;
  assert.ok(step > 0);
  assert.equal(checks.points[2].x - checks.points[1].x, step * 2);
  assert.equal(checks.points[3].x - checks.points[2].x, step);
  assert.deepEqual(checks.segments, [[checks.points[0], checks.points[1]]]);
  const time = drawChart(ui, points, {scale: 'time', total: true});
  assert.equal(new Set(time.points.map(p => p.x)).size, 1);
  assert.equal(time.segments.length, checks.segments.length);
});

test('both scales handle a single check and a history containing only errors', () => {
  const ui = setup();
  for (const scale of ['time', 'checks']) {
    const points = [{checked_at: '2026-10-11T13:01:00Z', price: 10000}];
    const single = drawChart(ui, points, {scale});
    assert.deepEqual(single.points.map(p => p.x), [327]);
    assert.equal(single.segments.length, 0);
    const empty = drawChart(ui, [{...points[0], price: null}], {scale});
    assert.equal(empty.points.length, 0); assert.equal(empty.segments.length, 0);
  }
});

test('chart scale persists and still works when browser storage is unavailable', () => {
  const ui = setup({savedScale: 'checks'});
  assert.equal(ui.run('state.chartScale'), 'checks');
  ui.run('setChartScale("time")');
  assert.equal(ui.storage.get('price-checker-chart-scale'), 'time');
  ui.run('setChartScale("invalid")');
  assert.equal(ui.run('state.chartScale'), 'time');
  assert.equal(setup({savedScale: 'invalid'}).run('state.chartScale'), 'time');
  const blocked = setup({storageFails: true});
  assert.equal(blocked.run('state.chartScale'), 'time');
  blocked.run('setChartScale("checks")');
  assert.equal(blocked.run('state.chartScale'), 'checks');
});
