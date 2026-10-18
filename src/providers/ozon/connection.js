import {join} from 'node:path';
import {Cookie, pathMatch} from 'tough-cookie';
import {ValidationError} from '../../errors.js';
import {validateCapturedRequest} from './network-capture.js';
import {OzonSession, writePrivateJson} from './session.js';

// A dedicated, first-party Ozon context; never a shared cookie jar for other sites.
export async function importOzonConnection(root, input, exported, {current = Date.now} = {}) {
  const request = validateCapturedRequest(input?.request);
  const reference = input?.reference;
  if (!/^[1-9]\d{0,19}$/.test(reference?.account_id) || !/^[a-f0-9]{64}$/.test(reference?.delivery_digest)
    || !Array.isArray(exported?.cookies) || !exported.cookies.length || exported.cookies.length > 200) throw new ValidationError('Некорректный экспорт подключения Ozon.');
  const headers = {...request.headers};
  delete headers.cookie;
  const path = join(root,'.secrets/ozon/session.json');
  const session = new OzonSession('bootstrap=disabled',{path,current});
  session.shadowed.add('bootstrap');
  const identities = new Set();
  let count = 0;
  for (const source of exported.cookies) {
    if (!['.ozon.ru','ozon.ru','www.ozon.ru'].includes(source.domain) || source.partitionKeyOpaque) throw new ValidationError('Неподдерживаемая область cookies Ozon.');
    if (source.partitionKey && (source.partitionKey.topLevelSite !== 'https://ozon.ru' || source.partitionKey.hasCrossSiteAncestor !== false)) continue;
    if (!source.session && (!Number.isFinite(source.expires) || source.expires*1000 <= current())) continue;
    if (typeof source.name !== 'string' || !/^[!#$%&'*+.^_`|~\w-]+$/.test(source.name) || typeof source.value !== 'string'
      || /[^\x20-\x7e]|;/.test(source.value) || source.value.length > 50000 || typeof source.path !== 'string'
      || !pathMatch(new URL(request.url).pathname,source.path)) throw new ValidationError('Некорректные cookies Ozon.');
    const identity = [source.domain.replace(/^\./,''),source.path,source.name].join('|');
    if (identities.has(identity)) throw new ValidationError('Неоднозначный partition-контекст cookies Ozon.');
    identities.add(identity);
    const cookie = new Cookie({key:source.name,value:source.value,domain:source.domain.replace(/^\./,''),hostOnly:!source.domain.startsWith('.'),
      path:source.path,secure:source.secure,httpOnly:source.httpOnly,sameSite:source.sameSite?.toLowerCase(),expires:source.session ? 'Infinity' : new Date(source.expires*1000)});
    try {await session.jar.setCookie(cookie,request.url,{now:new Date(current())});} catch {throw new ValidationError('Некорректная область cookies Ozon.');}
    count++;
  }
  if (!count || !await session.header(request.url)) throw new ValidationError('В экспорте нет действующих cookies Ozon.');
  await session.save();
  writePrivateJson(join(root,'.secrets/ozon/connection.json'),{version:1,top_level_site:'https://ozon.ru',has_cross_site_ancestor:false,headers,reference});
  return {imported:true,cookies:count};
}
