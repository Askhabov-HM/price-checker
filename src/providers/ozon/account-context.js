import {createHash} from 'node:crypto';
import {ValidationError} from '../../errors.js';
import {validateCapturedRequest} from './network-capture.js';

const invalid = () => new ValidationError('Не удалось подтвердить аккаунт или доставку Ozon.');

function widget(data, prefix) {
  const values = Object.entries(data?.widgetStates || {}).filter(([key]) => key.startsWith(prefix + '-'));
  if (values.length !== 1) throw invalid();
  try {return typeof values[0][1] === 'string' ? JSON.parse(values[0][1]) : values[0][1];} catch {throw invalid();}
}

// Reference fields are private. Public health output contains only match flags.
export function accountContext(data, {requireLoginFlag = false} = {}) {
  const user = data?.userInfo?.user;
  const location = data?.location?.current;
  const address = widget(data, 'addressBookBarWeb');
  const labels = address?.customCell?.cells?.map(cell => cell?.button?.text || cell?.text?.text).filter(Boolean);
  if (!Number.isSafeInteger(user?.userId) || user.userId <= 0 || user.isLoggedIn === false
    || requireLoginFlag && user.isLoggedIn !== true || !location || typeof location !== 'object'
    || !Number.isSafeInteger(location.areaId) || typeof location.uid !== 'string' || !location.uid
    || !labels?.length || labels.some(label => typeof label !== 'string' || label.length > 2000)) throw invalid();
  // Stable account-selected locality and visible address; no coordinates or tracking tokens.
  const context = {area_id: location.areaId, uid: location.uid, city: location.city,
    country_code: location.countryCode, fias: location.fias, labels};
  return {account_id: String(user.userId), delivery_digest: createHash('sha256').update(JSON.stringify(context)).digest('hex')};
}

export function contextMatches(data, reference, options) {
  let actual;
  try {actual = accountContext(data, options);} catch {return {account_verified: false, delivery_verified: false};}
  return {account_verified: actual.account_id === reference.account_id,
    delivery_verified: actual.delivery_digest === reference.delivery_digest};
}

// Only follow the bank information link actually returned by the same SKU's price widget.
export function bankConditionsRequest(data, productRequest) {
  const product = validateCapturedRequest(productRequest);
  if (product.operation !== 'product') throw invalid();
  const link = widget(data, 'webPrice')?.link;
  if (link == null) return null;
  if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//') || /[\\\r\n]/.test(link)) throw invalid();
  const url = new URL(product.url);
  url.searchParams.set('url', link);
  const request = validateCapturedRequest({...product, url: url.href});
  if (request.operation !== 'banks' || request.external_id !== product.external_id) throw invalid();
  return request;
}
