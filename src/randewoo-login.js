import {randomBytes} from 'node:crypto';
import {load} from 'cheerio';
import {authorizedUser} from './client.js';
import {FetchError, ValidationError} from './errors.js';

export class LoginError extends ValidationError {
  constructor(message, status = 400) {super(message); this.status = status;}
}

function phoneNumber(value) {
  if (typeof value !== 'string' || !/^[+\d ()-]{10,25}$/.test(value)) throw new ValidationError('Укажите российский мобильный номер +7…');
  let digits = value.replace(/\D/g, '');
  if (/^[78]\d{10}$/.test(digits)) digits = digits.slice(1);
  if (!/^9\d{9}$/.test(digits)) throw new ValidationError('Укажите российский мобильный номер +7…');
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
}

function cookiesFrom(response, jar) {
  for (const line of response.headers['set-cookie'] || []) {
    const [pair, ...attributes] = line.split(';'), index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
    if (!/^[\w-]+$/.test(name) || /[\r\n\0;]/.test(value)) continue;
    const domain = attributes.find(part => /^\s*domain=/i.test(part))?.split('=')[1]?.trim().replace(/^\./, '');
    if (domain && domain !== 'randewoo.ru') continue;
    const expires = attributes.find(part => /^\s*expires=/i.test(part))?.replace(/^\s*expires=/i, '');
    if (attributes.some(part => /^\s*max-age=0\s*$/i.test(part)) || expires && Date.parse(expires) < Date.now()) jar.delete(name);
    else jar.set(name, value);
  }
}

function captchaConfig(html) {
  const field = key => {
    const match = new RegExp('gon\\.' + key + '\\s*=\\s*("[^"\\r\\n]*"|true|false)\\s*;').exec(html);
    return match ? JSON.parse(match[1]) : null;
  };
  if (field('cap_enabled') === false) return null;
  const server = field('cap_server'), siteKey = field('cap_site_key');
  if (server !== 'https://captcha.randewoo.ru' || typeof siteKey !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(siteKey)) {
    throw new FetchError('Изменился способ входа Randewoo. Обновите сессию вручную');
  }
  return {script_url: server + '/assets/widget.js', api_endpoint: server + '/' + siteKey + '/'};
}

export class RandewooLogin {
  constructor(transport, save, {now = Date.now} = {}) {
    this.transport = transport;
    this.save = save;
    this.now = now;
    this.pending = new Map();
    this.busy = new Set();
    this.sends = [];
  }

  cancel(key, id) {
    const entry = this.pending.get(key);
    if (!entry || id && entry.id !== id) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
  }
  clear() {for (const key of this.pending.keys()) this.cancel(key);}
  async exclusive(key, action) {
    if (this.busy.has(key)) throw new LoginError('Дождитесь завершения запроса Randewoo', 409);
    for (const [id, entry] of this.pending) if (entry.expires <= this.now()) this.cancel(id);
    if (!this.transport) throw new FetchError('Подключение Randewoo недоступно в тестовом режиме');
    this.busy.add(key);
    try {return await action();} finally {this.busy.delete(key);}
  }

  entry(key, id) {
    const entry = this.pending.get(key);
    if (!entry || entry.id !== id || entry.expires <= this.now()) throw new ValidationError('Время входа истекло. Начните подключение заново');
    return entry;
  }

  async request(entry, path, data) {
    const response = await this.transport.request(path, {method: data === undefined ? 'GET' : 'POST', json: data !== undefined,
      session: {cookie: [...entry.jar].map(([key, value]) => key + '=' + value).join('; '), user_agent: 'PriceChecker/1.0'},
      ...(data === undefined ? {} : {data, headers: ['X-CSRF-Token: ' + entry.csrf, 'X-Requested-With: XMLHttpRequest',
        'Origin: https://randewoo.ru', 'Referer: https://randewoo.ru/cart']})});
    cookiesFrom(response, entry.jar);
    return response;
  }

