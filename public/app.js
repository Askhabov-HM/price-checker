"use strict";

const $ = (id) => document.getElementById(id);
const labels = {favorites: "Избранное", cart: "Корзина", watching: "Наблюдение"};
const state = {list: "cart", context: "public", chartScale: "time", data: null, status: null, csrf: "", detail: null, detailId: null, days: 30, version: "", dashboardRequest: 0, detailRequest: 0};
try {if (window.localStorage.getItem("price-checker-chart-scale") === "checks") state.chartScale = "checks";} catch {}
let pollTimer;
const rub = (value) => value == null ? "—" : new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 2}).format(value / 100) + " ₽";
const date = (value, opts = {}) => value ? new Intl.DateTimeFormat("ru-RU", {timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...opts}).format(new Date(value)) : "—";
const timeOnly = (value) => value ? new Intl.DateTimeFormat("ru-RU", {timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit"}).format(new Date(value)) : "—";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json", "X-CSRF-Token": state.csrf}, body: JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Не удалось выполнить запрос");
  return result;
}

function toast(message, error = false) {
  const element = $("toast");
  element.textContent = message;
  element.className = error ? "toast-error" : "";
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 5000);
}

function imageUrl(value) {
  try { const u = new URL(value); return u.protocol === "https:" && u.hostname.endsWith(".randewoo.ru") ? u.href : ""; }
  catch { return ""; }
}

function chart(canvas, points, {small = false, total = false, scale = state.chartScale} = {}) {
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const style = getComputedStyle(canvas);
  const colors = {
    text: style.getPropertyValue("--chart-text").trim(),
    grid: style.getPropertyValue("--chart-grid").trim(),
    line: style.getPropertyValue("--chart-line").trim(),
    border: style.getPropertyValue("--chart-point-border").trim(),
  };
  const w = box.width, h = box.height;
  const pad = small ? {l: 3, r: 3, t: 8, b: 8} : {l: 78, r: 24, t: 24, b: 35};
  const valid = points.filter(p => p.price != null && Number.isFinite(p.price));
  if (!valid.length) {
    if (!small) {ctx.fillStyle = colors.text; ctx.font = "13px Segoe UI, sans-serif"; ctx.textAlign = "center"; ctx.fillText("Пока нет данных для этого графика", w / 2, h / 2);}
    return;
  }
  let lo = Math.min(...valid.map(p => p.price)), hi = Math.max(...valid.map(p => p.price));
  const margin = Math.max((hi - lo) * 0.25, hi * 0.035, 100);
  lo = Math.max(0, lo - margin); hi += margin;
  let first = Math.min(...points.map(p => new Date(p.checked_at).getTime()));
  let last = Math.max(...points.map(p => new Date(p.checked_at).getTime()));
  const indices = new Map(points.map((point, index) => [point, index]));
  const singlePosition = points.length === 1 || (scale === "time" && first === last);
  const x = (point) => singlePosition ? (pad.l + w - pad.r) / 2 : pad.l + (scale === "checks" ? indices.get(point) / (points.length - 1) : (new Date(point.checked_at).getTime() - first) / (last - first)) * (w - pad.l - pad.r);
  const y = (point) => pad.t + (hi - point.price) / (hi - lo) * (h - pad.t - pad.b);
  ctx.font = "11px Segoe UI, sans-serif";
  if (!small) {
    for (let i = 0; i < 4; i++) {
      const value = lo + (hi - lo) * i / 3;
      const yy = pad.t + (hi - value) / (hi - lo) * (h - pad.t - pad.b);
      ctx.strokeStyle = colors.grid; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = colors.text; ctx.textAlign = "right"; ctx.fillText(rub(Math.round(value)), pad.l - 12, yy + 4);
    }
    const ticks = singlePosition ? [valid[0]] : [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]];
    const seen = new Set();
    ticks.forEach((p, index) => {
      const label = scale === "checks" ? `№${indices.get(p) + 1}` : date(p.checked_at);
      if (seen.has(label)) return;
      seen.add(label);
      ctx.fillStyle = colors.text; ctx.textAlign = singlePosition ? "center" : index === 0 ? "left" : index === ticks.length - 1 ? "right" : "center";
      ctx.fillText(label, x(p), h - 10);
    });
  }
  ctx.strokeStyle = colors.line; ctx.lineWidth = small ? 1.8 : 2.5; ctx.lineJoin = "round";
  points.forEach((p, i) => {
    if (p.price == null) return;
    const previous = points[i - 1];
    if (previous && previous.price != null && (!total || previous.composition === p.composition)) {
      ctx.beginPath(); ctx.moveTo(x(previous), y(previous)); ctx.lineTo(x(p), y(p)); ctx.stroke();
    }
  });
  valid.forEach(p => {ctx.fillStyle = colors.line; ctx.beginPath(); ctx.arc(x(p), y(p), small ? 2.5 : 4, 0, Math.PI * 2); ctx.fill(); if (!small) {ctx.strokeStyle = colors.border; ctx.lineWidth = 2; ctx.stroke();}});
  if (!small && valid.length === 1) {
    ctx.fillStyle = colors.line; ctx.textAlign = "center"; ctx.font = "600 13px Segoe UI, sans-serif";
    ctx.fillText(rub(valid[0].price), x(valid[0]), y(valid[0]) - 15);
  }
  if (!small) {
    canvas.title = valid.map(p => `${date(p.checked_at, {second: "2-digit"})} — ${rub(p.price)}`).join("\n");
  }
}

