'use strict';
const assert = require('node:assert/strict'); const {test} = require('node:test');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const http=require('node:http');const crypto=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const security=require('../security');
test('Drive OAuth binds state to user/session, encrypts credentials, and exports/imports images with prompt metadata',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'carnival-drive-'));const sqlite=new DatabaseSync(path.join(temp,'app.db'));
  sqlite.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('owner'),('other');");security.init(temp);
  const files=new Map();const pending=new Map();let tokenCalls=0,requests=0;let base='';let challenge='';
  const mock=http.createServer(async(req,res)=>{
    requests++;const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);const url=new URL(req.url,base);res.setHeader('content-type','application/json');
    if(url.pathname==='/token'){
      const form=new URLSearchParams(bytes.toString());assert.equal(form.get('client_secret'),'synthetic-drive-client-secret');tokenCalls++;
      if(form.get('grant_type')==='authorization_code'){assert.equal(crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'),challenge);return res.end(JSON.stringify({access_token:'synthetic-access-secret',refresh_token:'synthetic-refresh-secret',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'}));}
      assert.equal(form.get('refresh_token'),'synthetic-refresh-secret');return res.end(JSON.stringify({access_token:'synthetic-new-access-secret',expires_in:3600}));
    }
    assert.match(req.headers.authorization||'',/^Bearer synthetic-(?:new-)?access-secret$/);
    if(url.pathname==='/upload/drive/v3/files'){
      const id=`file-${pending.size+files.size+1}`;pending.set(id,{...JSON.parse(bytes),mimeType:req.headers['x-upload-content-type']});res.setHeader('location',`${base}/session/${id}`);return res.end('{}');
    }
    if(url.pathname.startsWith('/session/')){
      const id=url.pathname.split('/').pop();const file=pending.get(id);files.set(id,{...file,id,bytes,size:String(bytes.length)});pending.delete(id);return res.end(JSON.stringify({id,name:file.name,webViewLink:`https://drive.google.com/file/d/${id}/view`}));
    }
    if(url.pathname==='/drive/v3/files'){
      const q=url.searchParams.get('q')||'';const imageId=q.match(/value='(file-\d+)'/)?.[1];const selected=[...files.values()].filter(file=>imageId?file.appProperties?.imageFileId===imageId:file.appProperties?.carnival==='image');return res.end(JSON.stringify({files:selected.map(({bytes,...file})=>file)}));
    }
    const id=url.pathname.split('/').pop();const file=files.get(id);if(!file){res.statusCode=404;return res.end('{}');}
    if(url.searchParams.get('alt')==='media'){res.setHeader('content-type',file.mimeType);return res.end(file.bytes);}const {bytes:omit,...metadata}=file;res.end(JSON.stringify(metadata));
  });await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${mock.address().port}`;
  const oldEnv={NODE_ENV:process.env.NODE_ENV,GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET:process.env.GOOGLE_CLIENT_SECRET,GOOGLE_DRIVE_TEST_BASE_URL:process.env.GOOGLE_DRIVE_TEST_BASE_URL};
  Object.assign(process.env,{NODE_ENV:'test',GOOGLE_CLIENT_ID:'synthetic-client',GOOGLE_CLIENT_SECRET:'synthetic-drive-client-secret',GOOGLE_DRIVE_TEST_BASE_URL:base});
  t.after(async()=>{mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));sqlite.close();for(const [key,value]of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(temp,{recursive:true,force:true});});
  const drive=require('../drive').init(sqlite,security,'https://carnival.test');const owner={user_id:'owner',token_hash:'owner-session'};const other={user_id:'other',token_hash:'other-session'};
  assert.equal(drive.status('owner').configured,true);assert.equal(drive.status('owner').connected,false);
  const url=new URL(drive.connect(owner).url);challenge=url.searchParams.get('code_challenge');assert.equal(url.searchParams.get('redirect_uri'),'https://carnival.test/api/drive/callback');assert.equal(url.searchParams.get('scope'),'https://www.googleapis.com/auth/drive.file');
  const params=new URLSearchParams({state:url.searchParams.get('state'),code:'owner-code'});
  await assert.rejects(drive.callback(other,params),error=>error.status===400);
  await assert.rejects(drive.callback({...owner,token_hash:'wrong-session'},params),error=>error.status===400);
  await drive.callback(owner,params);assert.equal(drive.status('owner').connected,true);assert.equal(drive.status('other').connected,false);
  await assert.rejects(drive.callback(owner,params),error=>error.status===400);
  const encrypted=sqlite.prepare('SELECT tokens_enc FROM drive_connections WHERE user_id=?').get('owner').tokens_enc;assert.ok(!encrypted.includes('synthetic-access-secret'));assert.ok(!encrypted.includes('synthetic-refresh-secret'));
  const tokens=JSON.parse(security.decryptApiKey(encrypted));tokens.expires=0;sqlite.prepare('UPDATE drive_connections SET tokens_enc=? WHERE user_id=?').run(security.encryptApiKey(JSON.stringify(tokens)),'owner');
  await Promise.all([drive.list('owner'),drive.list('owner')]);assert.equal(tokenCalls,2,'one initial exchange and one shared refresh');
  const bytes=Buffer.from('synthetic-image-bytes');const asset={versionId:'version-one',name:'collage.png',mime:'image/png'};const info={prompt:'Natural daylight, red coat, village square',model:'synthetic-image-model',versions:[{prompt:'Earlier saved prompt'}]};
  const saved=await drive.save('owner',asset,bytes,info);assert.equal(files.size,2);assert.match(saved.url,/drive.google.com/);const before=requests;await drive.save('owner',asset,bytes,info);assert.equal(requests,before,'repeat exports reuse both saved files');
  const list=await drive.list('owner');assert.equal(list.files.length,1);
  const imported=await drive.read('owner',saved.imageId);assert.ok(imported.bytes.equals(bytes));assert.deepEqual(imported.info,info);
  await assert.rejects(drive.list('other'),error=>error.status===409);
  drive.disconnect('owner');assert.equal(drive.status('owner').connected,false);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM drive_connections').get().n,0);assert.equal(files.size,2,'disconnect does not delete cloud files');
});
