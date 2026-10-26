'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const net = require('node:net'); const http = require('node:http'); const { spawn } = require('node:child_process');
const { analyze } = require('../promptinsights');
const { DatabaseSync } = require('node:sqlite');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2j8sAAAAASUVORK5CYII=', 'base64');
const KEY = 'sk-workspace-synthetic-key-123456789';
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0,'127.0.0.1',() => { const p=s.address().port; s.close(() => resolve(p)); }); });
test('chat keeps older messages available and never mixes accounts', () => {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('owner'),('other');");
  const store = require('../conversations').init(sqlite);
  for (let i = 0; i < 250; i++) store.append('owner','guide',{id:`message-${i}`,role:'user',content:`Saved message ${i}`});
  const recent = store.list('owner','guide'); assert.equal(recent.length,200); assert.equal(recent[0].content,'Saved message 50');
  const earlier = store.list('owner','guide',recent[0].sequence); assert.equal(earlier.length,50); assert.equal(earlier[0].content,'Saved message 0');
  assert.equal(store.get('owner','guide','message-0').content,'Saved message 0'); assert.equal(store.list('other','guide').length,0); sqlite.close();
});
test('prompt analysis distinguishes decisions from pending work and contrasts repeated patterns', () => {
  const samples = [
    {id:'a',title:'A',prompt:'natural light red coat portrait',decision:'APPROVED'},
    {id:'b',title:'B',prompt:'natural light blue coat portrait',decision:'APPROVED'},
    {id:'c',title:'C',prompt:'harsh flash red coat portrait',decision:'REJECT'},
    {id:'d',title:'D',prompt:'harsh flash green coat portrait',decision:'REVISE'},
    {id:'e',title:'Pending',prompt:'harsh flash natural light portrait',decision:null},
  ]; const result = analyze(samples);
  assert.deepEqual(result.counts,{total:5,approved:2,unapproved:2,pending:1});
  assert.ok(result.approvedPatterns.some(x => x.term==='natural light'&&x.count===2&&x.otherCount===0));
  assert.ok(result.unapprovedPatterns.some(x => x.term==='harsh flash'&&x.count===2&&x.otherCount===0));
  assert.ok(result.similarPrompts.length); assert.equal(samples[4].decision,null);
});
test('persistent CarniChat, model routing, images, reference suggestions, sheets, and analysis remain user scoped', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'carnival-workspace-'));
  const calls = []; let reject = false;
  const draft = {referenceMaterial:'Two friends explore a sunny village.',setting:'Village square in spring daylight',characters:[{name:'Ava',gender:'Female',referenceMaterial:'Ava wears a red coat.'},{name:'Ben',gender:'Male',referenceMaterial:'Ben wears a blue coat.'}]};
  const mock = http.createServer(async (req,res) => {
    const chunks=[]; for await(const chunk of req)chunks.push(chunk); const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
    calls.push({url:req.url,auth:req.headers.authorization,key:req.headers['x-api-key'],body});
    res.setHeader('content-type','application/json');
    if(req.url.endsWith('/models'))return res.end(JSON.stringify({data:req.url.includes('compatible')?[{id:'custom-vision',supports_vision:true},{id:'custom-text',supports_vision:false}]:[{id:'gpt-6.1-sol'},{id:'gpt-4o-mini'},{id:'gpt-image-2'}]}));
    if(reject){reject=false;res.statusCode=500;return res.end(JSON.stringify({error:{message:`Synthetic rejection ${KEY}`}}));}
    if(req.url==='/images')return res.end(JSON.stringify({data:[{b64_json:PNG.toString('base64')}]}));
    const system=body.instructions||body.system||body.messages?.[0]?.content||'';
    const text=system.includes('ALL reference fields')?JSON.stringify(draft):system.includes('ideas')||system.includes('ideas')?JSON.stringify([{title:'A village walk',description:'A bright walk.'}]):'Synthetic assistant reply';
    if(req.url.endsWith('/responses'))return res.end(JSON.stringify({model:body.model,output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:20,output_tokens:10}}));
    if(req.url.endsWith('/messages'))return res.end(JSON.stringify({model:body.model,content:[{type:'text',text}]}));
    res.end(JSON.stringify({model:body.model,choices:[{message:{content:text}}]}));
  }); await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const upstream=`http://127.0.0.1:${mock.address().port}`; const port=await freePort(); const base=`http://127.0.0.1:${port}`; let child;
  async function start(){child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATA_DIR:temp,APP_SECRET:'workspace-synthetic-secret',DEEPSEEK_ENDPOINT:upstream+'/deepseek/chat/completions',OPENAI_DIRECT_TEST_BASE_URL:upstream+'/direct/v1',ANTHROPIC_ENDPOINT:upstream+'/anthropic/v1/messages',BYTEPLUS_IMAGE_ENDPOINT:upstream+'/images'},stdio:'ignore'});
    for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,60));}throw new Error('Test server did not start');}
  async function stop(){if(child&&child.exitCode===null&&!child.signalCode)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
  t.after(async()=>{await stop();mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}); await start();
  async function request(url,{method='GET',body,cookie,raw,headers={}}={}){const response=await fetch(base+url,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...headers},body:raw|| (body?JSON.stringify(body):undefined)});const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  const owner=(await request('/api/auth/register',{method:'POST',body:{username:'workspace_owner',password:'password123'}})).cookie;
  const other=(await request('/api/auth/register',{method:'POST',body:{username:'workspace_other',password:'password123'}})).cookie;
  await request('/api/me/ai-settings',{method:'PUT',cookie:other,body:{textProvider:'openai-direct',textModel:'gpt-6.1-sol'}});
  assert.equal((await request('/api/generate',{method:'POST',cookie:other,body:{context:'Missing selected provider key',numIdeas:1}})).status,409);
  assert.equal(calls.length,0,'selected provider credentials are still required');
  await request('/api/me/openai-direct-key',{method:'PUT',cookie:owner,body:{apiKey:KEY}});
  await request('/api/me/openai-key',{method:'PUT',cookie:owner,body:{apiKey:KEY+'-compatible',baseUrl:upstream+'/compatible/v1'}});
  await request('/api/me/anthropic-key',{method:'PUT',cookie:owner,body:{apiKey:KEY+'-anthropic'}});
  let result=await request('/api/chat/models?refresh=1',{cookie:owner});assert.equal(result.status,200);
  assert.ok(result.data.providers.find(x=>x.provider==='openai-direct').models.some(x=>x.id==='gpt-6.1-sol'));
  assert.ok(!result.data.providers.find(x=>x.provider==='openai-direct').models.some(x=>x.id==='gpt-image-2'));
  assert.equal(result.data.providers.find(x=>x.provider==='openai').models.find(x=>x.id==='custom-vision').vision,true);
  await request('/api/me/chat-settings',{method:'PUT',cookie:owner,body:{guideProvider:'openai-direct',guideModel:'gpt-6.1-sol'}});
  const send=(id,content,extra={})=>request('/api/chat',{method:'POST',cookie:owner,body:{message:{id,content,...extra},mode:'guide'}});
  result=await send('turn-one','Hello');assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(calls.at(-1).url,'/direct/v1/responses');assert.equal(calls.at(-1).auth,`Bearer ${KEY}`);
  assert.equal(result.data.messages.length,2);const paid=calls.length;assert.equal((await send('turn-one','Hello')).data.cached,true);assert.equal(calls.length,paid);
  assert.equal((await request('/api/chat/history',{cookie:other})).data.guide.length,0);
  await stop();await start();result=await request('/api/chat/history',{cookie:owner});assert.equal(result.data.guide[0].content,'Hello');assert.equal(result.data.guide[1].content,'Synthetic assistant reply');
  const image=await request('/api/chat/images?name=photo.png',{method:'POST',cookie:owner,raw:PNG,headers:{'content-type':'image/png'}});assert.equal(image.status,201,JSON.stringify(image.data));
  assert.equal((await request(image.data.image.url,{cookie:other})).status,404);
  result=await send('turn-image','Describe this photo',{attachments:[image.data.image]});assert.equal(result.status,200,JSON.stringify(result.data));
  const input=calls.at(-1).body.input.at(-1).content;assert.equal(input[0].type,'input_image');assert.match(input[0].image_url,/^data:image\/png;base64,/);
  await request('/api/me/chat-settings',{method:'PUT',cookie:owner,body:{guideProvider:'openai',guideModel:'custom-text'}});
  const before=calls.length;result=await send('unsupported','No image support',{attachments:[image.data.image]});assert.equal(result.status,400);assert.equal(result.data.code,'CHAT_IMAGES_UNSUPPORTED');assert.equal(calls.length,before);
  await request('/api/chat/models?refresh=1',{cookie:owner});
  await request('/api/me/chat-settings',{method:'PUT',cookie:owner,body:{guideProvider:'openai',guideModel:'custom-vision'}});
  result=await send('compatible-image','Check image',{attachments:[image.data.image]});assert.equal(result.status,200);assert.equal(calls.at(-1).body.messages.at(-1).content[0].type,'image_url');
  await request('/api/me/chat-settings',{method:'PUT',cookie:owner,body:{guideProvider:'anthropic',guideModel:'claude-sonnet-5-5'}});
  result=await send('claude-image','Check image',{attachments:[image.data.image]});assert.equal(result.status,200);assert.equal(calls.at(-1).body.messages.at(-1).content[0].source.type,'base64');
  reject=true;result=await send('failed-turn','Keep this on failure');assert.equal(result.status,502);assert.ok(!JSON.stringify(result.data).includes(KEY));
  result=await request('/api/chat/history',{cookie:owner});assert.ok(result.data.guide.some(x=>x.content==='Keep this on failure'));assert.ok(!JSON.stringify(result.data).includes(KEY));
  const project=(await request('/api/projects',{method:'POST',cookie:owner,body:{title:'Village',stage:'Reference Stage',idea:'Two friends in a village'}})).data.project;
  result=await request('/api/chat',{method:'POST',cookie:owner,body:{message:{id:'references',content:'Make a refrence, setting and character refrence for both the characters'},projectId:project.id,referenceRequest:true,referenceInputs:{context:'Two friends'}}});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.referenceDraft.characters.length,2);assert.equal(result.data.referenceDraft.setting,draft.setting);
  const saved=(await request('/api/projects',{cookie:owner})).data.projects[0];assert.equal(saved.referenceMaterial,'','chat suggestions are not silently saved or approved');
  for(const [provider,model,pathSuffix]of[['openai-direct','gpt-6.1-sol','/responses'],['openai','custom-text','/chat/completions'],['anthropic','claude-sonnet-5-5','/messages']]){
    result=await request('/api/me/ai-settings',{method:'PUT',cookie:owner,body:{textProvider:provider,textModel:model}});assert.equal(result.status,200,JSON.stringify(result.data));
    result=await request('/api/generate',{method:'POST',cookie:owner,body:{context:'A village idea',numIdeas:1}});assert.equal(result.status,200,JSON.stringify(result.data));assert.ok(calls.at(-1).url.endsWith(pathSuffix));assert.equal(calls.at(-1).body.model,model);
  }
  await request('/api/me/byteplus-key',{method:'PUT',cookie:owner,body:{apiKey:'byteplus-synthetic-key'}});
  const character=(await request('/api/characters',{method:'POST',cookie:owner,body:{name:'Ava',description:'Ava in a red coat'}})).data.character;
  result=await request(`/api/characters/${character.id}/generate`,{method:'POST',cookie:owner,body:{}});assert.equal(result.status,201);assert.equal(result.data.version.mode,'sheet');const prompt=result.data.version.prompt;
  const library=(await request('/api/library',{cookie:owner})).data.images;const sheet=library.find(x=>x.source==='character-reference-sheet');assert.ok(sheet);assert.equal(sheet.prompt,prompt);
  const repeat=(await request('/api/library',{cookie:owner})).data.images;assert.equal(repeat.filter(x=>x.source==='character-reference-sheet').length,1);
  assert.equal((await request('/api/library',{cookie:other})).data.images.length,0);
  result=await request('/api/library/prompt-analysis',{cookie:owner});assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.counts.pending,1);
  await request(`/api/assets/${sheet.assetId}/reviews`,{method:'POST',cookie:owner,body:{decision:'APPROVED'}});
  result=await request('/api/library/prompt-analysis',{cookie:owner});assert.equal(result.data.counts.approved,1);assert.equal(result.data.counts.pending,0);
  assert.equal((await request('/api/library/prompt-analysis',{cookie:other})).data.counts.total,0);
  assert.equal((await request('/api/drive/status',{cookie:owner})).data.configured,false);
  assert.equal((await request('/api/drive/connect',{method:'POST',cookie:owner})).status,503);
  await request('/api/chat/history',{method:'DELETE',cookie:owner});assert.equal((await request('/api/chat/history',{cookie:owner})).data.guide.length,0);
});
