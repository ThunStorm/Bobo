#!/usr/bin/env node
const path=require('node:path');
const {sourceFingerprint,dataDiagnostics}=require('../lib/diagnostics');
const root=path.join(__dirname,'..');
const args=process.argv.slice(2);
try {
  if(args.length && (args.length!==2 || args[0]!=='--data-dir'))throw new Error('用法：node scripts/diagnose-data.js [--data-dir 数据目录]');
  const dataDir=path.resolve(args[1]||process.env.BOBO_DATA_DIR||path.join(root,'data'));
  console.log(JSON.stringify({mode:'read-only-disk',note:'磁盘指纹不代表已运行进程。管理员登录后打开 /api/admin/diagnostics 核对运行进程。',programDirectory:root,node:process.version,source:sourceFingerprint(root),data:dataDiagnostics(dataDir)},null,2));
}catch(error){console.error(`诊断失败：${error.message}`);process.exitCode=1;}
