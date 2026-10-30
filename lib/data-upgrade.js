const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createDataStore, SCHEMA_VERSION } = require('./data-store');
const { acquireDataLock } = require('./data-lock');
const { createFullDataBackup } = require('./data-backup');
const recurrence = require('../public/recurrence');

// Increment whenever persisted business fields change; update defaults and regression fixtures together.
const DATA_FIELDS_VERSION = 2;
const FIELD_HISTORY = [{ version: 1, description: '完整 v2 业务字段：需求 completed、阶段 recurrence/notificationText、日期标记 recurrence、问题与评论字段' }, { version: 2, description: '升级前全量 data 压缩备份与完整性校验；删除明确停用的旧 projects JSON；规范评论 authorUserId' }];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = isDeepStrictEqual;
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 对象结构无效'); return value; }
function array(value) { if (!Array.isArray(value)) throw new Error('JSON 列表结构无效'); return value; }
function id(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`缺失或无效的 ID：${value}`); return value; }
function unique(records, label) { if (new Set(records.map(item=>item.id)).size!==records.length) throw new Error(`${label} ID 重复`); }
function fill(source, defaults) { return { ...defaults, ...object(source) }; }
function bump(before, after) {
  if (!same(before, after)) after.version = Number(before.version || 0) + 1;
  if (!Number.isInteger(after.version) || after.version < 1) throw new Error('实体 version 无效');
  return after;
}
function calendar(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value+'T00:00:00Z')) || new Date(value+'T00:00:00Z').toISOString().slice(0,10) !== value) throw new Error(`日期无效，需人工核对：${value}`);
}
function marker(raw) {
  id(raw.id); calendar(raw.date);
  const result = fill(raw, { label:'日期标记', type:'custom', color:'blue', notes:'', recurrence:null });
  if (result.recurrence) recurrence.occurrences(result.date,result.date,result.recurrence);
  return result;
}
function stage(raw) {
  id(raw.id); calendar(raw.start); calendar(raw.end);
  if (raw.end < raw.start) throw new Error('阶段结束日期早于开始日期');
  const result = fill(raw, { type:'自定义', title:raw.type || '未命名阶段', owner:'', hours:0, status:'未开始', notes:'', notificationText:'', recurrence:null, version:1 });
  if (typeof result.notificationText !== 'string' || result.notificationText.length > 100000) throw new Error('通知文本无效');
  if (result.recurrence) recurrence.occurrences(result.start,result.end,result.recurrence);
  return bump(raw,result);
}
function requirement(raw) {
  id(raw.id);
  const result = fill(raw,{title:'未命名需求', completed:false, stages:[], version:1});
  if (typeof result.completed !== 'boolean') throw new Error('需求完成状态无效');
  result.stages = array(result.stages).map(stage);
  return bump(raw,result);
}
function issue(raw, projectId) {
  id(raw.id); id(raw.stageId);
  const result = fill(raw,{projectId,title:'待处理问题',description:'',status:'open',priority:'medium',dueDate:'',comments:[],assigneeUserId:'',createdByUserId:'',createdAt:'',updatedByUserId:'',updatedAt:'',closedByUserId:'',closedAt:'',legacyClosureUnknown:raw.status === 'closed' && !raw.closedAt,version:1});
  if (result.projectId !== projectId) throw new Error('问题项目归属不一致');
  result.comments=array(result.comments).map(comment => { id(comment.id); return fill(comment,{body:'',authorUserId:comment.createdByUserId || '',createdAt:''}); });
  return bump(raw,result);
}
function sourceFiles(dataDir) {
  const files = [];
  if (fs.lstatSync(dataDir).isSymbolicLink()) throw new Error('不升级符号链接数据目录');
  for (const name of ['meta.json','systems.json','projects.json','projects.json.migrated']) if (fs.existsSync(path.join(dataDir,name))) files.push(name);
  const projects = path.join(dataDir,'projects');
  if (fs.existsSync(projects) && fs.lstatSync(projects).isSymbolicLink()) throw new Error('不升级符号链接 projects 目录');
  if (fs.existsSync(projects)) for (const entry of fs.readdirSync(projects,{withFileTypes:true})) {
    if (entry.isSymbolicLink()) throw new Error('不升级符号链接项目目录');
    if (!entry.isDirectory()) continue;
    for (const name of ['project.json','issues.json']) if (fs.existsSync(path.join(projects,entry.name,name))) files.push(path.join('projects',entry.name,name));
  }
  return files;
}
function planDataUpgrade(dataDir) {
  dataDir=path.resolve(dataDir);
  const files=sourceFiles(dataDir);
  if (!files.length) throw new Error('没有找到现有业务 JSON；升级脚本不会初始化空目录');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'bobo-fields-upgrade-'));
  const originals=new Map();
  try {
    for (const file of files) {
      const source=path.join(dataDir,file);
      if (!fs.lstatSync(source).isFile()) throw new Error(`不升级非普通文件：${file}`);
      const bytes=fs.readFileSync(source); originals.set(file,bytes);
      const target=path.join(temporary,file); fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
    }
    const hasMeta=fs.existsSync(path.join(temporary,'meta.json')), hasSystems=fs.existsSync(path.join(temporary,'systems.json'));
    if (hasMeta!==hasSystems) throw new Error('meta/systems 布局不完整，请人工核对迁移状态');
    const legacy=!hasMeta;
    if (legacy && files.some(file=>file.startsWith('projects'+path.sep))) throw new Error('旧单文件与多文件项目并存，请人工核对迁移状态');
    if (legacy && !fs.existsSync(path.join(temporary,'projects.json'))) throw new Error('数据布局不完整，缺少 meta/systems 或旧版 projects.json');
    for (const name of ['meta.json','systems.json']) if (originals.has(name)) {
      const document=JSON.parse(originals.get(name).toString('utf8').replace(/^\uFEFF/,''));
      if (Number(document.dataFieldsVersion || 0)>DATA_FIELDS_VERSION) throw new Error('字段版本比升级脚本更新，拒绝降级');
      if (Number(document.schemaVersion || 1)>SCHEMA_VERSION) throw new Error('数据 schema 比当前程序更新，拒绝降级');
    }
    const store=createDataStore(temporary); // Legacy migration runs only against the temporary copy.
    const read=file=>store.readJson(path.join(temporary,file),null);
    const writes=[];
    const write=(file,document)=>{
      const previous=originals.has(file)?JSON.parse(originals.get(file).toString('utf8').replace(/^\uFEFF/,'')):undefined;
      if (!same(previous,document)) writes.push({file,document,existed:originals.has(file)});
    };
    const beforeSystems=read('systems.json');
    const systems=fill(beforeSystems,{schemaVersion:SCHEMA_VERSION,version:1,systems:[]});
    systems.schemaVersion=SCHEMA_VERSION;
    const seen=new Set();
    systems.systems=array(systems.systems).map(raw=>{
      id(raw.id);
      const system=fill(raw,{name:'未命名系统',version:1,dateMarkers:[],projectIds:[]});
      system.dateMarkers=array(system.dateMarkers).map(marker);
      for (const projectId of array(system.projectIds)) {
        id(projectId); if (seen.has(projectId)) throw new Error('项目 ID 重复'); seen.add(projectId);
        const projectFile=path.join('projects',projectId,'project.json');
        const before=object(read(projectFile));
        if (before.id!==projectId || (before.systemId && before.systemId!==system.id)) throw new Error('项目归属不一致');
        const project=fill(before,{systemId:system.id,name:'未命名项目',version:1,milestones:[],dateMarkers:[],requirements:[]});
        project.dateMarkers=array(project.dateMarkers).map(marker);
        project.milestones=array(project.milestones).map(raw=>{id(raw.id);calendar(raw.date);return fill(raw,{label:'节点'});});
        project.requirements=array(project.requirements).map(requirement);
        unique(project.requirements,'需求');unique(project.requirements.flatMap(item=>item.stages),'阶段');
        write(projectFile,bump(before,project));
        const issuesFile=path.join('projects',projectId,'issues.json');
        const issues=fill(read(issuesFile)||{},{projectId,issues:[]});
        if (issues.projectId!==projectId) throw new Error('问题文档归属不一致');
        issues.issues=array(issues.issues).map(raw=>issue(raw,projectId));unique(issues.issues,'问题');write(issuesFile,issues);
      }
      return bump(raw,system);
    });
    unique(systems.systems,'系统');
    write('systems.json',bump(beforeSystems,systems));
    const oldMeta=read('meta.json');
    if (Number(oldMeta.dataFieldsVersion || 0)>DATA_FIELDS_VERSION) throw new Error('字段版本比升级脚本更新，拒绝降级');
    const meta=fill(oldMeta,{schemaVersion:SCHEMA_VERSION,revision:1,updatedAt:''});
    meta.schemaVersion=SCHEMA_VERSION;meta.dataFieldsVersion=DATA_FIELDS_VERSION;
    if (!same(oldMeta,meta) || writes.length || legacy || originals.has('projects.json') || originals.has('projects.json.migrated')) {
      const revision=Number(oldMeta.revision || 0);
      if (!Number.isInteger(revision) || revision<0) throw new Error('全局 revision 无效');
      meta.revision=revision+1;meta.updatedAt=new Date().toISOString();write('meta.json',meta);
    }
    const deletes=['projects.json','projects.json.migrated'].filter(file=>originals.has(file)).map(file=>({file,reason:'旧版单文件，完成多文件升级后不再使用'}));
    return {dataDir,version:DATA_FIELDS_VERSION,writes,deletes,legacy,originals};
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
}
async function assertStopped(port) {
  if (!Number.isInteger(port)||port<0||port>65535) throw new Error('PORT 无效');
  const probe=net.createServer();
  await new Promise((resolve,reject)=>{probe.once('error',()=>reject(new Error(`端口 ${port} 正在使用或无法检查；请先停止 Bobo 服务，并确认 PORT 设置一致`)));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
}
async function applyDataUpgrade(dataDir, port=4177) {
  await assertStopped(port);
  const release=acquireDataLock(path.resolve(dataDir));
  let fullBackup=null;
  try {
    const plan=planDataUpgrade(dataDir);
    if (!plan.writes.length && !plan.deletes.length) return {...plan,backup:null,fullBackup:null};
    fullBackup=await createFullDataBackup(plan.dataDir);
    const backup=path.join(plan.dataDir,'backups',`fields-v${DATA_FIELDS_VERSION}-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`);
    fs.mkdirSync(backup,{recursive:true});
    const files=[...new Set([...plan.writes.map(item=>item.file),...plan.deletes.map(item=>item.file)])];
    const store=createDataStore(fs.mkdtempSync(path.join(os.tmpdir(),'bobo-upgrade-writer-')));
    try {
      // Verify the reviewed source still matches; backup original bytes before any replacement.
      for (const [file,bytes] of plan.originals) if (hash(fs.readFileSync(path.join(plan.dataDir,file)))!==hash(bytes)) throw new Error('业务文件在规划期间被修改，升级已取消');
      const manifest={fullBackup:{archive:fullBackup.archive,sha256:fullBackup.sha256},deletes:plan.deletes,dataFieldsVersion:DATA_FIELDS_VERSION,createdAt:new Date().toISOString(),files:files.map(file=>({file,existed:plan.originals.has(file),sha256:plan.originals.has(file)?hash(plan.originals.get(file)):null}))};
      for (const file of files) if (plan.originals.has(file)) {const dest=path.join(backup,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,plan.originals.get(file));}
      store.atomicWriteJson(fullBackup.archive+'.manifest.json',fullBackup);
      store.atomicWriteJson(path.join(backup,'manifest.json'),manifest);
      const applied=[];
      try {
        for (const item of plan.writes) {applied.push(item);store.atomicWriteJson(path.join(plan.dataDir,item.file),item.document);}
        for (const item of plan.deletes) {applied.push({...item,existed:true});fs.unlinkSync(path.join(plan.dataDir,item.file));}
      } catch (error) {
        const rollbackErrors=[];
        for (const item of applied.reverse()) {
          const target=path.join(plan.dataDir,item.file);
          try {
            if (plan.originals.has(item.file)) {fs.writeFileSync(target+'.rollback.tmp',plan.originals.get(item.file));fs.renameSync(target+'.rollback.tmp',target);}
            else fs.rmSync(target,{force:true});
            fs.rmSync(`${target}.${process.pid}.tmp`,{force:true});
          } catch (restoreError) {rollbackErrors.push(`${item.file}: ${restoreError.message}`);}
        }
        throw new Error(`升级失败，${rollbackErrors.length?'部分回滚失败，需从备份人工恢复：'+rollbackErrors.join('; '):'已回滚已写文件'}；备份：${backup}；${error.message}`);
      }
      return {...plan,backup,fullBackup};
    } finally {fs.rmSync(store.dataDir,{recursive:true,force:true});}
  } catch(error) { if(fullBackup) error.message+=`；已验证的全量压缩备份：${fullBackup.archive}`; throw error; } finally {release();}
}
module.exports={DATA_FIELDS_VERSION,FIELD_HISTORY,planDataUpgrade,applyDataUpgrade};
