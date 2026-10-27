import test from 'node:test';
import assert from 'node:assert/strict';
import { mapEvent, parseEventDate, safeUrl } from '../src/events.js';
import { loadConfig } from '../src/config.js';
test('New York local dates are independent of container UTC; summer and winter offsets', () => {
  assert.equal(parseEventDate('2026-07-10 18:30:00.000000').iso,'2026-07-10T22:30:00.000Z');
  assert.equal(parseEventDate('2026-12-10 18:30:00').iso,'2026-12-10T23:30:00.000Z');
  assert.equal(parseEventDate('2026-07-10T22:30:00Z').iso,'2026-07-10T22:30:00.000Z');
});
test('DST gap rejected; fall overlap flagged and earliest occurrence chosen', () => {
  assert.throws(()=>parseEventDate('2026-03-08 02:30:00'),{code:'INVALID_EVENT'});
  assert.deepEqual(parseEventDate('2026-11-01 01:30:00'),{iso:'2026-11-01T05:30:00.000Z',ambiguous:true});
  assert.throws(()=>parseEventDate('2026-02-31 09:00:00'),{code:'INVALID_EVENT'});
});
test('mapping preserves ID, source HTML, short summary, media and categories', () => {
  const source={id:12,title:' Test ',summary:'Short',description:'<p style="color:red">Long <strong>formatted</strong></p>',start_date_local:{date:'2026-07-10 18:30:00'},end_date_local:{date:'2026-07-10 20:00:00'},graphic:'/banner.jpg',categories:[{id:3,title:'Dining'}],venue:'Club'};
  const e=mapEvent(source);
  assert.equal(e.id,12);assert.equal(e.description,'Short');assert.equal(e.longDescriptionHTML,source.description);
  assert.equal(e.url,'https://member.fitlerclub.com/events/12');assert.equal(e.bannerImage,'https://member.fitlerclub.com/banner.jpg');
  assert.equal(e.time,'6:30 PM – 8:00 PM');assert.equal(e.timeZone,'America/New_York');assert.deepEqual(e.categories,source.categories);
  assert.equal(Object.hasOwn(e,'raw'),false);
});
test('unsafe media/links blocked and event path components encoded',()=>{
  assert.equal(safeUrl('javascript:alert(1)'),'');assert.equal(safeUrl('http://insecure.test/a'),'');
  assert.equal(safeUrl('https://u:p@example.org/'),'');
  assert.equal(mapEvent({id:'a/b',title:'T'}).url,'https://member.fitlerclub.com/events/a%2Fb');
});
test('startup requires private secret and limits are validated',()=>{
  assert.throws(()=>loadConfig({}));assert.throws(()=>loadConfig({SCRAPER_SHARED_SECRET:'short'}));
  const c=loadConfig({SCRAPER_SHARED_SECRET:'test-only-not-a-real-secret-00000000'});
  assert.equal(c.port,5174);assert.equal(c.headless,true);assert.equal(c.chromiumSandbox,true);
  assert.throws(()=>loadConfig({SCRAPER_SHARED_SECRET:c.secret,MAX_EVENTS:'100000'}));
});
