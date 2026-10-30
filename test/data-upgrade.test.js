const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawnSync}=require('node:child_process');
const {planDataUpgrade,applyDataUpgrade,DATA_FIELDS_VERSION}=require('../lib/data-upgrade');
const {acquireDataLock}=require('../lib/data-lock');
function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bobo upgrade 测试-'));
  const write=(file,value)=>{const target=path.join(dir,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(value,null,2)+'\n');};
  write('meta.json',{schemaVersion:2,revision:7,updatedAt:'2020-01-01',customMeta:'keep'});
  write('systems.json',{schemaVersion:2,systems:[{id:'s',name:'旧系统',projectIds:['p']}]});
  write('projects/p/project.json',{id:'p',name:'旧项目',customProject:{retain:1},requirements:[{id:'r',title:'旧需求',version:4,stages:[{id:'t',type:'开发',title:'历史开发',start:'2026-01-01',end:'2026-01-03',status:'已完成',owner:'历史姓名',notes:'原始备注'}]}]});
  write('projects/p/issues.json',{projectId:'p',issues:[{id:'i',stageId:'t',title:'历史问题',status:'closed',comments:[{id:'c',body:'原评论'}]}]});
  write('users.json',{users:[{passwordHash:'test-only-preserve-exact-bytes'}]});
  write('attachments/untouched.json',{keep:true});write('logs/untouched.json',{keep:true});
  return {dir,write,read:file=>JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'))};
}
function bytes(dir) {
  const result={};
  function walk(current) {for(const entry of fs.readdirSync(current,{withFileTypes:true})) {const target=path.join(current,entry.name);if(entry.isDirectory())walk(target);else result[path.relative(dir,target)]=fs.readFileSync(target).toString('hex');}}
  walk(dir);return result;
}
test('upgrade check is read-only; apply backs up original bytes, fills fields, preserves values and is idempotent',async()=>{
  const f=fixture();try {
    const before=bytes(f.dir);const plan=planDataUpgrade(f.dir);assert.equal(plan.version,DATA_FIELDS_VERSION);assert.ok(plan.writes.length>=4);assert.deepEqual(bytes(f.dir),before);
    const result=await applyDataUpgrade(f.dir,0);assert.ok(result.backup);
    for(const item of result.writes) if(item.existed)assert.equal(fs.readFileSync(path.join(result.backup,item.file)).toString('hex'),before[item.file]);
    const p=f.read('projects/p/project.json'),r=p.requirements[0],s=r.stages[0],i=f.read('projects/p/issues.json').issues[0];
    assert.deepEqual(p.customProject,{retain:1});assert.equal(r.completed,false);assert.equal(r.version,5);assert.equal(s.recurrence,null);assert.equal(s.notificationText,'');assert.equal(s.status,'已完成');assert.equal(s.owner,'历史姓名');assert.equal(s.notes,'原始备注');
    assert.equal(i.status,'closed');assert.equal(i.closedAt,'');assert.equal(i.legacyClosureUnknown,true);assert.equal(i.comments[0].body,'原评论');assert.equal(i.priority,'medium');
    assert.equal(f.read('meta.json').revision,8);assert.equal(f.read('meta.json').dataFieldsVersion,DATA_FIELDS_VERSION);
    for(const file of ['users.json','attachments/untouched.json','logs/untouched.json'])assert.equal(fs.readFileSync(path.join(f.dir,file)).toString('hex'),before[file]);
    assert.equal(planDataUpgrade(f.dir).writes.length,0);const after=bytes(f.dir);assert.equal((await applyDataUpgrade(f.dir,0)).backup,null);assert.deepEqual(bytes(f.dir),after);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});fs.rmSync(f.dir+'-full-backups',{recursive:true,force:true});}
});
test('legacy JSON is converted then removed only after a full compressed backup',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bobo-upgrade-legacy-'));
  try {
    const legacy={projects:[{id:'p',name:'原项目',requirements:[{id:'r',title:'原需求',stages:[{id:'t',type:'开发',title:'工作',start:'2020-01-01',end:'2020-01-01',issueOpen:true,issues:'原始问题'}]}]}]};
    fs.writeFileSync(path.join(dir,'projects.json'),JSON.stringify(legacy));const original=bytes(dir);
    assert.equal(planDataUpgrade(dir).legacy,true);assert.deepEqual(bytes(dir),original);
    const result=await applyDataUpgrade(dir,0);assert.ok(result.backup);
    assert.equal(fs.existsSync(path.join(dir,'projects.json')),false);assert.equal(fs.existsSync(path.join(dir,'projects.json.migrated')),false);assert.equal(fs.readFileSync(path.join(result.backup,'projects.json')).toString('hex'),original['projects.json']);assert.ok(result.fullBackup.archive.endsWith('.tar.gz'));
    const project=JSON.parse(fs.readFileSync(path.join(dir,'projects/p/project.json')));assert.equal(project.requirements[0].completed,false);assert.equal(project.requirements[0].stages[0].notificationText,'');
    assert.equal(planDataUpgrade(dir).writes.length,0);
    assert.equal(fs.existsSync(path.join(dir,'users.json')),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(dir+'-full-backups',{recursive:true,force:true});}
});
test('future versions, invalid JSON and ambiguous dates fail without changing source',async()=>{
  for(const bad of ['future-schema','future-fields','bad-json','bad-date']) {
    const f=fixture();try {
      if(bad==='future-schema') f.write('meta.json',{schemaVersion:999,revision:1});
      if(bad==='future-fields') f.write('meta.json',{schemaVersion:2,revision:1,dataFieldsVersion:999});
      if(bad==='bad-json') fs.writeFileSync(path.join(f.dir,'systems.json'),'{invalid');
      if(bad==='bad-date') {const p=f.read('projects/p/project.json');p.requirements[0].stages[0].start='2026-02-30';f.write('projects/p/project.json',p);}
      const before=bytes(f.dir);assert.throws(()=>planDataUpgrade(f.dir));assert.deepEqual(bytes(f.dir),before);await assert.rejects(applyDataUpgrade(f.dir,0));assert.deepEqual(bytes(f.dir),before);
    }finally{fs.rmSync(f.dir,{recursive:true,force:true});fs.rmSync(f.dir+'-full-backups',{recursive:true,force:true});}
  }
});
test('active data lock or listening port blocks upgrade before a backup or business write',async()=>{
  const f=fixture();let release;const server=net.createServer();
  try {
    release=acquireDataLock(f.dir);const locked=bytes(f.dir);await assert.rejects(applyDataUpgrade(f.dir,0),/正由进程/);assert.deepEqual(bytes(f.dir),locked);release();release=null;
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const before=bytes(f.dir);await assert.rejects(applyDataUpgrade(f.dir,server.address().port),/端口/);assert.deepEqual(bytes(f.dir),before);
  }finally{if(release)release();await new Promise(resolve=>server.close(resolve));fs.rmSync(f.dir,{recursive:true,force:true});fs.rmSync(f.dir+'-full-backups',{recursive:true,force:true});}
});
test('a failed replacement rolls back already written files and retains the backup',async()=>{
  const f=fixture();const rename=fs.renameSync;let failed=false;
  try {
    const before=bytes(f.dir);
    fs.renameSync=(from,to)=>{if(to===path.join(f.dir,'systems.json')&&!failed){failed=true;throw new Error('simulated disk failure');}return rename(from,to);};
    await assert.rejects(applyDataUpgrade(f.dir,0),/已回滚/);
    for(const [file,hex]of Object.entries(before)) assert.equal(fs.readFileSync(path.join(f.dir,file)).toString('hex'),hex);
    assert.ok(fs.readdirSync(path.join(f.dir,'backups')).length);
    assert.deepEqual(Object.keys(bytes(f.dir)).filter(file=>!file.startsWith('backups'+path.sep)).sort(),Object.keys(before).sort());
  }finally{fs.renameSync=rename;fs.rmSync(f.dir,{recursive:true,force:true});fs.rmSync(f.dir+'-full-backups',{recursive:true,force:true});}
});
test('CLI preview and macOS entry work with spaces in paths and an explicit runtime',()=>{
  const f=fixture();try {
    const root=path.join(__dirname,'..');const before=bytes(f.dir);
    const check=spawnSync(process.execPath,['scripts/upgrade-data.js','--check','--data-dir',f.dir],{cwd:root,encoding:'utf8'});assert.equal(check.status,0,check.stderr);assert.match(check.stdout,/未写入/);assert.deepEqual(bytes(f.dir),before);
    if(process.platform!=='win32') {
      const apply=spawnSync('bash',['upgrade-data.command','--apply','--data-dir',f.dir,'--port','0'],{cwd:root,env:{...process.env,NODE_BINARY:process.execPath},encoding:'utf8'});assert.equal(apply.status,0,apply.stderr);assert.match(apply.stdout,/升级完成/);assert.equal(planDataUpgrade(f.dir).writes.length,0);
    }
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});fs.rmSync(f.dir+'-full-backups',{recursive:true,force:true});}
});

test('stale process lock is recovered and a server refuses an actively locked data directory',async()=>{
  const f=fixture();let release;
  try {
    const root=path.join(__dirname,'..');
    const child=spawnSync(process.execPath,['-e',`require('./lib/data-lock').acquireDataLock(process.argv[1])`,f.dir],{cwd:root,encoding:'utf8'});assert.equal(child.status,0,child.stderr);
    release=acquireDataLock(f.dir);
    const blocked=spawnSync(process.execPath,['server.js','--no-open'],{cwd:root,env:{...process.env,BOBO_DATA_DIR:f.dir,PORT:'0',HOST:'127.0.0.1'},encoding:'utf8',timeout:5000});
    assert.equal(blocked.status,1);assert.match(blocked.stderr,/数据目录正由进程/);
    release();release=null;
    assert.ok((await applyDataUpgrade(f.dir,0)).backup);
  }finally{if(release)release();fs.rmSync(f.dir,{recursive:true,force:true});fs.rmSync(f.dir+'-full-backups',{recursive:true,force:true});}
});
