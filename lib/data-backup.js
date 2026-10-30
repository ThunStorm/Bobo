const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createGzip, createGunzip } = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const BLOCK=512;
const digest=()=>createHash('sha256');
async function fileHash(file) {const hash=digest();for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function snapshot(dataDir) {
  const entries=[];
  function walk(directory) {
    for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(directory===dataDir && item.name==='.bobo-data.lock')continue;
      const absolute=path.join(directory,item.name),relative=path.relative(dataDir,absolute).split(path.sep).join('/'),stat=fs.lstatSync(absolute);
      const base={path:relative,mode:stat.mode&0o7777,mtimeMs:stat.mtimeMs};
      if(stat.isSymbolicLink())entries.push({...base,type:'symlink',link:fs.readlinkSync(absolute),size:0});
      else if(stat.isDirectory()){entries.push({...base,type:'directory',size:0});walk(absolute);}
      else if(stat.isFile()){if(!Number.isSafeInteger(stat.size))throw new Error('备份文件过大');entries.push({...base,type:'file',size:stat.size});}
      else throw new Error(`数据目录包含无法备份的特殊文件：${relative}`);
    }
  }
  walk(dataDir);return entries;
}
function numeric(header,offset,length,value) {header.write(value.toString(8).padStart(length-1,'0')+'\0',offset,length,'ascii');}
function header(name,size,type,mode,mtime,link='') {
  const block=Buffer.alloc(BLOCK);block.write(name,0,100,'utf8');numeric(block,100,8,mode);numeric(block,108,8,0);numeric(block,116,8,0);
  numeric(block,124,12,size<=0o77777777777?size:0);numeric(block,136,12,Math.max(0,Math.floor(mtime/1000)));
  block.fill(32,148,156);block.write(type,156,1);block.write(link,157,100,'utf8');block.write('ustar\0',257,6);block.write('00',263,2);
  const sum=block.reduce((total,byte)=>total+byte,0);block.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);return block;
}
function paxRecord(key,value) {
  const body=` ${key}=${value}\n`;let length=Buffer.byteLength(body)+1;
  while(Buffer.byteLength(String(length)+body)!==length)length=Buffer.byteLength(String(length)+body);
  return Buffer.from(String(length)+body);
}
const padding=size=>Buffer.alloc((BLOCK-size%BLOCK)%BLOCK);
async function* tarData(dataDir,entries) {
  for(const [index,entry] of entries.entries()) {
    const pax=Buffer.concat([paxRecord('path',entry.path),paxRecord('mtime',String(entry.mtimeMs/1000)),...(entry.type==='file'?[paxRecord('size',String(entry.size))]:[]),...(entry.type==='symlink'?[paxRecord('linkpath',entry.link)]:[])]);
    yield header(`PaxHeader/${index}`,pax.length,'x',0o600,entry.mtimeMs);yield pax;yield padding(pax.length);
    yield header(`entry-${index}`,entry.size,entry.type==='directory'?'5':entry.type==='symlink'?'2':'0',entry.mode,entry.mtimeMs,entry.link || '');
    if(entry.type==='file') {
      const absolute=path.join(dataDir,entry.path);const before=fs.lstatSync(absolute);
      if(!before.isFile()||before.size!==entry.size||before.mtimeMs!==entry.mtimeMs)throw new Error(`备份期间文件变化：${entry.path}`);
      const hash=digest();let count=0;
      for await(const chunk of fs.createReadStream(absolute)){count+=chunk.length;hash.update(chunk);yield chunk;}
      const after=fs.lstatSync(absolute);
      if(count!==entry.size||!after.isFile()||after.size!==entry.size||after.mtimeMs!==entry.mtimeMs)throw new Error(`备份期间文件变化：${entry.path}`);
      entry.sha256=hash.digest('hex');yield padding(entry.size);
    }
  }
  yield Buffer.alloc(BLOCK*2);
}
class Reader {
  constructor(stream){this.iterator=stream[Symbol.asyncIterator]();this.buffer=Buffer.alloc(0);}
  async read(size){while(this.buffer.length<size){const chunk=await this.iterator.next();if(chunk.done)throw new Error('压缩备份不完整');this.buffer=Buffer.concat([this.buffer,chunk.value]);}const result=this.buffer.subarray(0,size);this.buffer=this.buffer.subarray(size);return result;}
  async end(){if(this.buffer.some(value=>value!==0))throw new Error('备份尾部无效');for(;;){const chunk=await this.iterator.next();if(chunk.done)break;if(chunk.value.some(value=>value!==0))throw new Error('备份尾部无效');}}
}
function paxFields(bytes) {
  const fields={};let offset=0;
  while(offset<bytes.length){const space=bytes.indexOf(32,offset),length=Number(bytes.subarray(offset,space).toString());if(space<offset||!Number.isSafeInteger(length)||length<=0||offset+length>bytes.length)throw new Error('备份 PAX 记录无效');const body=bytes.subarray(space+1,offset+length-1).toString('utf8'),equal=body.indexOf('=');if(equal<0)throw new Error('备份 PAX 字段无效');fields[body.slice(0,equal)]=body.slice(equal+1);offset+=length;}
  return fields;
}
async function verifyBackup(archive,entries) {
  const expected=new Map(entries.map(entry=>[entry.path,entry]));
  const input=fs.createReadStream(archive),gunzip=createGunzip();
  input.on('error',error=>gunzip.destroy(error));input.pipe(gunzip);
  const reader=new Reader(gunzip);let pax={};
  try {
    for(;;){
      const block=await reader.read(BLOCK);
      if(block.every(value=>value===0)){if(!(await reader.read(BLOCK)).every(value=>value===0))throw new Error('备份结束标记无效');await reader.end();break;}
      const recorded=parseInt(block.subarray(148,156).toString().replace(/\0/g,'').trim(),8);const copy=Buffer.from(block);copy.fill(32,148,156);
      if(copy.reduce((sum,value)=>sum+value,0)!==recorded)throw new Error('备份 TAR 校验和无效');
      const type=String.fromCharCode(block[156]),headerSize=parseInt(block.subarray(124,136).toString().replace(/\0/g,'').trim(),8);
      if(type==='x'){if(headerSize>1024*1024)throw new Error('备份头过大');pax=paxFields(await reader.read(headerSize));await reader.read(padding(headerSize).length);continue;}
      const name=pax.path||block.subarray(0,100).toString().split('\0')[0],size=Number(pax.size??headerSize),entry=expected.get(name);
      if(!entry||!Number.isSafeInteger(size)||size!==entry.size||type!==(entry.type==='file'?'0':entry.type==='directory'?'5':'2')||(entry.type==='symlink'&&pax.linkpath!==entry.link))throw new Error(`备份条目校验失败：${name}`);
      const hash=digest();let remaining=size;while(remaining){const chunk=await reader.read(Math.min(remaining,65536));hash.update(chunk);remaining-=chunk.length;}
      if(entry.type==='file'&&hash.digest('hex')!==entry.sha256)throw new Error(`备份内容校验失败：${name}`);
      await reader.read(padding(size).length);expected.delete(name);pax={};
    }
    if(expected.size)throw new Error('压缩备份缺少文件');
  }finally{input.destroy();gunzip.destroy();}
}
async function createFullDataBackup(dataDir) {
  dataDir=path.resolve(dataDir);
  const destination=path.join(path.dirname(dataDir),path.basename(dataDir)+'-full-backups');fs.mkdirSync(destination,{recursive:true,mode:0o700});
  const name=`data-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.tar.gz`,archive=path.join(destination,name),temporary=archive+'.tmp';
  const entries=snapshot(dataDir);
  try {
    await pipeline(Readable.from(tarData(dataDir,entries)),createGzip(),fs.createWriteStream(temporary,{flags:'wx',mode:0o600}));
    if(!require('node:util').isDeepStrictEqual(snapshot(dataDir),entries.map(({sha256,...entry})=>entry)))throw new Error('备份期间数据目录发生变化，升级已取消');
    await verifyBackup(temporary,entries);
    const sha256=await fileHash(temporary);fs.renameSync(temporary,archive);
    return {archive,sha256,entries,excluded:['.bobo-data.lock'],source:dataDir,createdAt:new Date().toISOString()};
  }catch(error){fs.rmSync(temporary,{force:true});throw error;}
}
module.exports={createFullDataBackup,verifyBackup};
