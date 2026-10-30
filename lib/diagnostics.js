const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {readDiagnosticSnapshot}=require('./data-store');
const FILES=['server.js','lib/auth.js','lib/data-store.js','lib/data-upgrade.js','lib/data-backup.js','lib/data-lock.js','lib/diagnostics.js','scripts/upgrade-data.js','public/app.js','public/collab.js','public/login.js','public/login.html','public/index.html','public/styles.css','public/reports.js','public/recurrence.js','public/attachments.js','config/stage-types.json'];
function sourceFingerprint(root){
  const files=Object.fromEntries(FILES.map(file=>[file,fs.existsSync(path.join(root,file))?createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'):null]));
  const content=file=>fs.existsSync(path.join(root,file))?fs.readFileSync(path.join(root,file),'utf8'):'';
  return {id:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files,features:{automaticRequirementStages:/stages:\s*STAGE_TYPES\.map/.test(content('public/app.js')),automaticIssueSeeding:/function\s+seedFutureIssues\s*\(/.test(content('lib/data-store.js'))}};
}
function dataDiagnostics(dataDir){
  const snapshot=readDiagnosticSnapshot(dataDir),today=new Date().toISOString().slice(0,10);
  return {directory:dataDir,schemaVersion:snapshot.meta?.schemaVersion??null,dataFieldsVersion:snapshot.meta?.dataFieldsVersion??0,revision:snapshot.meta?.revision??null,legacyFiles:[...(snapshot.legacy?['projects.json']:[]),...(snapshot.legacyArchive?['projects.json.migrated']:[])],projects:snapshot.projects.map(({project,issues})=>{
    const requirements=project.requirements||[],stages=requirements.flatMap(item=>item.stages||[]),withIssues=new Set(issues.map(item=>item.stageId));
    return {id:project.id,requirements:requirements.length,stages:stages.length,issues:issues.length,openIssues:issues.filter(item=>item.status!=='closed').length,futureStagesWithoutIssues:stages.filter(stage=>stage.start>today&&!withIssues.has(stage.id)).length,storedLegacyIssueFlags:stages.filter(stage=>stage.issueOpen||stage.issues).length,defaultFiveStageRequirements:requirements.filter(item=>(item.stages||[]).map(stage=>stage.type).join('|')==='需求澄清|工作量及商务|功能开发|技术测试|业务测试').length};
  })};
}
function runtimeDiagnostics(root,dataDir,started){
  const disk=sourceFingerprint(root);
  return {generatedAt:new Date().toISOString(),runtime:{pid:process.pid,startedAt:started.at,node:process.version,programDirectory:root,executable:process.execPath,sourceAtStartup:started.source.id,sourceOnDisk:disk.id,filesChangedSinceStartup:FILES.filter(file=>started.source.files[file]!==disk.files[file]),restartNeeded:started.source.id!==disk.id},source:disk,data:dataDiagnostics(dataDir)};
}
module.exports={sourceFingerprint,dataDiagnostics,runtimeDiagnostics};