function updateChartScaleControls() {
  document.querySelectorAll("[data-chart-scale]").forEach(button => {
    const active = button.dataset.chartScale === state.chartScale;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-chart-scale-hint]").forEach(hint => {
    hint.textContent = state.chartScale === "checks" ? "Проверки расположены равномерно, независимо от времени." : "Расстояния соответствуют времени между проверками.";
  });
}

function renderCharts() {
  if (state.data) {
    chart($("overview-chart"), state.data.history.map(p => ({...p, price: p.priced_count ? p.known_total : null})), {total: true});
    renderRows();
  }
  if (state.detail && $("product-dialog").open) chart($("detail-chart"), state.detail.points);
}

function setChartScale(scale) {
  if (!["time", "checks"].includes(scale)) return;
  state.chartScale = scale;
  try {window.localStorage.setItem("price-checker-chart-scale", scale);} catch {}
  updateChartScaleControls();
  renderCharts();
}

function updateStatus(status) {
  state.status = status;
  if (status.csrf_token) state.csrf = status.csrf_token;
  $("next-check").textContent = status.schedule_enabled ? date(status.next_check) : "На паузе";
  $("refresh-button").disabled = status.running;
  $("refresh-icon").classList.toggle("rotating", status.running);
  $("refresh-label").textContent = status.running ? "Проверяем…" : "Проверить цены";
  $("auth-label").textContent = status.auth_status === "ok" ? "Randewoo подключён" : status.auth_status === "expired" ? "Нужно обновить сессию" : status.auth_status === "error" ? "Ошибка соединения" : "Сессия не проверена";
  const current = status.checks[0];
  $("progress").hidden = !status.running;
  if (status.running && current) {
    $("progress-title").textContent = current.total ? `Проверяем цены: ${current.completed} из ${current.total}` : "Обновляем корзину и избранное";
    $("progress-description").textContent = "Получаем данные сайта. Предыдущая история остаётся доступной.";
    $("progress-bar").max = current.total || 100; $("progress-bar").value = current.completed;
  }
  const latest = status.checks.find(c => c.trigger !== "import" && c.finished_at);
  const notice = $("notice");
  if (status.auth_status === "expired" || status.auth_status === "error") {
    notice.textContent = status.auth_message + ". Список товаров сохранён; публичные цены продолжают проверяться."; notice.hidden = false;
  } else if (latest && ["error", "partial", "interrupted"].includes(latest.status)) {
    notice.textContent = latest.message; notice.hidden = false;
  } else { notice.hidden = true; }
  renderActivity(status.checks);
}

function renderActivity(checks) {
  const statusLabels = {success: "Готово", partial: "Частично", error: "Ошибка", running: "Проверка", imported: "Импорт истории", interrupted: "Прервана"};
  const triggerLabels = {manual: "Вручную", schedule: "По расписанию", initial: "Первая проверка", cli: "Из командной строки", import: "Реальный снимок"};
  $("activity-list").innerHTML = checks.slice(0, 8).map(c => `<div class="activity-row"><span class="activity-dot ${esc(c.status)}"></span><span class="activity-time">${esc(date(c.finished_at || c.started_at))}</span><span class="activity-trigger">${esc(triggerLabels[c.trigger] || c.trigger)}</span><span class="activity-message">${esc(c.message || "Получаем список товаров…")}</span><span class="activity-badge ${esc(c.status)}">${esc(statusLabels[c.status] || c.status)}</span></div>`).join("") || '<div class="activity-empty">Здесь появятся результаты первой проверки.</div>';
}

