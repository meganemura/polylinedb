// Verifies cutover with real local stores and Git metadata. Cloud transport stays inside the fixture.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { initializeStore, openStore } from "../src/local-store/index.ts";
import { executeOperation, parseOperation } from "../src/records/operations.ts";
import { executeMemoryOperation, parseMemoryOperation } from "../src/records/memories.ts";
import { addConnection } from '../src/connections.ts';
import { rawToSnapshot, tables } from '../scripts/d1-additive-merge.ts';
import { canonicalSnapshot } from "../src/records/snapshot.ts";
const executable=fileURLToPath(new URL('../scripts/d1-cutover.ts',import.meta.url));
const checkout=fileURLToPath(new URL('..',import.meta.url));
test('cutover requires a fixed plan and explicit apply flag',()=>{
 const result=spawnSync(process.execPath,[executable],{cwd:checkout,encoding:'utf8'});
 assert.equal(result.status,1);
 assert.match(result.stderr,/Usage: node scripts\/d1-cutover.ts/);
});
const mock=`#!/usr/bin/env node
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {basename,join} from 'node:path';
const args=process.argv.slice(2), kind=basename(process.argv[1]);
const out=x=>process.stdout.write(JSON.stringify(x));
if(kind==='pd'){
 if(args.includes('actor'))out({actor:'test'});
 else process.stdout.write(execFileSync(process.execPath,[process.env.TEST_CLI,...args],{encoding:'utf8',env:process.env}));
}else if(args[0]==='workers'&&args[1]==='deployments')out({deployments:[{versions:[{version_id:process.env.TEST_MODE==='staged'?'active-old':'fixed',percentage:100}]}]});
else if(args[0]==='workers')out({id:'fixed',bindings:[{name:'DB',database_id:'00000000-0000-0000-0000-000000000000'}]});
else {
 const path=args[args.indexOf('--batch')+1].slice(1), statements=JSON.parse(readFileSync(path,'utf8'));
 const db=new DatabaseSync(process.env.TEST_CLOUD);db.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE');
 const results=[];
 try{for(const s of statements){const q=db.prepare(s.sql);results.push({success:true,results:q.all(...s.params)});}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
 if(path.endsWith('/merge-batch.json')&&process.env.TEST_MODE==='lost')process.exit(1);
 if(path.endsWith('/cloud-after-batch.json')&&process.env.TEST_MODE==='cas'){
  const c=JSON.parse(readFileSync(process.env.TEST_CONFIG,'utf8'));c.project='changed';writeFileSync(process.env.TEST_CONFIG,JSON.stringify(c));
 }
 if(path.endsWith('/cloud-after-batch.json')&&process.env.TEST_MODE==='stale')writeFileSync(process.env.TEST_CONFIG+'.migration.tmp','foreign recovery artifact');
 out(results);
}
`;
test('cutover routes named local stores and linked worktrees, retires uncertain writes, and preserves concurrent defaults',async context=>{
const base=realpathSync(mkdtempSync(join(tmpdir(),'pd-cutover-test-')));
context.after(()=>rmSync(base,{recursive:true,force:true}));
const outcomes=[];
for(const mode of ['success','lost','cas','staged','stale']){
 const root=join(base,mode);mkdirSync(root,{mode:0o700});
 const bin=join(root,'bin');mkdirSync(bin,{mode:0o700});
 for(const command of ['cf','pd']){writeFileSync(join(bin,command),mock);chmodSync(join(bin,command),0o700);}
 const source=join(root,'source');mkdirSync(source,{mode:0o700});
 const location={directory:source,cwd:checkout};const {database_path:sourcePath}=initializeStore(location);
 const store=openStore(location);
 await executeOperation(store.db,parseOperation({op:'create',prefix:'test',request_id:randomUUID(),tool:'review',project:'test',body:'Synthetic source'}),'original');
 await executeOperation(store.db,parseOperation({op:'comment',id:'test-1',body:'Synthetic comment'}),'original');
 await executeMemoryOperation(store.db,parseMemoryOperation({op:'memory_create',prefix:'test',request_id:randomUUID(),project:'test',title:'Synthetic memory',body:'Preserve memory attribution'}),'original');store.close();
 const db=new DatabaseSync(sourcePath);
 const before=Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t).all()]));db.close();
 const cloudLocation={directory:join(root,'cloud'),cwd:checkout};
 const {database_path:cloudPath}=initializeStore(cloudLocation);const cloudStore=openStore(cloudLocation);
 await executeOperation(cloudStore.db,parseOperation({op:'create',prefix:'cloud',request_id:randomUUID(),tool:'review',project:'test',body:'Existing cloud record'}),'cloud-author');cloudStore.close();
 const cloud=new DatabaseSync(cloudPath);const baseline=Object.fromEntries(tables.map(t=>[t,cloud.prepare('SELECT * FROM '+t).all()]));cloud.close();
 const expected=Object.fromEntries(tables.map(t=>[t,[...before[t],...baseline[t]]]));
 const configHome=join(root,'xdg');mkdirSync(configHome,{mode:0o700});
 addConnection('named-local',{kind:'local',data_dir:source},{...process.env,XDG_CONFIG_HOME:configHome});
 addConnection('cloud',{kind:'cloud',url:'https://test.invalid'},{...process.env,XDG_CONFIG_HOME:configHome});
 const repository=join(root,'repo');mkdirSync(repository);
 const git=(args:string[])=>execFileSync('git',['-C',repository,...args],{encoding:'utf8'});
 git(['init','-q']);git(['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','Fixture']);
 const linked=join(root,'linked');git(['worktree','add','-q','-b','linked',linked]);
 const alias=join(root,'repo-alias');symlinkSync(repository,alias,'dir');
 const configPath=join(repository,'.git','polylinedb.json');
 const config={version:3,connection:'named-local',tool:'review',project:'test',prefix:'test',actor:'original'};
 writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
 const receipts=join(root,'receipts'),planPath=join(root,'plan.json');
 writeFileSync(planPath,JSON.stringify({profile:'test',accountId:'0'.repeat(32),databaseId:'00000000-0000-0000-0000-000000000000',workerId:'test',url:'https://test.invalid',connection:'cloud',sourceDirectory:source,receiptsDirectory:receipts,repositories:[alias,repository]}),{mode:0o600});
 const result=spawnSync(process.execPath,[executable,'--plan',planPath,'--apply'],{cwd:checkout,env:{...process.env,PATH:bin+':'+process.env.PATH,XDG_CONFIG_HOME:configHome,TEST_CLI:join(checkout,'src','cli.ts'),TEST_CLOUD:cloudPath,TEST_CONFIG:configPath,TEST_MODE:mode},encoding:'utf8',maxBuffer:1024*1024});
 assert.equal(result.status,mode==='success'?0:1,result.stderr);
 if(mode==='staged'){
  assert.match(result.stderr,/Latest Worker version is not the active deployment/);
  const unchanged=new DatabaseSync(sourcePath);
  assert.equal(unchanged.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'polylinedb_retired_%'").get()?.n,0);
  const unchangedRows=Object.fromEntries(tables.map(t=>[t,unchanged.prepare('SELECT * FROM '+t).all()]));unchanged.close();
  assert.equal(canonicalSnapshot(rawToSnapshot(unchangedRows)),canonicalSnapshot(rawToSnapshot(before)));
  assert.deepEqual(JSON.parse(readFileSync(configPath,'utf8')),config);
  const untouchedCloud=new DatabaseSync(cloudPath);
  const unchangedCloud=Object.fromEntries(tables.map(t=>[t,untouchedCloud.prepare('SELECT * FROM '+t).all()]));untouchedCloud.close();
  assert.equal(canonicalSnapshot(rawToSnapshot(unchangedCloud)),canonicalSnapshot(rawToSnapshot(baseline)));
  outcomes.push({mode,result:'VERIFIED'});continue;
 }
 const retired=new DatabaseSync(sourcePath);assert.equal(retired.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'polylinedb_retired_%'").get()?.n,27);assert.throws(()=>retired.exec('UPDATE counters SET last_number=last_number'),/retired/);retired.close();
 const remote=new DatabaseSync(cloudPath);const after=Object.fromEntries(tables.map(t=>[t,remote.prepare('SELECT * FROM '+t).all()]));remote.close();
 assert.equal(canonicalSnapshot(rawToSnapshot(after)),canonicalSnapshot(rawToSnapshot(expected)));
 const actual=JSON.parse(readFileSync(configPath,'utf8'));
 if(mode==='success'){
  assert.deepEqual(actual,{...config,connection:'cloud'});
  const complete=JSON.parse(readFileSync(join(receipts,'complete.json'),'utf8'));assert.equal(complete.checkouts,2);assert.equal(complete.configurations,1);
 }else if(mode==='cas'){assert.equal(actual.project,'changed');assert.equal(actual.connection,'named-local');}
 else if(mode==='stale'){assert.deepEqual(actual,config);assert.equal(readFileSync(configPath+'.migration.tmp','utf8'),'foreign recovery artifact');}
 else{assert.deepEqual(actual,config);assert.deepEqual(JSON.parse(readFileSync(join(receipts,'failure-state.json'),'utf8')),{cloudAttempted:true,sourceRetired:true});}
 outcomes.push({mode,result:'VERIFIED'});
}
assert.deepEqual(outcomes.map(o=>o.mode),['success','lost','cas','staged','stale']);
});
