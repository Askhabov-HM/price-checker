import {randomBytes, scrypt as scryptCallback, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';

const scrypt = promisify(scryptCallback);
const hashOptions = {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024};
const sessionDuration = 7 * 86400000;
const attemptWindow = 15 * 60000;
const cookieName = 'pricechecker_session';

export class AuthConfigurationError extends Error {}

export async function createCredentials(login, password) {
  if (typeof login !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(login)
    || typeof password !== 'string' || !password.length || password.length > 1024) {
    throw new AuthConfigurationError('Укажите логин (латинские буквы, цифры, точка, дефис) и пароль длиной до 1024 символов.');
  }
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64, hashOptions)).toString('hex');
  return {version: 1, login, salt, hash};
}

export function loadAuthentication(root) {
  try {return new Authentication(JSON.parse(readFileSync(join(root, '.secrets/price-checker-auth.json'), 'utf8')));}
  catch {throw new AuthConfigurationError('Настройте вход в Price Checker командой npm run auth:setup. Файл .secrets/price-checker-auth.json отсутствует или повреждён.');}
}

export class Authentication {
  constructor(credentials, {now = Date.now} = {}) {
    if (credentials?.version !== 1 || typeof credentials.login !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(credentials.login)
      || !/^[a-f0-9]{32}$/.test(credentials.salt || '') || !/^[a-f0-9]{128}$/.test(credentials.hash || '')) {
      throw new AuthConfigurationError('Некорректная конфигурация входа Price Checker.');
    }
    this.credentials = credentials;
    this.now = now;
    this.sessions = new Map();
    this.attempts = new Map();
    this.pending = 0;
  }

  token(request) {
    const cookie = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='));
    return cookie?.slice(cookieName.length + 1) || '';
  }

  session(request) {
    const token = this.token(request), session = this.sessions.get(token);
    if (session && session.expires > this.now()) return session;
    this.sessions.delete(token);
    return null;
  }

  async login(login, password, address) {
    const timestamp = this.now();
    for (const [key, entry] of this.attempts) if (entry.expires <= timestamp) this.attempts.delete(key);
    const attempts = this.attempts.get(address) || {count: 0, expires: timestamp + attemptWindow};
    if (attempts.count >= 8 || this.pending >= 2 || this.attempts.size >= 1024 && !this.attempts.has(address)) {
      return {status: 429, error: 'Слишком много попыток входа. Повторите позже.'};
    }
    attempts.count++;
    this.attempts.set(address, attempts);
    if (typeof login !== 'string' || typeof password !== 'string' || login.length > 80 || password.length > 1024) {
      return {status: 401, error: 'Неверный логин или пароль'};
    }
    this.pending++;
    let valid;
    try {
      const hash = await scrypt(password, this.credentials.salt, 64, hashOptions);
      valid = timingSafeEqual(hash, Buffer.from(this.credentials.hash, 'hex')) && login === this.credentials.login;
    } finally {this.pending--;}
    if (!valid) return {status: 401, error: 'Неверный логин или пароль'};
    this.attempts.delete(address);
    for (const [token, session] of this.sessions) if (session.expires <= timestamp) this.sessions.delete(token);
    // Bound memory even when the same account signs in repeatedly without logging out.
    if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    const session = {login: this.credentials.login, csrf: randomBytes(32).toString('base64url'), expires: this.now() + sessionDuration};
    this.sessions.set(token, session);
    return {status: 200, token, session};
  }

  logout(request) {this.sessions.delete(this.token(request));}

  cookie(token, secure = false) {
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? sessionDuration / 1000 : 0}${secure ? '; Secure' : ''}`;
  }
}
