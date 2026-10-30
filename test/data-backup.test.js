const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {createHash}=require('node:crypto');const {Readable}=require('node:stream');const {spawnSync}=require('node:child_process');
const {createFullDataBackup,verifyBackup}=require('../lib/data-backup');const {applyDataUpgrade,planDataUpgrade}=require('../lib/data-upgrade');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bobo-full-backup-')),dir=path.join(root,'data');fs.mkdirSync(dir);const write=(file,bytes)=>{const target=path.join(dir,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);};write('meta.json','{"schemaVersion":2,"revision":1}');write('systems.json','{"schemaVersion":2,"version":1,"systems":[]}');write('users.json','{"credential":"private-test-value"}');write('attachments/原文件.bin',Buffer.from([0,255,3,4]));write('logs/events.log','历史日志');write('backups/old/历史.json','{"history":1}');return{root,dir,write};}
test('compressed snapshot includes credentials, attachments, logs and existing backups; standard tar restores exact bytes',async()=>{
  const f=fixture();try{
    f.write('深目录/'.repeat(12)+'很长文件名.json','{"中文":true}');f.write('empty.bin',Buffer.alloc(0));fs.mkdirSync(path.join(f.dir,'empty-directory'));f.write('.bobo-data.lock/owner.json','{}');
    if(process.platform!=='win32'){fs.symlinkSync('users.json',path.join(f.dir,'credential-link'));fs.symlinkSync('深目录/'.repeat(12)+'很长文件名.json',path.join(f.dir,'long-link'));}
    const result=await createFullDataBackup(f.dir);assert.ok(!result.archive.startsWith(f.dir+path.sep));
    for(const name of ['users.json','attachments/原文件.bin','logs/events.log','backups/old/历史.json'])assert.equal(result.entries.find(item=>item.path===name).sha256,sha(fs.readFileSync(path.join(f.dir,name))));
    assert.equal(result.entries.some(item=>item.path.startsWith('.bobo-data.lock')),false);await verifyBackup(result.archive,result.entries);
    // Independent interoperability check on hosts with a native tar; not a runtime dependency.
    if(process.platform!=='win32'){
      const restore=path.join(f.root,'restore');fs.mkdirSync(restore);const command=spawnSync('tar',['-xzf',result.archive,'-C',restore],{encoding:'utf8'});assert.equal(command.status,0,command.stderr);
      for(const item of result.entries)if(item.type==='file')assert.equal(sha(fs.readFileSync(path.join(restore,item.path))),item.sha256);
      if(process.platform!=='win32')assert.equal(fs.readlinkSync(path.join(restore,'credential-link')),'users.json');
      assert.equal(fs.readlinkSync(path.join(restore,'long-link')),'深目录/'.repeat(12)+'很长文件名.json');
    }
    const compressed=fs.readFileSync(result.archive);compressed[Math.floor(compressed.length/2)]^=0xff;fs.writeFileSync(result.archive,compressed);await assert.rejects(verifyBackup(result.archive,result.entries));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('obsolete legacy files are listed, backed up and removed; arbitrary JSON and backups remain',async()=>{
  const f=fixture();try{
    f.write('projects.json','old unused bytes');f.write('projects.json.migrated','old migrated bytes');f.write('unknown.json','{"doNotInferUnused":true}');
    const plan=planDataUpgrade(f.dir);assert.deepEqual(plan.deletes.map(item=>item.file),['projects.json','projects.json.migrated']);assert.ok(fs.existsSync(path.join(f.dir,'projects.json')));
    const result=await applyDataUpgrade(f.dir,0);assert.equal(result.deletes.length,2);assert.equal(fs.existsSync(path.join(f.dir,'projects.json')),false);assert.equal(fs.existsSync(path.join(f.dir,'projects.json.migrated')),false);
    assert.equal(fs.readFileSync(path.join(f.dir,'unknown.json'),'utf8'),'{"doNotInferUnused":true}');assert.ok(fs.existsSync(path.join(f.dir,'backups/old/历史.json')));
    for(const file of ['projects.json','projects.json.migrated'])assert.ok(result.fullBackup.entries.some(item=>item.path===file));
    assert.equal(JSON.parse(fs.readFileSync(result.fullBackup.archive+'.manifest.json')).sha256,result.fullBackup.sha256);assert.equal(planDataUpgrade(f.dir).deletes.length,0);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('a failed full-backup verification prevents all JSON rewrites and obsolete-file deletion',async()=>{
  const f=fixture(),original=fs.createReadStream;try{
    f.write('projects.json','preserve');const before=fs.readFileSync(path.join(f.dir,'meta.json'));
    fs.createReadStream=(file,...args)=>String(file).endsWith('.tar.gz.tmp')?Readable.from([Buffer.from('corrupt gzip')]):original(file,...args);
    await assert.rejects(applyDataUpgrade(f.dir,0));assert.deepEqual(fs.readFileSync(path.join(f.dir,'meta.json')),before);assert.equal(fs.readFileSync(path.join(f.dir,'projects.json'),'utf8'),'preserve');
    assert.equal(fs.readdirSync(path.join(f.dir,'backups')).includes('old'),true);assert.equal(fs.readdirSync(path.join(f.dir,'backups')).length,1);
  }finally{fs.createReadStream=original;fs.rmSync(f.root,{recursive:true,force:true});}
});

test('obsolete-file deletion failure restores both deleted files and preceding JSON writes',async()=>{
  const f=fixture(),unlink=fs.unlinkSync;let failed=false;
  try{
    f.write('projects.json','legacy one');f.write('projects.json.migrated','legacy two');const before=fs.readFileSync(path.join(f.dir,'meta.json'));
    fs.unlinkSync=file=>{if(file===path.join(f.dir,'projects.json.migrated')&&!failed){failed=true;throw new Error('simulated deletion failure');}return unlink(file);};
    await assert.rejects(applyDataUpgrade(f.dir,0),/已回滚/);assert.deepEqual(fs.readFileSync(path.join(f.dir,'meta.json')),before);assert.equal(fs.readFileSync(path.join(f.dir,'projects.json'),'utf8'),'legacy one');assert.equal(fs.readFileSync(path.join(f.dir,'projects.json.migrated'),'utf8'),'legacy two');
  }finally{fs.unlinkSync=unlink;fs.rmSync(f.root,{recursive:true,force:true});}
});
