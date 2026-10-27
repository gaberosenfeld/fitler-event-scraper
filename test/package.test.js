import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('container and lock use identical patched pinned Playwright version',()=>{
 const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json'));
 assert.equal(pkg.dependencies.playwright,'1.64.1');
 assert.equal(lock.packages['node_modules/playwright'].version,pkg.dependencies.playwright);
 assert.equal(lock.packages['node_modules/playwright-core'].version,pkg.dependencies.playwright);
 assert.ok(read('Dockerfile').includes(`mcr.microsoft.com/playwright:v${pkg.dependencies.playwright}-noble`));
 assert.ok(read('Dockerfile').includes('USER pwuser'));assert.ok(read('Dockerfile').includes('--ignore-scripts'));
});
test('deploy config and secret exclusions are present; credential placeholders blank',()=>{
 assert.equal(JSON.parse(read('railway.json')).deploy.healthcheckPath,'/health');
 for(const file of ['.gitignore','.dockerignore'])assert.ok(read(file).split('\n').includes('.env'));
 for(const key of ['SCRAPER_SHARED_SECRET','FITLER_EMAIL','FITLER_PASSWORD'])assert.match(read('.env.example'),new RegExp(`^${key}=$`,'m'));
});
