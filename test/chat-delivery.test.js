import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {processMessage} from '../lib/worker.js';
test('safe transport retries failed sends, passes event/results and skips duplicate history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bot-delivery-'));const capture=join(root,'calls');const marker=join(root,'sent');
 const oldPath=process.env.PATH;process.env.PATH=`${root}:${oldPath}`;
 await writeFile(join(root,'aux4'),`#!/usr/bin/env node
const fs=require('node:fs');let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{
 const args=process.argv.slice(2),body=raw?JSON.parse(raw):null;
 fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,body})+'\\n');
 if(args[0]==='repository') {
  if(args[1]==='read')process.stdout.write(fs.existsSync(${JSON.stringify(marker)})?'[{"id":"sent"}]':'[]');
  else if(args[1]==='claim') {fs.writeFileSync(${JSON.stringify(marker)},'1');process.stdout.write('{}');}
  else process.stdout.write('{}');
 } else if(args[2]==='format')process.stdout.write(JSON.stringify({text:'answer',history:{messages:[]},correlation:body.event.key}));
 else if(args[2]==='send') {
  const n=${JSON.stringify(join(root,'attempt'))};
  if(!fs.existsSync(n)){fs.writeFileSync(n,'1');process.stdout.write('{"ok":false}');}
  else process.stdout.write('{"ok":true}');
 } else process.stdout.write('{"ok":true}');
});
`);await chmod(join(root,'aux4'),0o755);
 const brain=join(root,'brain.cjs');await writeFile(brain,"process.stdin.resume();process.stdout.write('answer');");
 const msg={channel:'chat',botId:'test',event:{key:'one',chatId:'room',text:'hello',delivery:{callbackCapability:'opaque'}}};
 const ctx={channels:['chat'],bots:{test:{channel:'chat',command:`node ${brain}`,history:false,sendIdempotent:true,typingInterval:0,logMessages:false}},defaults:{},db:'fixture',tmpDir:root};
 try {
  await assert.rejects(()=>processMessage(msg,ctx),/delivery failed/);
  let calls=(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(c=>c.args[1]==='claim'),false);
  await processMessage(msg,ctx);await processMessage(msg,ctx);
  calls=(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);
  const sends=calls.filter(c=>c.args[2]==='send');assert.equal(sends.length,2);
  assert.equal(sends[1].body.event.delivery.callbackCapability,'opaque');assert.equal(sends[1].body.formatted.correlation,'one');
  assert.equal(calls.some(c=>c.args.includes('conversations')),false);
 } finally {process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});}
});
