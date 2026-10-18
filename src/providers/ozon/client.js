import {existsSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ValidationError} from '../../errors.js';
import {requestOzonJson} from './json-client.js';
import {OzonSession} from './session.js';
import {validateCapturedRequest} from './network-capture.js';
import {contextMatches, bankConditionsRequest} from './account-context.js';
import {latestFavorites, parseCartPage, parseProductPage} from './parser.js';
import {browserCollection} from './recovery.js';
import {ozonProduct} from './url.js';

export class OzonReadError extends Error {
  constructor(code, retry = 0) {
    const messages = {access_limited:'Ozon ограничил доступ. Проверки приостановлены.',login_required:'Нужно обновить вход в Ozon.',
      context_mismatch:'Аккаунт или адрес Ozon не подтверждён. Проверки приостановлены.',rate_limited:'Ozon попросил снизить частоту. Проверки приостановлены.',
      incomplete_data:'Получен неполный список Ozon. Предыдущий состав сохранён.',invalid_data:'Не удалось подтвердить данные Ozon.',
      network_error:'Не удалось получить ответ Ozon.',interrupted:'Проверка Ozon остановлена.',
      browser_unverified:'Не удалось подтвердить серверный браузер Ozon. Проверки приостановлены.',
      redirect:'Карточка Ozon перенаправляет на неподтверждённую страницу.'};
    super(messages[code] || 'Ozon не вернул подтверждённые данные. Проверки приостановлены.');
    this.code = code; this.retry_after_ms = retry;
  }
}
const privateJson = path => {
  if (!existsSync(path) || statSync(path).size > 1024*1024) throw new ValidationError('Подключение Ozon ещё не настроено.');
  try {return JSON.parse(readFileSync(path,'utf8'));} catch {throw new ValidationError('Нужно обновить подключение Ozon.');}
};
export class OzonClient {
  constructor(root, {fetchImpl = fetch, browser = browserCollection} = {}) {
    this.root = root; this.directory = join(root,'.secrets/ozon'); this.fetchImpl = fetchImpl; this.createBrowser = browser;
  }
  configured() {return existsSync(join(this.directory,'connection.json')) && existsSync(join(this.directory,'session.json'));}
  async open(signal) {
    await this.close();
    this.connection = privateJson(join(this.directory,'connection.json'));
    const config = this.connection;
    if (config.version !== 1 || config.top_level_site !== 'https://ozon.ru' || config.has_cross_site_ancestor !== false
      || !/^[1-9]\d{0,19}$/.test(config.reference?.account_id) || !/^[a-f0-9]{64}$/.test(config.reference?.delivery_digest)) throw new ValidationError('Нужно обновить подключение Ozon.');
    this.session = await OzonSession.open(join(this.directory,'session.json'),'bootstrap=disabled');
    this.signal = signal;
    this.source = 'http';
    return createHash('sha256').update(JSON.stringify(config.reference)).digest('hex');
  }
  request(path) {
    return validateCapturedRequest({method:'GET',url:'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url='+encodeURIComponent(path),headers:this.connection.headers});
  }
  async read(request, {loginFlag = false, context = true} = {}) {
    if (this.signal?.aborted) throw new OzonReadError('interrupted');
    if (this.browser) return this.readBrowser(request,{loginFlag,context});
    if (!await this.session.header(request.url)) throw new OzonReadError('login_required');
    const result = await requestOzonJson(request, {session:this.session,fetchImpl:this.fetchImpl,signal:this.signal});
    // After 403, keep the remaining collection inside one saved browser session.
    if (result.summary.http_status === 403 && !result.summary.retry_after_ms && this.createBrowser && !this.signal?.aborted) {
      try {
        this.browser = await this.createBrowser({signal:this.signal,cookies:await this.session.browserCookies()});
        this.source = 'browser';
        if (request.operation === 'banks') await this.readBrowser(this.request('/product/'+request.external_id+'/'));
        return await this.readBrowser(request,{loginFlag,context});
      } catch (error) {
        if (error instanceof OzonReadError) throw error;
        throw new OzonReadError(this.signal?.aborted ? 'interrupted' : 'access_limited');
      }
    }
    if (!result.data || result.summary.outcome !== 'json_received') throw new OzonReadError(this.signal?.aborted ? 'interrupted' : result.summary.outcome,result.summary.retry_after_ms);
    if (context) {
      const verified = contextMatches(result.data,this.connection.reference,{requireLoginFlag:loginFlag});
      if (!verified.account_verified || !verified.delivery_verified) throw new OzonReadError('context_mismatch');
    }
    return result.data;
  }
  async readBrowser(request, {loginFlag = false,context = true} = {}) {
    try {
      const result = await this.browser.read({...request,headers:{}});
      if (this.signal?.aborted) throw new OzonReadError('interrupted');
      if (result?.version !== 2 || result.request_url !== request.url || result.user_agent !== this.connection.headers['user-agent']) throw new OzonReadError('browser_unverified');
      if (!result.data || result.outcome !== 'json_received' || result.http_status !== 200) throw new OzonReadError(result.outcome,result.retry_after_ms || 0);
      if (context) {
        const verified = contextMatches(result.data,this.connection.reference,{requireLoginFlag:loginFlag});
        if (!verified.account_verified || !verified.delivery_verified) throw new OzonReadError('context_mismatch');
      }
      if (request.operation === 'product') parseProductPage(result.data,request.external_id);
      return result.data;
    } catch (error) {
      if (error instanceof OzonReadError) throw error;
      throw new OzonReadError(this.signal?.aborted ? 'interrupted' : 'access_limited');
    }
  }
  async close() {const browser = this.browser;this.browser = null;await browser?.close();}
  async lists() {
    const pages = [];
    let path = '/my/favorites?sorting=last_added', favorites;
    for (let page = 0; page < 5; page++) {
      pages.push(await this.read(this.request(path),{loginFlag:true}));
      try {favorites = latestFavorites(pages,30);} catch {throw new OzonReadError('invalid_data');}
      if (favorites.complete) break;
      if (!favorites.next_page) throw new OzonReadError('incomplete_data');
      path = favorites.next_page;
    }
    if (!favorites?.complete) throw new OzonReadError('incomplete_data');
    const data = await this.read(this.request('/cart'));
    let cart;
    try {cart = parseCartPage(data);} catch {throw new OzonReadError('incomplete_data');}
    return {favorites:favorites.items,cart:cart.items};
  }
  async product(sku, url = 'https://www.ozon.ru/product/'+sku+'/') {
    const identity = ozonProduct(url);
    if (identity.external_id !== sku) throw new OzonReadError('invalid_data');
    const request = this.request(new URL(identity.url).pathname);
    const data = await this.read(request);
    try {
      let product = parseProductPage(data,sku);
      if (product.prices.bank_kopecks && !product.payment.ozon_card_verified) {
        const banks = bankConditionsRequest(data,request);
        if (banks) product = parseProductPage(data,sku,{external_id:sku,data:await this.read(banks,{context:false})});
      }
      return {...product,url:identity.url};
    } catch (error) {if (error instanceof OzonReadError) throw error; throw new OzonReadError('invalid_data');}
  }
}