async function loadDashboard() {
  const section = state.list, context = state.context;
  const request = ++state.dashboardRequest;
  const data = await api(`/api/dashboard?list=${section}&context=${context}`);
  if (request !== state.dashboardRequest || section !== state.list || context !== state.context) return false;
  state.data = data;
  updateStatus(data.status);
  Object.entries(data.counts).forEach(([key, count]) => {$("count-" + key).textContent = count;});
  const items = data.items;
  $("metric-count").textContent = items.length;
  const priced = items.filter(p => p.price != null && p.in_stock && p.status === "ok");
  $("metric-total").textContent = priced.length ? rub(priced.reduce((sum, p) => sum + p.price, 0)) : "—";
  $("metric-total-foot").textContent = `${priced.length} доступных из ${items.length} · по одному пробнику`;
  $("metric-drops").textContent = items.filter(p => p.delta < 0 && p.status === "ok").length;
  $("metric-drops-foot").textContent = items.some(p => p.previous_price != null) ? "С предыдущей успешной проверки" : "Сравнение появится после второй проверки";
  const latest = items.map(p => p.checked_at).filter(Boolean).sort().pop();
  $("metric-time").textContent = timeOnly(latest);
  $("metric-date").textContent = latest ? date(latest, {hour: undefined, minute: undefined, year: "numeric"}) : "Данные ещё не получены";
  const overview = data.history.map(p => ({...p, price: p.priced_count ? p.known_total : null}));
  chart($("overview-chart"), overview, {total: true});
  const measured = overview.filter(p => p.price != null);
  const lastPoint = measured[measured.length - 1];
  $("overview-caption").textContent = !lastPoint ? "Пока нет цен доступных вариантов." : !lastPoint.complete ? `Сумма доступных вариантов: ${lastPoint.priced_count} из ${lastPoint.count}. Остальные позиции в сумму не включены.` : measured.length === 1 ? "Первая точка сохранена. Линия появится после следующей проверки." : "Каждая точка — выполненная проверка";
  renderRows();
  return true;
}

function renderRows() {
  if (!state.data) return;
  const search = $("search").value.toLocaleLowerCase("ru");
  const filter = $("filter").value, sort = $("sort").value;
  let items = state.data.items.filter(p => `${p.brand} ${p.name} ${p.sku || ""}`.toLocaleLowerCase("ru").includes(search));
  items = items.filter(p => filter === "all" || filter === "drops" && p.delta < 0 && p.status === "ok" || filter === "rises" && p.delta > 0 && p.status === "ok" || filter === "minimum" && p.status === "ok" && p.price != null && p.price === p.minimum && p.observations > 1 || filter === "unavailable" && (p.in_stock === false || p.status === "missing") || filter === "errors" && ["error", "pending"].includes(p.status));
  items.sort((a, b) => sort === "price-asc" ? (a.price ?? Infinity) - (b.price ?? Infinity) : sort === "price-desc" ? (b.price ?? -Infinity) - (a.price ?? -Infinity) : sort === "delta" ? (a.delta ?? Infinity) - (b.delta ?? Infinity) : `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`, "ru"));
  $("visible-count").textContent = items.length;
  $("table-summary").textContent = `Показано ${items.length} из ${state.data.items.length} товаров`;
  $("product-rows").innerHTML = items.map(p => {
    const img = imageUrl(p.image);
    const change = p.status !== "ok" ? `<span class="muted">${p.status === "error" ? "Нет свежих данных" : p.status === "missing" ? "Нет варианта" : "Ожидает проверки"}</span>` : p.delta == null ? '<span class="muted">Первая проверка</span>' : p.delta === 0 ? '<span class="unchanged">— Без изменений</span>' : `<span class="change ${p.delta < 0 ? "down" : "up"}">${p.delta < 0 ? "↘" : "↗"} ${esc(rub(Math.abs(p.delta)))}<small>${p.delta > 0 ? "+" : "−"}${(Math.abs(p.delta) / p.previous_price * 100).toFixed(1).replace(".", ",")}%</small></span>`;
    const stock = p.status === "error" ? '<span class="stock warning">Ошибка проверки</span>' : p.status === "missing" ? '<span class="stock neutral">Нет варианта 1,5 мл</span>' : p.in_stock == null ? '<span class="stock neutral">Ожидает проверки</span>' : p.in_stock ? '<span class="stock"><i></i>В наличии</span>' : '<span class="stock neutral">Нет в наличии</span>';
    return `<tr data-id="${p.id}" tabindex="0" aria-label="История: ${esc(p.brand + " " + p.name)}"><td><div class="product-cell"><div class="product-image">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : `<span>${esc(p.brand.slice(0, 2).toUpperCase())}</span>`}</div><div class="product-info"><span class="product-brand">${esc(p.brand)}</span><strong>${esc(p.name)}</strong><small>${esc(p.label)} <span>·</span> ${p.sku ? "арт. " + esc(p.sku) : "артикул уточняется"}</small></div></div></td><td><span class="price ${p.status === "error" ? "stale-price" : ""}">${esc(rub(p.price))}</span>${p.status === "error" && p.price != null ? '<small class="stale-label">Последняя известная</small>' : ""}</td><td>${change}</td><td><span class="minimum">${esc(rub(p.minimum))}</span></td><td><canvas class="sparkline" data-spark="${p.id}" role="img" aria-label="${p.observations} измерений цены"></canvas><small class="sparkline-label">${p.observations} проверок</small></td><td>${stock}</td><td><button class="watch-button ${p.watching ? "selected" : ""}" data-watch="${p.id}" title="${p.watching ? "Убрать из наблюдения" : "Добавить в наблюдение"}" aria-label="${p.watching ? "Убрать из наблюдения" : "Добавить в наблюдение"}">${p.watching ? "★" : "☆"}</button></td></tr>`;
  }).join("") || `<tr><td colspan="7" class="empty-state"><span>◌</span><strong>${state.data.items.length ? "Ничего не найдено" : "В этом списке пока нет товаров"}</strong><p>${state.list === "watching" ? "Добавьте ссылку или нажмите ☆ рядом с товаром." : "Запустите проверку, чтобы получить список из Randewoo."}</p></td></tr>`;
  const byId = new Map(items.map(p => [p.id, p]));
  document.querySelectorAll("[data-spark]").forEach(c => chart(c, byId.get(Number(c.dataset.spark)).sparkline, {small: true}));
  document.querySelectorAll("[data-watch]").forEach(button => button.addEventListener("click", async e => {
    e.stopPropagation();
    const item = byId.get(Number(button.dataset.watch));
    try {await api("/api/watch", {id: item.id, active: !item.watching}); await loadDashboard(); toast(item.watching ? "Наблюдение остановлено. История сохранена." : "Товар добавлен в наблюдение");}
    catch (error) {toast(error.message, true);}
  }));
  document.querySelectorAll("#product-rows tr[data-id]").forEach(row => {
    row.addEventListener("click", () => openDetail(Number(row.dataset.id)));
    row.addEventListener("keydown", event => {if (event.target === row && event.key === "Enter") openDetail(Number(row.dataset.id));});
  });
  document.querySelectorAll(".product-image img").forEach(img => img.addEventListener("error", () => img.remove()));
}

