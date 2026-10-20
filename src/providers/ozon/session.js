import {readFileSync, statSync, lstatSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Cookie, CookieJar, cookieCompare, domainMatch, pathMatch} from 'tough-cookie';
import {OZON_ORIGIN} from './url.js';
import {ValidationError} from '../../errors.js';

export const OZON_JSON_PATH = '/api/entrypoint-api.bx/page/json/v2';
export const OZON_COOKIE_PARTITION = Object.freeze({topLevelSite:'https://ozon.ru',hasCrossSiteAncestor:false});
const jarOptions = {prefixSecurity:'strict',allowSpecialUseDomain:false};
const invalid = () => new ValidationError('Не удалось прочитать приватную HTTP-сессию Ozon.');

function scopedUrl(value) {
  const url = new URL(value);
  if (url.origin !== OZON_ORIGIN || url.pathname !== OZON_JSON_PATH || url.username || url.password || url.hash) throw invalid();
  return url;
}

function bootstrapPairs(header) {
  if (typeof header !== 'string' || !header || header.length > 50000 || /[^\x20-\x7e]/.test(header)) throw invalid();
  const pairs = header.split(';').map(value => value.trim());
  const result = new Map();
  for (const pair of pairs) {
    const split = pair.indexOf('=');
    const key = pair.slice(0, split), value = pair.slice(split + 1);
    if (split < 1 || !/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || result.has(key)) throw invalid();
    result.set(key, value);
  }
  if (result.size > 200) throw invalid();
  return result;
}

export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw invalid();
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
    renameSync(temporary, path);
  } finally {rmSync(temporary, {force: true});}
}

// A captured Cookie header has no domain/path/expiry metadata. Keep that bootstrap
// only for the exact captured API origin/path. Validated Set-Cookie replaces it by
// name, including deletions; the jar then owns scope, expiry and prefix handling.
export class OzonSession {
  constructor(header, {path = null, current = Date.now} = {}) {
    this.bootstrap = bootstrapPairs(header);
    this.shadowed = new Set();
    this.jar = new CookieJar(undefined, jarOptions);
    // This jar represents only the fixed first-party Ozon partition above.
    this.partitionedJar = new CookieJar(undefined, jarOptions);
    this.path = path;
    this.current = current;
  }

  static async open(path, header, options = {}) {
    const session = new OzonSession(header, {path, ...options});
    if (!existsSync(path)) return session;
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || statSync(path).size > 1024 * 1024) throw invalid();
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved.provider !== 'ozon-http-session' || saved.version !== 1 || !Array.isArray(saved.shadowed)
        || saved.shadowed.some(key => typeof key !== 'string' || key.length > 200)
        || !Array.isArray(saved.jar?.cookies)
        || saved.partitionedJar !== undefined && !Array.isArray(saved.partitionedJar?.cookies)
        || saved.jar.cookies.length+(saved.partitionedJar?.cookies.length || 0) > 200) throw invalid();
      session.bootstrap = bootstrapPairs(saved.bootstrap);
      session.shadowed = new Set(saved.shadowed);
      session.jar = await CookieJar.deserialize({...saved.jar, prefixSecurity: 'strict', rejectPublicSuffixes: true,
        enableLooseMode: false, allowSpecialUseDomain: false});
      if (saved.partitionedJar) session.partitionedJar = await CookieJar.deserialize({...saved.partitionedJar,
        prefixSecurity:'strict',rejectPublicSuffixes:true,enableLooseMode:false,allowSpecialUseDomain:false});
      for (const cookie of [...saved.jar.cookies,...(saved.partitionedJar?.cookies || [])]) {
        if (!['ozon.ru', 'www.ozon.ru'].includes(cookie.domain) || !pathMatch(OZON_JSON_PATH, cookie.path)) throw invalid();
      }
      if (saved.partitionedJar?.cookies.some(cookie => cookie.secure !== true)) throw invalid();
      return session;
    } catch {throw invalid();}
  }

  async header(url) {
    scopedUrl(url);
    const learned = [];
    for (const jar of [this.jar,this.partitionedJar]) {
      for (const cookie of await jar.getCookies(url,{expire:false})) {
        if (cookie.expiryTime() <= this.current()) await jar.store.removeCookie(cookie.domain,cookie.path,cookie.key);
        else learned.push(cookie);
      }
    }
    const pairs = [...this.bootstrap].filter(([key]) => !this.shadowed.has(key)).map(([key, value]) => key + '=' + value);
    return [...pairs, ...learned.sort(cookieCompare).map(cookie => cookie.cookieString())].join('; ');
  }

  async absorb(headers, address) {
    const url = scopedUrl(address);
    let changed = false;
    for (const value of headers.getSetCookie()) {
      if (value.length > 50000) continue;
      const parsed = Cookie.parse(value);
      if (!parsed) continue;
      const partitioned = parsed.extensions?.some(extension => extension.toLowerCase() === 'partitioned');
      if (partitioned && !parsed.secure) continue;
      const jar = partitioned ? this.partitionedJar : this.jar;
      try {
        // Persist an absolute deadline. Accessing a cookie must not prolong Max-Age.
        if (parsed.maxAge != null) {
          const age = typeof parsed.maxAge === 'number' ? parsed.maxAge : -1;
          parsed.expires = new Date(age <= 0 ? 0 : Math.min(8640000000000000, this.current() + age * 1000));
          parsed.maxAge = null;
        }
        const cookie = await jar.setCookie(parsed, url, {now: new Date(this.current())});
        if (!cookie || !domainMatch(url.hostname, cookie.domain) || !pathMatch(url.pathname, cookie.path)) {
          if (cookie) await jar.store.removeCookie(cookie.domain, cookie.path, cookie.key);
          continue;
        }
        this.shadowed.add(cookie.key);
        changed = true;
      } catch { /* Ignore invalid scope/prefix cookies without logging their values. */ }
    }
    if (changed) await this.save();
    return changed;
  }

  async browserCookies() {
    const result = [];
    for (const [jar,partitioned] of [[this.jar,false],[this.partitionedJar,true]]) {
      const cookies = await jar.getCookies(OZON_ORIGIN+OZON_JSON_PATH,{expire:false});
      result.push(...cookies.filter(cookie => cookie.expiryTime() > this.current()).map(cookie => ({name:cookie.key,value:cookie.value,
        domain:cookie.domain,hostOnly:!!cookie.hostOnly,path:cookie.path,secure:!!cookie.secure,httpOnly:!!cookie.httpOnly,
        ...(cookie.sameSite ? {sameSite:cookie.sameSite} : {}),
        ...(partitioned ? {partitionKey:{...OZON_COOKIE_PARTITION}} : {}),
        ...(Number.isFinite(cookie.expiryTime()) ? {expires:cookie.expiryTime()/1000} : {})})));
    }
    return result;
  }

  async save() {
    if (!this.path) return;
    writePrivateJson(this.path, {provider: 'ozon-http-session', version: 1,
      bootstrap: [...this.bootstrap].map(([key, value]) => key + '=' + value).join('; '),
      shadowed: [...this.shadowed], jar: await this.jar.serialize(),partitionedJar:await this.partitionedJar.serialize()});
  }
}
