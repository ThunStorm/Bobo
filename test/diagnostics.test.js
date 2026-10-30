const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {spawnSync}=require('node:child_process');
const {sourceFingerprint,runtimeDiagnostics}=require('../lib/diagnostics');
test('source fingerprints ignore install path, detect running/disk mismatch, and diagnostics are read-only',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bobo-diagnostic-'));try{
    const one=path.join(root,'one'),two=path.join(root,'two'),data=path.join(root,'data');
    for(const folder of [one,two]){fs.mkdirSync(path.join(folder,'public'),{recursive:true});fs.writeFileSync(path.join(folder,'public/app.js'),'same source');}
    fs.mkdirSync(data);fs.writeFileSync(path.join(data,'meta.json'),'{"schemaVersion":2,"revision":5}');fs.writeFileSync(path.join(data,'systems.json'),'{"systems":[]}');fs.writeFileSync(path.join(data,'users.json'),'{"passwordHash":"do-not-read-credential"}');
    const started={at:'2026-10-30T00:00:00Z',source:sourceFingerprint(one)};assert.equal(started.source.id,sourceFingerprint(two).id);
    fs.writeFileSync(path.join(one,'public/app.js'),'updated source');const result=runtimeDiagnostics(one,data,started);assert.equal(result.runtime.restartNeeded,true);assert.deepEqual(result.runtime.filesChangedSinceStartup,['public/app.js']);assert.equal(result.data.revision,5);assert.doesNotMatch(JSON.stringify(result),/passwordHash|do-not-read/);
    const before=fs.readdirSync(data).map(file=>[file,fs.readFileSync(path.join(data,file)).toString('hex')]);
    const cli=spawnSync(process.execPath,['scripts/diagnose-data.js','--data-dir',data],{cwd:path.join(__dirname,'..'),encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).mode,'read-only-disk');assert.doesNotMatch(cli.stdout,/do-not-read/);assert.deepEqual(fs.readdirSync(data).map(file=>[file,fs.readFileSync(path.join(data,file)).toString('hex')]),before);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