async function openDetail(id, reopen = true) {
  const request = ++state.detailRequest, context = state.context, days = state.days;
  state.detailId = id;
  try {
    const detail = await api(`/api/product/${id}?context=${context}&days=${days}`);
    if (request !== state.detailRequest || context !== state.context || days !== state.days) return;
    state.detail = detail;
    $("detail-brand").textContent = detail.product.brand;
    $("detail-name").textContent = detail.product.name;
    $("detail-label").textContent = `${detail.product.label} · ${detail.product.sku ? "арт. " + detail.product.sku : "нет артикула"} · ${context === "cart" ? "цена варианта в корзине" : "публичная цена на сайте"}`;
    $("detail-link").href = detail.product.url;
    $("detail-history").innerHTML = [...detail.points].reverse().map(p => `<tr><td>${esc(date(p.checked_at, {second: "2-digit"}))}</td><td><strong>${esc(rub(p.price))}</strong></td><td>${esc(p.status === "error" ? p.message : p.status === "missing" ? "Вариант 1,5 мл не найден" : p.in_stock ? "В наличии" : "Нет в наличии")}</td></tr>`).join("") || '<tr><td colspan="3" class="empty-state">В этом периоде ещё нет проверок.</td></tr>';
    const valid = detail.points.filter(p => p.price != null);
    $("detail-note").textContent = valid.length === 1 ? "Пока сохранена одна реальная цена. История будет расти после следующих проверок." : valid.length ? `Минимум: ${rub(Math.min(...valid.map(p => p.price)))} · Максимум: ${rub(Math.max(...valid.map(p => p.price)))} · Измерений: ${valid.length}` : "Для этого типа цены пока нет измерений. Данные других объёмов сюда не подставляются.";
    if (reopen && !$("product-dialog").open) $("product-dialog").showModal();
    requestAnimationFrame(() => {if (request === state.detailRequest) chart($("detail-chart"), detail.points);});
  } catch (error) {if (request === state.detailRequest) toast(error.message, true);}
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    const status = await api("/api/status");
    updateStatus(status);
    const last = status.checks[0];
    const version = last ? `${last.id}:${last.completed}:${last.status}` : "empty";
    if (version !== state.version) {
      if (await loadDashboard()) state.version = version;
      if ($("product-dialog").open && state.detailId != null && !status.running) await openDetail(state.detailId, false);
    }
  } catch (error) {$("notice").textContent = "Приложение недоступно. Проверьте, что оно запущено на компьютере."; $("notice").hidden = false;}
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, state.status?.running ? 1800 : 15000);
}

