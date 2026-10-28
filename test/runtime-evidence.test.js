import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeErrorEvidence, sanitizeRuntimeError, scriptCategory } from '../src/runtime-evidence.js';
test('recognizes Stripe bootstrap failure using fixed category and known public source only', () => {
  const error = new Error('Failed to load Stripe.js SECRET_PASSWORD');
  error.stack = 'Error: SECRET_PASSWORD\n at x (https://member.fitlerclub.com/assets/index-BWla6c-w.js:1:1548)';
  assert.deepEqual(runtimeErrorEvidence(error), { name:'Error',signature:'stripe_load_failed',source:'stripe_loader',line:1,column:1548 });
});
test('runtime evidence cannot leak arbitrary exception names/messages/stacks/query data', () => {
  const result = runtimeErrorEvidence({ name:'SECRET_NAME',message:'Cannot read properties of undefined (reading SECRET_PASSWORD)',stack:'at x (https://member.fitlerclub.com/assets/index-CxrdghEy.js?private=SECRET:4:920)' });
  assert.equal(result.signature,'undefined_property');assert.equal(result.source,'app_bundle');assert.equal(JSON.stringify(result).includes('SECRET'),false);
  assert.deepEqual(sanitizeRuntimeError({name:'SECRET',signature:'SECRET',source:'SECRET',line:Infinity,column:-1}),{name:'Error',signature:'other',source:'unknown',line:0,column:0});
});
test('script categories are fixed and unknown external hosts do not become allowed', () => {
  assert.equal(scriptCategory('https://js.stripe.com/dahlia/stripe.js'),'stripe');
  assert.equal(scriptCategory('https://analytics.public.peoplevine.dev/script.js'),'analytics');
  assert.equal(scriptCategory('https://unapproved.invalid/SECRET'),'other_external');
});
