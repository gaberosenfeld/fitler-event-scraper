import test from 'node:test';
import assert from 'node:assert/strict';
import { browserEvidence, sanitizeBrowserEvidence, browserEvidenceSummary } from '../src/browser-evidence.js';
import { browserFailure, checkBrowserStartup, createOperationLog } from '../src/diagnostics.js';
import { loadConfig } from '../src/config.js';
const config=loadConfig({SCRAPER_SHARED_SECRET:'test-only-not-a-real-secret-00000000'});
test('sandbox credentials denial is recognized without revealing raw startup log',()=>{
 const raw=new Error('[pid=123][err] [FATAL:sandbox/linux/services/credentials.cc:131] Check failed: . : Permission denied (13)\nexitCode=null, signal=SIGTRAP\nPRIVATE_TOKEN_PATH /private/password');
 const evidence=browserEvidence(raw);
 assert.deepEqual(evidence,{errno:['EACCES'],components:['sandbox_credentials'],signatures:['sandbox_credentials_permission_failure'],signals:['SIGTRAP']});
 assert.equal(browserFailure(raw,'browser_launch').code,'BROWSER_SANDBOX_UNAVAILABLE');
 assert.equal(JSON.stringify(evidence).includes('PRIVATE_TOKEN'),false);assert.equal(JSON.stringify(evidence).includes('131'),false);
});
test('spawn executable denial stays distinct from sandbox denial',()=>{
 const raw=Object.assign(new Error('spawn /private/bin/chrome EACCES'),{code:'EACCES',syscall:'spawn /private/bin/chrome'});
 const e=browserEvidence(raw);assert.deepEqual(e.components,['executable_spawn']);assert.deepEqual(e.signatures,['executable_spawn_permission_denied']);
 assert.equal(browserFailure(raw,'browser_launch').code,'BROWSER_HOST_RESTRICTION');
});
test('generic denied operation does not invent a namespace or seccomp root cause',()=>{
 const e=browserEvidence(new Error('Operation not permitted (1)'));
 assert.deepEqual(e.errno,['EPERM']);assert.deepEqual(e.components,[]);assert.deepEqual(e.signatures,['unspecified_permission_denied']);
});
test('nested cause/stderr retains safe markers that top-level message omits',()=>{
 const raw=new Error('Browser failed',{cause:{stderr:'[FATAL:sandbox/linux/services/credentials.cc:131] Permission denied (13) SECRET_TOKEN',message:'private cause'}});
 const e=browserEvidence(raw);assert.deepEqual(e.signatures,['sandbox_credentials_permission_failure']);assert.equal(browserFailure(raw).code,'BROWSER_SANDBOX_UNAVAILABLE');
 assert.equal(browserEvidenceSummary(e).includes('SECRET_TOKEN'),false);
});
test('socket singleton failure and dependencies have specific non-sandbox signatures',()=>{
 const e=browserEvidence(new Error('FATAL:chrome/browser/process_singleton_posix.cc:297 socket() failed: Operation not permitted (1)'));
 assert.deepEqual(e.signatures,['singleton_socket_permission_denied']);assert.equal(browserFailure(new Error('process_singleton_posix.cc:297 socket() failed: Operation not permitted')).code,'BROWSER_HOST_RESTRICTION');
 const missing=browserEvidence(new Error('error while loading shared libraries: libx.so: cannot open shared object file'));
 assert.deepEqual(missing.signatures,['shared_library_missing']);
});
test('unknown values/paths/secrets cannot cross evidence or summary allowlist',()=>{
 const e=sanitizeBrowserEvidence({errno:['EACCES','TOKEN'],components:['/private/SECRET','sandbox_credentials'],signatures:['PRIVATE_PASSWORD'],signals:['SIGTRAP','SECRET'],extra:'SECRET'});
 assert.deepEqual(e,{errno:['EACCES'],components:['sandbox_credentials'],signatures:[],signals:['SIGTRAP']});assert.equal(browserEvidenceSummary(e).includes('SECRET'),false);
});
test('no-login failure includes fixed evidence summary; safe log has readable message',async()=>{
 let got;
 try {await checkBrowserStartup({config,browserType:{launch:async()=>{throw new Error('sandbox/linux/services/credentials.cc:131 Permission denied (13) PRIVATE_SECRET')}}})}catch(error){got=error}
 assert.equal(got.code,'BROWSER_SANDBOX_UNAVAILABLE');assert.ok(got.message.includes('sandbox_credentials_permission_failure'));assert.equal(got.message.includes('PRIVATE_SECRET'),false);
 const logs=[];const operation=createOperationLog('browser_diagnostic',value=>logs.push(JSON.parse(value)),()=>10);operation.finish(got.code,got.phase,got.evidence);
 assert.ok(logs[0].message.includes('errno=EACCES'));assert.equal(JSON.stringify(logs).includes('PRIVATE_SECRET'),false);
});
test('real scrape logging does not expose diagnostic evidence even when supplied',()=>{
 const logs=[];const operation=createOperationLog('scrape',value=>logs.push(JSON.parse(value)),()=>10);operation.finish('BROWSER_HOST_RESTRICTION','browser_launch',{errno:['EPERM']});
 assert.equal(Object.hasOwn(logs[0],'evidence'),false);assert.equal(Object.hasOwn(logs[0],'message'),false);
});
test('cyclic or oversized nested errors terminate and still emit only enums',()=>{
 const error={message:'x'.repeat(100000)+'PRIVATE_SECRET'};error.cause=error;
 assert.deepEqual(browserEvidence(error),{errno:[],components:[],signatures:[],signals:[]});
});
