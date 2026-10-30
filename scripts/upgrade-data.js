#!/usr/bin/env node
const path = require('node:path');
const readline = require('node:readline/promises');
const { planDataUpgrade, applyDataUpgrade, DATA_FIELDS_VERSION, FIELD_HISTORY } = require('../lib/data-upgrade');
async function main() {
  if (Number(process.versions.node.split('.')[0])<18) throw new Error('需要 Node.js 18+');
  const args=process.argv.slice(2);
  let dataDir=process.env.BOBO_DATA_DIR || path.join(__dirname,'..','data');
  let port=Number(process.env.PORT || 4177), apply=false, check=false, interactive=false;
  for (let index=0;index<args.length;index++) {
    if (args[index]==='--data-dir') { if (!args[index+1] || args[index+1].startsWith('--')) throw new Error('--data-dir 缺少目录'); dataDir=args[++index]; }
    else if (args[index]==='--port') { if (!args[index+1]) throw new Error('--port 缺少端口'); port=Number(args[++index]); }
    else if (args[index]==='--apply') apply=true;
    else if (args[index]==='--check') check=true;
    else if (args[index]==='--interactive') interactive=true;
    else if (args[index]==='--help') {console.log('node scripts/upgrade-data.js [--check | --apply | --interactive] [--data-dir 路径] [--port 4177]\n默认只检查；实际升级前请停止所有使用该数据目录的服务。');return;}
    else throw new Error(`未知参数：${args[index]}`);
  }
  if (apply && check) throw new Error('--check 与 --apply 不能同时使用');
  dataDir=path.resolve(dataDir);
  console.log(`Bobo 业务字段升级 v${DATA_FIELDS_VERSION}\n${FIELD_HISTORY.at(-1).description}\n数据目录：${dataDir}`);
  const plan=planDataUpgrade(dataDir);
  console.log(plan.writes.length?`待升级 ${plan.writes.length} 个文件：\n${plan.writes.map(item=>'  '+item.file).join('\n')}${plan.deletes.length?'\n待删除旧文件：'+plan.deletes.map(item=>item.file).join('、'):''}`:'字段已完整，无需升级。');
  if (!plan.writes.length && !plan.deletes.length) return;
  console.log('将先完整压缩 data（含账户、附件、日志和历史备份），校验通过后才改写或删除。');
  if (interactive && !apply && !check) {
    const terminal=readline.createInterface({input:process.stdin,output:process.stdout});
    try {apply=(await terminal.question('请先停止服务。先全量压缩备份并校验，再补字段和删除所列旧文件；输入 UPGRADE 确认执行，其他输入取消：')).trim()==='UPGRADE';}
    finally {terminal.close();}
  }
  if (!apply) {console.log('未写入任何业务文件。使用 --apply 或双击升级入口确认执行。');return;}
  const result=await applyDataUpgrade(dataDir,port);
  console.log(`升级完成；修改 ${result.writes.length} 个文件，删除 ${result.deletes.length} 个停用旧文件。\n全量压缩备份：${result.fullBackup?.archive || '无变更'}\n原文件备份与清单：${result.backup || '无变更'}`);
}
main().catch(error=>{console.error(`升级未完成：${error.message}`);process.exitCode=1;});