document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
$("product-dialog").addEventListener("close", () => {state.detailRequest++; state.detailId = null;});
document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("click", event => {if (event.target === dialog) {const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();}}));
document.querySelectorAll("#navigation [data-list]").forEach(button => button.addEventListener("click", async () => {
  state.list = button.dataset.list;
  if (state.list !== "cart") state.context = "public";
  $("price-context").value = state.context;
  $("price-context").querySelector('[value="cart"]').disabled = state.list !== "cart";
  document.querySelectorAll("#navigation button").forEach(b => b.classList.toggle("active", b === button));
  $("page-title").innerHTML = esc(labels[state.list]) + '<span class="title-dot">.</span>';
  $("breadcrumb-list").textContent = labels[state.list];
  $("page-description").textContent = state.list === "watching" ? "Товары, за которыми вы следите независимо от списков магазина." : state.list === "favorites" ? "Ваше избранное Randewoo. Следим за ценами вариантов 1,5 мл." : "Ваши товары Randewoo. Следим за ценами вариантов 1,5 мл.";
  $("search").value = ""; $("filter").value = "all";
  try {await loadDashboard();} catch (error) {toast(error.message, true);}
}));
$("search").addEventListener("input", renderRows);
$("filter").addEventListener("change", renderRows);
$("sort").addEventListener("change", renderRows);
document.querySelectorAll("[data-chart-scale]").forEach(button => button.addEventListener("click", () => setChartScale(button.dataset.chartScale)));
updateChartScaleControls();
$("price-context").addEventListener("change", async () => {state.context = $("price-context").value; try {await loadDashboard();} catch (error) {toast(error.message, true);}});
$("refresh-button").addEventListener("click", async () => {try {await api("/api/refresh", {}); await poll();} catch (error) {toast(error.message, true);}});
async function pollOnce() {updateStatus(await api("/api/status"));}
$("export-button").addEventListener("click", () => {window.location.href = `/api/export?list=${state.list}&context=${state.context}`;});
$("add-side").addEventListener("click", () => {$("add-dialog").showModal(); $("add-url").focus();});
$("add-form").addEventListener("submit", async event => {
  event.preventDefault(); $("add-submit").disabled = true; $("add-submit").textContent = "Получаем цену…";
  try {await api("/api/watch/add", {url: $("add-url").value}); $("add-dialog").close(); $("add-form").reset(); await loadDashboard(); toast("Товар добавлен в наблюдение");}
  catch (error) {toast(error.message, true);}
  finally {$("add-submit").disabled = false; $("add-submit").textContent = "Добавить товар";}
});
$("settings-button").addEventListener("click", () => {
  $("schedule-input").value = state.status.schedule.join(", "); $("schedule-enabled").checked = state.status.schedule_enabled;
  $("session-message").textContent = state.status.auth_message || "Данные сессии ещё не проверены";
  $("session-cookie").value = ""; $("session-agent").value = navigator.userAgent;
  $("settings-dialog").showModal();
});
$("settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const schedule = $("schedule-input").value.split(/[,;\s]+/).map(t => t.trim()).filter(Boolean);
    await api("/api/settings", {schedule, schedule_enabled: $("schedule-enabled").checked});
    if ($("session-cookie").value.trim()) await api("/api/session", {cookie: $("session-cookie").value, user_agent: $("session-agent").value});
    $("session-cookie").value = ""; $("settings-dialog").close(); await pollOnce(); toast("Настройки сохранены");
  } catch (error) {toast(error.message, true);}
});
document.querySelectorAll("#period-tabs button").forEach(button => button.addEventListener("click", () => {
  state.days = Number(button.dataset.days); document.querySelectorAll("#period-tabs button").forEach(b => b.classList.toggle("active", b === button));
  if (state.detailId != null) openDetail(state.detailId, false);
}));
let resizeTimer;
window.addEventListener("resize", () => {clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCharts, 120);});

(async () => {try {updateStatus(await api("/api/status")); await loadDashboard();} catch (error) {toast(error.message, true);} poll();})();
