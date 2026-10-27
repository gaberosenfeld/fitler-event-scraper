import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogCollector, isEventsApi } from '../src/catalog.js';
const url = 'https://member.fitlerclub.com/api/events?group=events&pageSize=2';
const e = id => ({ id, title: `Event ${id}` });
test('only exact approved origin/path/group is captured', () => {
  assert.equal(isEventsApi(url), true);
  for (const value of ['https://evil.example/api/events?group=events', 'https://member.fitlerclub.com.evil.example/api/events?group=events', 'https://member.fitlerclub.com/api/events/1?group=events', 'https://member.fitlerclub.com/api/events?group=fitness']) assert.equal(isEventsApi(value), false);
});
test('complete pagination header preserves all pages and deduplicates IDs', () => {
  const c = new CatalogCollector();
  c.accept([e(1),e(2)], url, 100, { pageNumber:1,totalPages:2,totalCount:3,hasNextPage:true });
  assert.throws(() => c.finish(), { code:'PAGINATION_INCOMPLETE' });
  c.accept([e(2),e(3)], url+'&pageNumber=2', 100, { pageNumber:2,totalPages:2,totalCount:3,hasNextPage:false });
  assert.deepEqual(c.finish().rawEvents.map(x=>x.id), [1,2,3]);
  assert.equal(c.finish().meta.truncated, false);
});
test('snake case header, genuine empty catalog, no-response are distinct', () => {
  const c = new CatalogCollector(); assert.throws(()=>c.finish(), {code:'NO_API_RESPONSES'});
  c.accept([],url,10,{total_count:0,has_next_page:false});
  assert.equal(c.finish().rawEvents.length,0);
});
test('unknown schemas fail rather than producing empty success', () => {
  const c = new CatalogCollector(); assert.throws(()=>c.accept({error:'oops'},url),{code:'API_SCHEMA_CHANGED'});
});
test('quiet DOM is insufficient without API pagination evidence', () => {
  const c = new CatalogCollector(); c.accept([e(1)],url.replace('&pageSize=2',''));
  assert.throws(()=>c.finish(),{code:'PAGINATION_INCOMPLETE'});
});
test('event cap is enforced during collection, with no truncated success', () => {
  const c = new CatalogCollector({maxEvents:2});
  assert.throws(()=>c.accept([e(1),e(2),e(3)],url),{code:'EVENT_LIMIT'});
  assert.equal(c.events.size,2);
});
test('reported total above cap stops before collection', () => {
  const c = new CatalogCollector({maxEvents:2});
  assert.throws(()=>c.accept([e(1)],url,0,{totalCount:3}),{code:'EVENT_LIMIT'});
  assert.equal(c.events.size,0);
});
test('partial last page, changing total, and total mismatch do not succeed', () => {
  const c = new CatalogCollector(); c.accept([e(1)],url,0,{totalCount:4,hasNextPage:false});
  assert.throws(()=>c.finish(),{code:'PAGINATION_INCOMPLETE'});
  assert.throws(()=>c.accept([e(2)],url,0,{totalCount:5}),{code:'PAGINATION_INCOMPLETE'});
});
test('response and memory caps are bounded', () => {
  const c = new CatalogCollector({maxApiResponses:1,maxCatalogBytes:5});
  assert.throws(()=>c.accept([],url,6),{code:'RESPONSE_TOO_LARGE'});
  const d = new CatalogCollector({maxApiResponses:1});d.accept([],url);
  assert.throws(()=>d.accept([],url),{code:'PAGINATION_INCOMPLETE'});
});
