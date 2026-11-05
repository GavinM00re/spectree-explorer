"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function verify(directory) {
  const root=path.resolve(directory);
  const read=file=>fs.readFileSync(path.join(root,file));
  const json=file=>JSON.parse(read(file));
  const manifest=json('release-manifest.json');
  const names=new Set(manifest.files.map(file=>file.path));
  assert.equal(names.size,manifest.files.length,'Duplicate release file');
  const files=[];
  function walk(folder,prefix='') {
    for (const entry of fs.readdirSync(folder,{withFileTypes:true})) {
      if (entry.name==='.git') continue;
      assert(!entry.isSymbolicLink(),'Release must not contain symbolic links');
      const relative=prefix+entry.name;
      if(entry.isDirectory())walk(path.join(folder,entry.name),relative+'/'); else files.push(relative);
    }
  }
  walk(root);
  for(const file of files)assert(names.has(file)||file==='release-manifest.json',`Unexpected file: ${file}`);
  let totalBytes=0, largest={path:'',bytes:0};
  for(const file of manifest.files) {
    assert(!/(^|\/)(\.env|\.aws|\.codex|node_modules|environments)(\/|$)|\.(log|pem|key)$/i.test(file.path),`Private/runtime file: ${file.path}`);
    assert(!file.path.includes('..')&&!path.isAbsolute(file.path),'Invalid manifest path');
    const data=read(file.path);
    assert.equal(data.length,file.bytes,`Size mismatch: ${file.path}`);
    assert.equal(hash(data),file.sha256,`Hash mismatch: ${file.path}`);
    assert(data.length<100*1024*1024,`File exceeds GitHub's 100 MiB limit: ${file.path}`);
    totalBytes+=data.length;
    if(data.length>largest.bytes)largest={path:file.path,bytes:data.length};
    if(file.path.endsWith('.html')) {
      for(const match of data.toString('utf8').matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
        const href=match[1].split(/[?#]/)[0];
        if(!href||/^(?:https?:|data:|mailto:)/.test(href))continue;
        const target=path.resolve(path.dirname(path.join(root,file.path)),decodeURIComponent(href));
        assert(target.startsWith(root+path.sep),`Link outside release: ${href}`);
        assert(fs.existsSync(target),`Broken link in ${file.path}: ${href}`);
        if(fs.statSync(target).isDirectory())assert(fs.existsSync(path.join(target,'index.html')),`Directory has no index: ${href}`);
      }
    }
  }
  const meta=json('v7_map/data/meta.json'),libraryBytes=read('v7_map/data/library.json'),library=JSON.parse(libraryBytes);
  assert.equal(meta.N,105328);assert.equal(meta.Q,645);
  assert.equal(library.id.length,meta.N);assert.equal(meta.questions.length,meta.Q);
  for(const key of ['name','formula','smiles'])assert.equal(library[key].length,meta.N);
  assert.equal(hash(libraryBytes),meta.provenance.librarySha256);
  const model=zlib.gunzipSync(read('v7_map/data/model.bin.gz'));
  assert.equal(model.length,meta.provenance.modelBytes);
  assert.equal(hash(model),meta.provenance.modelSha256);
  const schema=json('v7_map/data/path_tree_all/schema.json'),status=json('v7_map/data/path_tree_all/status.json');
  const validation=json('v7_map/data/path_tree_all/validation.json');
  assert.equal(schema.status,'complete');assert.equal(status.status,'complete');assert.equal(status.validation.passed,true);assert.equal(validation.passed,true);
  assert.equal(schema.totalReadings,meta.N);assert.equal(schema.nodeCount,1524318);
  assert.equal(schema.provenance.sourceModelSha256,meta.provenance.modelSha256);
  assert.equal(schema.provenance.sourceLibrarySha256,meta.provenance.librarySha256);
  const tree=read('v7_map/data/path_tree_all/tree.bin');
  assert.equal(tree.length,schema.binaryBytes);assert.equal(hash(tree),schema.binarySha256);
  assert.equal(validation.binarySha256,schema.binarySha256);assert.equal(status.validation.binarySha256,schema.binarySha256);
  const chunks=manifest.files.filter(file=>/^akinator_v7\/molecules\/chunk_\d{3}\.js$/.test(file.path));
  assert.equal(chunks.length,106);
  let readings=0;
  for(let i=0;i<106;i++) {
    const file=`akinator_v7/molecules/chunk_${String(i).padStart(3,'0')}.js`;
    const text=read(file).toString('utf8');
    const match=text.match(/SPECTREE_CHUNK\(\s*(\d+)\s*,\s*"([A-Za-z0-9+/=]+)"\s*\)/);
    assert(match,`Unexpected chunk format: ${file}`);assert.equal(Number(match[1]),i);
    const rows=JSON.parse(zlib.gunzipSync(Buffer.from(match[2],'base64')));
    assert.equal(rows.length,Math.min(meta.chunks.size,meta.N-i*meta.chunks.size));
    for(const row of rows) {
      assert.equal(row.a.length,meta.Q);
      assert(row.a.every((a,q)=>Number.isInteger(a)&&a>=0&&a<meta.ncat[q]),`Invalid reading in ${file}`);
      assert(Array.isArray(row.ms)&&Array.isArray(row.h)&&Array.isArray(row.c));
    }
    readings+=rows.length;
  }
  assert.equal(readings,105328);
  return {passed:true,files:manifest.files.length,totalBytes,largest,candidates:meta.N,questions:meta.Q,readings,chunks:chunks.length,decisionStates:schema.nodeCount,modelSha256:meta.provenance.modelSha256,treeSha256:schema.binarySha256};
}
if(require.main===module)console.log(JSON.stringify(verify(process.argv[2]||path.resolve(__dirname,'..')),null,2));
module.exports={verify};
