import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgent} from '../apps/lamoda-windows/agent.js';

test('Windows agent opens the wishlist once and exits',async () => {
  let calls = 0;
  const result = await runAgent({launch:async () => {calls++;return {pid:1234};}});
  assert.deepEqual(result,{pid:1234});
  assert.equal(calls,1);
});
