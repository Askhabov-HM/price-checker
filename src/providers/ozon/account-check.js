import {contextMatches} from './account-context.js';
import {latestFavorites} from './parser.js';

// Transport success is separate from confirmation of account, delivery and list completeness.
export function verifyAccountResponse(result, reference) {
  const summary = {...result.summary};
  if (!result.data) return {summary, verification: null, favorites: null, success: false};
  const verification = contextMatches(result.data, reference, {requireLoginFlag: true});
  summary.signals = {...summary.signals, ...verification};
  if (!verification.account_verified) summary.outcome = 'account_mismatch';
  else if (!verification.delivery_verified) summary.outcome = 'delivery_mismatch';
  else {
    try {
      const parsed = latestFavorites([result.data], 30);
      summary.signals.favorites_complete = parsed.complete;
      if (!parsed.complete) summary.outcome = 'incomplete_data';
      return {summary, verification, favorites: {count: parsed.items.length, complete: parsed.complete}, success: parsed.complete};
    } catch {summary.outcome = 'incomplete_data';}
  }
  return {summary, verification, favorites: null, success: false};
}
