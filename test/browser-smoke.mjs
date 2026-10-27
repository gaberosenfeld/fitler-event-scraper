// Optional real-browser offline fixture. Never contacts the live member portal.
// BROWSER_EXECUTABLE may point to a local browser; omitted uses pinned Playwright.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.js';
import { scrapeEvents } from '../src/scraper.js';
const config = loadConfig({ SCRAPER_SHARED_SECRET: 'test-only-not-a-real-secret-00000000', CHROMIUM_SANDBOX: process.env.SMOKE_SANDBOX || 'true' });
let requests = 0;
const browserType = {
  async launch(options) {
    const browser = await chromium.launch({ ...options, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options);
      const route = context.route.bind(context);
      context.route = async () => route('**/*', async request => {
        const url = new URL(request.request().url());
        assert.equal(url.origin, 'https://member.fitlerclub.com');
        requests++;
        if (url.pathname === '/login') return request.fulfill({ contentType:'text/html', body:`<form onsubmit="event.preventDefault();location.href='/home'"><input id="login_username" type="email"><button type="button" onclick="document.querySelector('form').innerHTML='<input id=login_password type=password><button type=submit>Log in</button>'">Next</button></form>` });
        if (url.pathname === '/home') return request.fulfill({ contentType:'text/html', body:'Signed in (offline fixture)' });
        if (url.pathname === '/events') return request.fulfill({ contentType:'text/html', body:`<div id="cards" style="height:1500px"></div><script>fetch('/api/events?group=events&pageSize=1&pageNumber=1');let loaded=false;onscroll=()=>{if(!loaded){loaded=true;fetch('/api/events?group=events&pageSize=1&pageNumber=2').then(()=>document.getElementById('cards').style.height='2200px')}}</script>` });
        if (url.pathname === '/api/events') {
          const page=Number(url.searchParams.get('pageNumber'));
          return request.fulfill({ contentType:'application/json', headers:{Pagination:JSON.stringify({pageNumber:page,totalPages:2,totalCount:2,hasNextPage:page===1})},body:JSON.stringify([{id:page,title:`Offline event ${page}`,start_date_local:{date:'2026-10-27 18:00:00'}}]) });
        }
        return request.abort();
      });
      return context;
    };
    return browser;
  }
};
const result=await scrapeEvents({email:'mock@example.invalid',password:'TEST_ONLY',max:500,config,browserType});
assert.equal(result.complete,true);assert.equal(result.events.length,2);assert.equal(result.meta.apiResponses,2);
console.log(`Offline real-browser smoke passed: ${requests} fixture requests, 2 complete events; no live login.`);
