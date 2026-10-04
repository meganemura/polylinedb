// Coordinates one operator cutover; fixed private files retain the recovery state.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { additiveMerge, rawToSnapshot, retireSource, tables } from './d1-additive-merge.ts';
import { canonicalSnapshot } from '../src/snapshot.ts';
import { SCHEMA_SQL, SCHEMA_VERSION } from '../src/schema.ts';
import { validateExternalDirectory } from '../src/local-config.ts';

assert.equal(process.argv[2],'--plan','Usage: node scripts/d1-cutover.ts --plan PRIVATE_JSON --apply');
assert.equal(process.argv[4],'--apply');
assert.equal(process.argv.length,5);
const planPath=process.argv[3];
assert(planPath&&isAbsolute(planPath),'The plan path must be absolute');
const planStat=lstatSync(planPath);
assert(planStat.isFile()&&!planStat.isSymbolicLink()&&(planStat.mode&0o777)===0o600&&(!process.getuid||planStat.uid===process.getuid()),'The plan must be a private regular file');
const target=JSON.parse(readFileSync(planPath,'utf8'));
const names=['profile','accountId','databaseId','workerId','url','connection','sourceDirectory','receiptsDirectory','repositories'];
assert.deepEqual(Object.keys(target).sort(),names.sort(),'Unexpected plan fields');
assert(typeof target.profile==='string'&&/^[a-zA-Z0-9_-]+$/.test(target.profile));
assert(typeof target.accountId==='string'&&/^[a-f0-9]{32}$/.test(target.accountId));
assert(typeof target.databaseId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(target.databaseId));
assert(typeof target.workerId==='string'&&/^[a-z0-9][a-z0-9_-]{0,62}$/.test(target.workerId));
assert(typeof target.connection==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(target.connection));
assert(typeof target.url==='string'&&new URL(target.url).origin===target.url&&new URL(target.url).protocol==='https:');
assert(typeof target.sourceDirectory==='string'&&isAbsolute(target.sourceDirectory));
assert(typeof target.receiptsDirectory==='string'&&isAbsolute(target.receiptsDirectory));
assert(Array.isArray(target.repositories)&&target.repositories.length>0&&target.repositories.every((root:unknown)=>typeof root==='string'&&isAbsolute(root)));
const base=validateExternalDirectory(target.receiptsDirectory);
const connection=target.connection;
const sourceDirectory=validateExternalDirectory(realpathSync(target.sourceDirectory));
const pd='pd';
mkdirSync(base,{recursive:true,mode:0o700});
const receiptStat=lstatSync(base);
assert(receiptStat.isDirectory()&&!receiptStat.isSymbolicLink()&&(receiptStat.mode&0o777)===0o700&&readdirSync(base).length===0,'Use an empty private receipt directory');
const env:NodeJS.ProcessEnv={...process.env,CLOUDFLARE_ACCOUNT_ID:target.accountId,CI:'1',NO_COLOR:'1',CF_TELEMETRY_DISABLED:'1'};
for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL','CF_API_TOKEN','CF_API_KEY','CF_EMAIL','POLYLINEDB_CONNECTION','POLYLINEDB_DATA_DIR','POLYLINEDB_ACTOR']) delete env[key];
const save=(name:string,value:unknown)=>writeFileSync(join(base,name),JSON.stringify(value),{mode:0o600,flag:'wx'});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function cf(args:string[]) {
  const result=spawnSync('cf',[...args,'--profile',target.profile],{cwd:base,env,encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024});
  if(result.status!==0 || result.error) {
    writeFileSync(join(base,`cf-failure-${Date.now()}.txt`),result.stderr,{mode:0o600,flag:'wx'});
    throw new Error('cf failed; inspect the private diagnostic');
  }
  return JSON.parse(result.stdout);
}
function batch(statements:readonly {sql:string;params:readonly unknown[]}[],label:string) {
  const file=join(base,label+'-batch.json');
  writeFileSync(file,JSON.stringify(statements),{mode:0o600,flag:'wx'});
  const raw=cf(['d1','query',target.databaseId,'--batch','@'+file]);
  save(label+'-response.json',raw);
  const results=Array.isArray(raw)?raw:raw.result;
  assert(Array.isArray(results)&&results.length===statements.length,'Unexpected D1 batch result');
  for(const result of results) assert(result.success===true&&Array.isArray(result.results),'D1 statement failed');
  return results;
}
const schemaSql="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_METADATA','_cf_KV') ORDER BY name";
function remoteRows(label:string) {
  const results=batch([{sql:schemaSql,params:[]},{sql:'SELECT version FROM schema_version',params:[]},...tables.map(table=>({sql:`SELECT * FROM ${table}`,params:[]}))],label);
  const ref=new DatabaseSync(':memory:');
  try{ref.exec(SCHEMA_SQL);assert.deepEqual(results[0].results,ref.prepare(schemaSql).all().map(r=>({...r})));}finally{ref.close();}
  assert.deepEqual(results[1].results,[{version:SCHEMA_VERSION}]);
  return Object.fromEntries(tables.map((table,index)=>[table,results[index+2].results]));
}
function pdRun(args:string[],cwd=base) {
  return JSON.parse(execFileSync(pd,args,{cwd,env,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024}));
}
function sourceRows(db:DatabaseSync) {return Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all().map(r=>({...r}))]));}
function deployedWorker() {
  const worker=cf(['workers','versions','get','latest','--worker-id',target.workerId]);
  const active=cf(['workers','deployments','list','--worker',target.workerId]).deployments?.[0];
  assert(active&&Array.isArray(active.versions)&&active.versions.length===1,'Use one active Worker version');
  assert.equal(active.versions[0].percentage,100,'Use one active Worker version');
  assert.equal(active.versions[0].version_id,worker.id,'Latest Worker version is not the active deployment');
  return worker;
}
function switchDefault(item:{file:string;config:Record<string,unknown>},backup:string) {
  const lock=item.file+'.lock';
  const descriptor=openSync(lock,'wx',0o600);
  const temporary=item.file+'.migration.tmp';
  let ownTemporary=false;
  try{
    assert.equal(readFileSync(item.file,'utf8'),readFileSync(backup,'utf8'),'Repository defaults changed before cutover');
    const next={version:3,connection,tool:item.config.tool,project:item.config.project,prefix:item.config.prefix,actor:item.config.actor};
    const writer=openSync(temporary,'wx',0o600);
    ownTemporary=true;
    try{writeFileSync(writer,JSON.stringify(next,null,2)+'\n');fsyncSync(writer);}finally{closeSync(writer);}
    renameSync(temporary,item.file);
  }finally{closeSync(descriptor);unlinkSync(lock);if(ownTemporary&&existsSync(temporary))unlinkSync(temporary);}
}
function inventoryRepositories() {
  const roots=new Set<string>(target.repositories.map((root:string)=>realpathSync(root)));
  for(const root of [...roots]) {
    const listed=execFileSync('git',['-C',root,'worktree','list','--porcelain'],{encoding:'utf8'});
    for(const line of listed.split('\n'))if(line.startsWith('worktree '))roots.add(realpathSync(line.slice(9)));
  }
  const inventory=[];
  for(const root of roots) {
    const context=pdRun(['context'],root);
    if(context.mode!=='local'||realpathSync(context.data_dir)!==sourceDirectory)continue;
    const common=execFileSync('git',['-C',root,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim();
    const file=join(common,'polylinedb.json');
    assert(existsSync(file),'Initialize repository defaults before cutover');
    const config=JSON.parse(readFileSync(file,'utf8'));
    inventory.push({root,file,config});
  }
  assert(inventory.length>0,'No supplied repository selects the source store');
  return inventory;
}

let source:DatabaseSync|undefined;
let sourceLocked=false;
let cloudAttempted=false;
try {
  assert(!existsSync(join(base,'source-final.json')),'Previous run exists; inspect receipts before recovery');
  chmodSync(base,0o700);
  const worker=deployedWorker();
  save('worker-before.json',worker);
  assert.equal(worker.bindings.find((b:{name:string})=>b.name==='DB').database_id,target.databaseId);
  const selected=pdRun(['--connection',connection,'context']);
  assert.equal(selected.mode,'cloud');assert.equal(selected.url,target.url);
  const actor=pdRun(['--connection',connection,'actor']);
  save('actor.json',actor);
  const inventory=inventoryRepositories();save('inventory.json',inventory);
  const configs=[...new Map(inventory.map(item=>[item.file,item])).values()];
  mkdirSync(join(base,'config-backups'),{mode:0o700});
  for(const [index,item] of configs.entries()) {
    const bytes=readFileSync(item.file,'utf8');
    assert.deepEqual(JSON.parse(bytes),item.config,'Repository defaults changed');
    writeFileSync(join(base,'config-backups',index+'.json'),bytes,{mode:0o600,flag:'wx'});
  }
  source=new DatabaseSync(join(sourceDirectory,'polylinedb.sqlite'));
  source.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');sourceLocked=true;
  const reference=new DatabaseSync(':memory:');
  try{reference.exec(SCHEMA_SQL);assert.deepEqual(source.prepare(schemaSql).all(),reference.prepare(schemaSql).all(),'Source schema differs');}finally{reference.close();}
  const local=sourceRows(source);
  const sourceSnapshot=rawToSnapshot(local);
  save('source-final-rows.json',local);save('source-final.json',sourceSnapshot);
  const cloud=remoteRows('cloud-final');
  save('cloud-final-rows.json',cloud);save('cloud-final.json',rawToSnapshot(cloud));
  const plan=additiveMerge({source:local,destination:cloud});
  save('expected.json',plan.expectedSnapshot);
  save('manifest.json',{source:hash(canonicalSnapshot(sourceSnapshot)),cloud:hash(canonicalSnapshot(rawToSnapshot(cloud))),expected:plan.digest,counts:plan.counts,statements:plan.statements.length,configurations:configs.length,checkouts:inventory.length});
  retireSource(source,connection);
  save('state-prepared.json',{sourceLocked:true,sourceRetirementPending:true,cloudAttempted:false});
  const currentWorker=deployedWorker();
  assert.equal(currentWorker.id,worker.id,'Worker changed before transfer');
  assert.deepEqual(currentWorker.bindings,worker.bindings,'Worker bindings changed before transfer');
  cloudAttempted=true;
  batch(plan.statements,'merge');
  const after=remoteRows('cloud-after');
  assert.equal(canonicalSnapshot(rawToSnapshot(after)),canonicalSnapshot(plan.expectedSnapshot),'Full cloud snapshot differs');
  save('verification.json',{result:'VERIFIED',digest:hash(canonicalSnapshot(rawToSnapshot(after))),counts:plan.counts});
  source.exec('COMMIT');sourceLocked=false;
  save('source-retired.json',{result:'RETIRED',connection,triggers:tables.length*3});
  const changed=[];
  for(const [index,item] of configs.entries()) {
    assert.equal(readFileSync(item.file,'utf8'),readFileSync(join(base,'config-backups',index+'.json'),'utf8'),'Repository defaults changed before cutover');
    switchDefault(item,join(base,'config-backups',index+'.json'));
    const context=pdRun(['context'],item.root);
    assert.equal(context.mode,'cloud');assert.equal(context.connection,connection);
    for(const key of ['tool','project','prefix']) assert.equal(context[key],item.config[key]);
    const updated=JSON.parse(readFileSync(item.file,'utf8'));
    assert.equal(updated.actor,item.config.actor);
    changed.push({file:item.file,root:item.root,project:context.project});
    save(`route-${index}.json`,{result:'VERIFIED',...changed.at(-1)});
  }
  pdRun(['connection','default',connection]);
  const contexts=[];
  for(const item of inventory) {
    const context=pdRun(['context'],item.root);
    assert.equal(context.mode,'cloud');assert.equal(context.connection,connection);
    for(const key of ['tool','project','prefix']) assert.equal(context[key],item.config[key]);
    contexts.push({root:item.root,project:context.project,prefix:context.prefix,result:'VERIFIED'});
  }
  save('routing-verification.json',{result:'VERIFIED',configurations:changed.length,checkouts:contexts});
  save('complete.json',{result:'VERIFIED',sourceRetired:true,connection,configurations:changed.length,checkouts:contexts.length,digest:plan.digest});
  process.stdout.write(JSON.stringify({result:'VERIFIED',connection,configurations:changed.length,checkouts:contexts.length,counts:plan.counts})+'\n');
}catch(error){
  if(sourceLocked&&source) {
    source.exec(cloudAttempted?'COMMIT':'ROLLBACK');sourceLocked=false;
    save('failure-state.json',{cloudAttempted,sourceRetired:cloudAttempted});
  }
  process.stderr.write('Cutover stopped. Read private receipts before recovery. '+(error instanceof Error?error.message:'Unknown error')+'\n');
  process.exitCode=1;
}finally{source?.close();}
