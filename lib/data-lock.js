const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Shared by the server and offline upgrader; PID checks allow recovery after a crash.
function acquireDataLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const directory = path.join(dataDir, '.bobo-data.lock');
  const ownerFile = path.join(directory, 'owner.json');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.mkdirSync(directory); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { throw new Error('数据目录锁不完整，请确认所有 Bobo 服务和升级进程已停止后检查 .bobo-data.lock'); }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('数据目录锁无效，停止服务后请人工检查');
      try { process.kill(owner.pid, 0); throw new Error(`数据目录正由进程 ${owner.pid} 使用，请先停止服务或升级进程`); }
      catch (activeError) {
        if (activeError.code !== 'ESRCH') throw activeError;
        fs.unlinkSync(ownerFile); fs.rmdirSync(directory); continue;
      }
    }
    try { fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' }); }
    catch (error) { fs.rmdirSync(directory); throw error; }
    return () => {
      try {
        if (JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token === token) { fs.unlinkSync(ownerFile); fs.rmdirSync(directory); }
      } catch { /* A stale lock is recovered by the next owner after this process exits. */ }
    };
  }
  throw new Error('无法取得数据目录锁');
}
module.exports = { acquireDataLock };
