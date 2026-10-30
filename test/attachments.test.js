const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDataStore } = require('../lib/data-store');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-attachments-'));
  const store = createDataStore(dir), system = store.composeState().systems[0];
  const project = store.createProject(system.id, { name:'附件测试' }, system.version).project;
  const requirement = store.createRequirement(project.id, { title:'工作',projectVersion:project.version }).requirement;
  const stage = store.createStage(project.id,requirement.id,{title:'通知',start:'2026-01-01',end:'2026-01-01',requirementVersion:requirement.version}).stage;
  const upload = (filename, uploadedAt) => {
    const record = store.addAttachment(project.id,requirement.id,stage.id,{filename,version:stage.version},Buffer.from([0,255,13,10]),'test-user').attachment;
    if (uploadedAt) { record.uploadedAt=uploadedAt; store.atomicWriteJson(path.join(dir,'attachments',`${record.id}.json`),record); }
    return record;
  };
  return {dir,store,project,requirement,stage,upload};
}
test('retention uses six calendar months, retains exact boundary and logs original filenames', () => {
  const f = fixture();
  try {
    const expired=f.upload('旧通知.txt','2026-04-30T11:59:59.999Z');
    const boundary=f.upload('边界.zip','2026-04-30T12:00:00.000Z');
    const recent=f.upload('新文件.未知','2026-10-29T12:00:00Z');
    const revision=f.store.getMeta().revision;
    const result=f.store.cleanupAttachments(new Date('2026-10-30T12:00:00Z'));
    assert.equal(result.deleted,1); assert.equal(result.cutoff,'2026-04-30T12:00:00.000Z');
    assert.equal(fs.existsSync(path.join(f.dir,'attachments',expired.id+'.blob')),false);
    for (const record of [boundary,recent]) assert.deepEqual(fs.readFileSync(f.store.getAttachment(f.project.id,f.requirement.id,f.stage.id,record.id).file),Buffer.from([0,255,13,10]));
    const log=fs.readFileSync(path.join(f.dir,'logs','attachment-deletions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(log.map(x=>x.action),['delete_started','deleted']);
    assert.ok(log.every(x=>x.filename==='旧通知.txt' && x.at==='2026-10-30T12:00:00.000Z'));
    assert.equal(f.store.getMeta().revision,revision+1);
    assert.equal(f.store.cleanupAttachments(new Date('2026-10-30T12:00:00Z')).deleted,0);
    assert.equal(fs.readFileSync(path.join(f.dir,'logs','attachment-deletions.jsonl'),'utf8').trim().split('\n').length,2);
  } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('retention clamps month ends and retains audit history when old stage no longer exists', () => {
  const f=fixture();
  try {
    f.upload('历史阶段附件.bin','2028-02-29T00:00:00Z');
    const state=f.store.composeState();state.systems[0].projects[0].requirements=[];f.store.saveState(state,f.store.getMeta().revision);
    const result=f.store.cleanupAttachments(new Date('2028-08-31T00:00:01Z'));
    assert.equal(result.cutoff,'2028-02-29T00:00:01.000Z');assert.equal(result.deleted,1);
    assert.match(fs.readFileSync(path.join(f.dir,'logs','attachment-deletions.jsonl'),'utf8'),/历史阶段附件/);
  } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('retention refuses deletion when audit log cannot be written', () => {
  const f=fixture();
  try {
    const old=f.upload('保留.dat','2020-01-01T00:00:00Z');fs.writeFileSync(path.join(f.dir,'logs'),'blocked');
    assert.throws(()=>f.store.cleanupAttachments(new Date('2026-10-30T00:00:00Z')));
    assert.ok(fs.existsSync(path.join(f.dir,'attachments',old.id+'.blob')));
  } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
