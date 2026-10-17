import test from 'node:test';
import assert from 'node:assert/strict';
import {accountContext, contextMatches, bankConditionsRequest} from '../src/providers/ozon/account-context.js';
import {verifyAccountResponse} from '../src/providers/ozon/account-check.js';

const page = () => ({userInfo: {user: {userId: 123, isLoggedIn: true}}, location: {current: {
  areaId: 456, uid: 'test-area', city: 'Test city', countryCode: 'RU', fias: 'test-fias'}}, widgetStates: {
  'addressBookBarWeb-1-default-1': JSON.stringify({customCell: {cells: [{button: {text: 'Test city'}}, {text: {text: 'Private test address'}}]}}),
  'searchResultsSort-2-default-1': JSON.stringify({sortButton: {options: [{isSelected: true, action: {link: '/my/favorites?sorting=last_added'}}]}}),
  'tileGridDesktop-3-default-1': JSON.stringify({items: []}),
}, nextPage: ''});
const readResult = data => ({summary: {outcome: 'json_received', http_status: 200}, data});

test('an authenticated account and selected delivery context match across unrelated metadata changes', () => {
  const data = page(), reference = accountContext(data, {requireLoginFlag: true});
  data.userInfo.user.firstName = 'Private name'; data.location.current.geoCoordinate = {latitude: 10, longitude: 20};
  assert.deepEqual(contextMatches(data, reference, {requireLoginFlag: true}), {account_verified: true, delivery_verified: true});
  assert.doesNotMatch(JSON.stringify(reference), /Private|Test city|test-area/);
  delete data.userInfo.user.isLoggedIn;
  assert.equal(contextMatches(data, reference).account_verified, true);
  assert.equal(contextMatches(data, reference, {requireLoginFlag: true}).account_verified, false);
});

test('a different account or delivery selection cannot be declared a successful HTTP 200 connection', () => {
  const reference = accountContext(page());
  const account = page(); account.userInfo.user.userId = 789;
  assert.equal(verifyAccountResponse(readResult(account), reference).summary.outcome, 'account_mismatch');
  const location = page(); location.location.current.areaId = 999;
  const changed = verifyAccountResponse(readResult(location), reference);
  assert.equal(changed.summary.outcome, 'delivery_mismatch'); assert.equal(changed.success, false);
  const address = page(); address.widgetStates['addressBookBarWeb-1-default-1'] = JSON.stringify({customCell: {cells: [{text: {text: 'Other address'}}]}});
  assert.equal(verifyAccountResponse(readResult(address), reference).summary.outcome, 'delivery_mismatch');
  const loggedOut = page(); loggedOut.userInfo.user.isLoggedIn = false;
  assert.equal(verifyAccountResponse(readResult(loggedOut), reference).success, false);
});

test('complete, partial and malformed lists are distinguished without exposing account or favorite contents', () => {
  const reference = accountContext(page());
  const result = verifyAccountResponse(readResult(page()), reference);
  assert.equal(result.success, true); assert.deepEqual(result.favorites, {count: 0, complete: true});
  const partial = page(); delete partial.nextPage;
  assert.equal(verifyAccountResponse(readResult(partial), reference).summary.outcome, 'incomplete_data');
  const malformed = page(); delete malformed.widgetStates['tileGridDesktop-3-default-1'];
  assert.equal(verifyAccountResponse(readResult(malformed), reference).success, false);
  assert.doesNotMatch(JSON.stringify(result), /Private|Test city|account_id|delivery_digest|widgetStates/);
  assert.equal(verifyAccountResponse({summary: {outcome: 'access_limited'}}, reference).success, false);
});

test('bank information is read only from the same product widget link and cannot change SKU or invoke an action', () => {
  const request = {method: 'GET', url: 'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fproduct%2F123%2F', headers: {cookie: 'session=fake'}};
  const data = link => ({widgetStates: {'webPrice-1-default-1': JSON.stringify({link})}});
  const accepted = bankConditionsRequest(data('/modal/pdpListOfBanks?product_id=123'), request);
  assert.equal(accepted.operation, 'banks'); assert.equal(accepted.external_id, '123');
  assert.equal(bankConditionsRequest(data(null), request), null);
  for (const link of ['/modal/pdpListOfBanks?product_id=456', '/modal/pdpListOfBanks?product_id=123&apply=true',
    '//evil.test/modal/pdpListOfBanks?product_id=123', '/api/action/subscribe']) {
    assert.throws(() => bankConditionsRequest(data(link), request));
  }
});