  prepare(key) {
    return this.exclusive(key, async () => {
      if (this.pending.size >= 8 && !this.pending.has(key)) throw new LoginError('Слишком много незавершённых подключений. Повторите позже', 429);
      const entry = {id: randomBytes(24).toString('base64url'), expires: this.now() + 10 * 60000, jar: new Map(), attempts: 0};
      this.cancel(key);
      this.pending.set(key, entry);
      entry.timer = setTimeout(() => this.cancel(key, entry.id), 10 * 60000);
      entry.timer.unref();
      try {
        const response = await this.request(entry, '/cart');
        if (response.status !== 200) throw new FetchError('Не удалось открыть вход Randewoo (HTTP ' + response.status + ')');
        entry.csrf = load(response.payload)('meta[name="csrf-token"]').attr('content');
        if (!entry.csrf || /[\r\n\0]/.test(entry.csrf)) throw new FetchError('Не удалось подготовить вход Randewoo');
        entry.captcha = captchaConfig(response.payload);
        this.entry(key, entry.id);
        return {challenge_id: entry.id, captcha: entry.captcha};
      } catch (error) {this.cancel(key, entry.id); throw error;}
    });
  }

  send(key, data) {
    return this.exclusive(key, async () => {
      const entry = this.entry(key, data.challenge_id), phone = phoneNumber(data.phone);
      if (entry.captcha && (typeof data.cap_token !== 'string' || !data.cap_token || data.cap_token.length > 4096 || /[\r\n\0]/.test(data.cap_token))) {
        throw new ValidationError('Пройдите проверку CAPTCHA и повторите запрос');
      }
      this.sends = this.sends.filter(time => time > this.now() - 3600000);
      if (this.sends.length >= 5 || this.sends.length && this.now() - this.sends.at(-1) < 60000 || entry.resendAt > this.now()) {
        throw new LoginError('Код уже запрошен. Подождите перед повторной отправкой', 429);
      }
      this.sends.push(this.now());
      const response = await this.request(entry, '/front_api/auth/login/mobile/sms', {
        mobile: phone, country_code: 'RU', recaptcha_action: 'login_mobile', ...(entry.captcha ? {cap_token: data.cap_token} : {}),
      });
      this.entry(key, entry.id);
      let result;
      try {result = JSON.parse(response.payload);} catch {throw new FetchError('Неожиданный ответ при отправке кода Randewoo');}
      if (response.status !== 200) {
        if (result.error_type === 'recaptcha') throw new ValidationError('Randewoo запросил дополнительную проверку. Войдите на сайте и обновите сессию вручную');
        throw new LoginError(response.status === 429 ? 'Randewoo ограничил отправку кодов. Повторите позже' : 'Randewoo не отправил код. Проверьте номер и повторите позже', response.status === 429 ? 429 : 400);
      }
      entry.phone = phone;
      entry.attempts = 0;
      const estimate = Number(result.estimate);
      const wait = Number.isFinite(estimate) ? Math.max(60, Math.min(estimate, 600)) : 60;
      entry.resendAt = this.now() + wait * 1000;
      return {sent: true, resend_after: wait};
    });
  }

  confirm(key, data) {
    return this.exclusive(key, async () => {
      const entry = this.entry(key, data.challenge_id);
      if (!entry.phone) throw new ValidationError('Сначала запросите код Randewoo');
      if (typeof data.code !== 'string' || !/^\d{4,8}$/.test(data.code)) throw new ValidationError('Введите код из 4–8 цифр');
      if (++entry.attempts > 5) {this.cancel(key); throw new LoginError('Слишком много попыток. Начните подключение заново', 429);}
      const response = await this.request(entry, '/front_api/auth/login/mobile', {
        mobile: entry.phone, country_code: 'RU', code: data.code, time_zone: 'Europe/Moscow',
      });
      this.entry(key, entry.id);
      if (response.status !== 200) throw new ValidationError('Код не подошёл или истёк. Проверьте код или запросите новый');
      const check = await this.request(entry, '/cart');
      if (check.status !== 200) throw new FetchError('Не удалось проверить новую сессию Randewoo');
      authorizedUser(check.payload);
      this.entry(key, entry.id);
      this.save({cookie: [...entry.jar].map(([name, value]) => name + '=' + value).join('; '), user_agent: 'PriceChecker/1.0'});
      this.cancel(key);
      return {connected: true};
    });
  }
}
