import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Authentication, AuthConfigurationError, createCredentials, loadAuthentication} from '../src/auth.js';
import {temporary} from './helpers.js';

test('credentials store a salted hash and missing or broken configuration never disables protection', async t => {
  const root = temporary(t), secret = 'test-setup-password';
  const first = await createCredentials('test-admin', secret), second = await createCredentials('test-admin', secret);
  assert.ok(!JSON.stringify(first).includes(secret));
  assert.notEqual(first.salt, second.salt); assert.notEqual(first.hash, second.hash);
  assert.throws(() => loadAuthentication(root), AuthConfigurationError);
  mkdirSync(join(root, '.secrets'));
  const path = join(root, '.secrets/price-checker-auth.json');
  writeFileSync(path, JSON.stringify(first));
  assert.ok(loadAuthentication(root) instanceof Authentication);
  writeFileSync(path, '{broken');
  assert.throws(() => loadAuthentication(root), AuthConfigurationError);
  await assert.rejects(createCredentials('invalid user', secret), AuthConfigurationError);
});
