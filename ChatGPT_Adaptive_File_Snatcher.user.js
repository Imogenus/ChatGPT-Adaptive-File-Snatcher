// ==UserScript==
// @name         ChatGPT Adaptive File Snatcher
// @namespace    http://tampermonkey.net/
// @version      4.7.4
// @description  Learn workspace paths independently of artifact detection; preserve v4.7.3 downloads.
// @updateURL    https://raw.githubusercontent.com/Imogenus/ChatGPT-Adaptive-File-Snatcher/main/ChatGPT_Adaptive_File_Snatcher.user.js
// @downloadURL  https://raw.githubusercontent.com/Imogenus/ChatGPT-Adaptive-File-Snatcher/main/ChatGPT_Adaptive_File_Snatcher.user.js
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(() => {
'use strict';

const V='4.7.4', LOG='[AdaptiveSnatcher]', WID='batch-snatcher-widget';
const EXT=new Set(['zip','py','md','txt','json','png','jpg','jpeg','webp','gif','svg','pdf','blend','csv','tsv','html','htm','js','jsx','ts','tsx','css','xml','yaml','yml','toml','ini','cfg','log','doc','docx','xls','xlsx','ppt','pptx','mp4','webm','mov','avi','wav','mp3','ogg','flac','glb','gltf','obj','fbx','stl']);
const INSTANCE='__CHATGPT_ADAPTIVE_SNATCHER__';
if(window[INSTANCE]===V)return;
window[INSTANCE]=V;

const key=`adaptive_snatcher_${location.pathname.replace(/[^a-z0-9_-]/gi,'_')}`;
const doneKey=`${key}_completed_ids_v41`;
const defaults={enabled:false,target:45,infinite:false,downloaded:0};
let state=defaults;
try{state={...defaults,...JSON.parse(sessionStorage.getItem(key)||'{}')}}catch(_){}
const done=new Set(), busy=new Set();
try{for(const id of JSON.parse(sessionStorage.getItem(doneKey)||'[]'))if(typeof id==='string')done.add(id)}catch(_){}
let latest=null, panelPinned=false, scanDelay=null, status='idle';
// Seen message identities are tab-lifetime state. On a refresh, re-baseline
// the visible conversation rather than trusting unstable virtual turn numbers.
const seenUsers=new Set(),seenAssistants=new Set(),freshAssistants=new Set();
let initialized=false,pendingUserId='',pendingUserRoot=null;
// Calibration is per conversation, deliberately separate from download counts.
// Calibration learns a path independently of artifact detection. A successful
// direct download later upgrades that path from learned to verified.
const calibrationKey=`${key}_workspace_calibration_v47`;
let calibration={directory:'',verified:false,pending:false,baselineIds:[]};
try{calibration={...calibration,...JSON.parse(localStorage.getItem(calibrationKey)||'{}')}}catch(_){}
const saveCalibration=()=>{try{localStorage.setItem(calibrationKey,JSON.stringify(calibration))}catch(_){}};

// Passive flight recorder: deliberately does not influence eligibility, retry,
// deduplication, download initiation, or the v4.4 UI counter semantics.
// localStorage persists across reloads and browser sessions without changing
// Tampermonkey's @grant none execution context.
// Reuse the v4.4 storage key to retain diagnostics from the known-good release.
const diagnosticKey=`${key}_diagnostics_v44`, MAX_EVENTS=800;
let events=[],dirty=false,flushTimer=null;
const scanSeen=new Map();
try{const old=JSON.parse(localStorage.getItem(diagnosticKey)||'[]');if(Array.isArray(old))events=old.slice(-MAX_EVENTS)}catch(_){}
function flushDiagnostics(){
  clearTimeout(flushTimer);flushTimer=null;if(!dirty)return;
  try{localStorage.setItem(diagnosticKey,JSON.stringify(events));dirty=false}catch(e){console.warn(LOG,'diagnostic storage unavailable:',String(e))}
}
function record(type,detail={}){
  // Do not record message bodies, auth data, signed URLs, or file contents.
  events.push({at:new Date().toISOString(),type,...detail});
  if(events.length>MAX_EVENTS)events.splice(0,events.length-MAX_EVENTS);
  dirty=true;if(!flushTimer)flushTimer=setTimeout(flushDiagnostics,3000);
}
function diagnosticIdentity(c){return {file:c.filename,kind:c.kind,messageId:c.messageId||null,exact:!!c.exactFilename}}
function scanEvent(reason,detail={}){
  // v4.4 alternated "candidate already handled" and "no action" on every
  // scan, evicting important download events. Throttle each reason/identity
  // independently, regardless of intervening scan results or DOM counts.
  const signature=`${reason}|${detail.messageId||''}|${detail.file||''}|${detail.blocked||''}`;
  const now=Date.now(),previous=scanSeen.get(signature)||0;
  if(now-previous>=60000){scanSeen.set(signature,now);record('scan',{reason,...detail})}
  if(scanSeen.size>180)for(const [s,t] of scanSeen)if(now-t>120000)scanSeen.delete(s);
}
function exportDiagnostics(){
  flushDiagnostics();
  const payload={schema:'adaptive-snatcher-diagnostics-v1',version:V,exportedAt:new Date().toISOString(),
    page:location.pathname,downloadedCounter:state.downloaded,target:state.target,infinite:state.infinite,
    note:'v4.4 behavior retained. Counter advances on successful direct initiation OR native activation; native activation is unverified.',
    eventCounts:events.reduce((m,e)=>(m[e.type]=(m[e.type]||0)+1,m),{}),events};
  const date=new Date().toISOString().replace(/[-:]/g,'').replace('T','_').replace(/\..*/,'');
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`ADAPTIVE_SNATCHER_DIAGNOSTICS_${date}.json`;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);
}
window.addEventListener('pagehide',flushDiagnostics);

const save=()=>{try{sessionStorage.setItem(key,JSON.stringify(state))}catch(_){}};
const saveDone=()=>{try{sessionStorage.setItem(doneKey,JSON.stringify([...done].slice(-2000)))}catch(_){}};
const norm=s=>String(s||'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').trim();
const ext=f=>((String(f).match(/\.([a-z0-9]+)$/i)||[])[1]||'').toLowerCase();
const accepted=f=>!!f&&EXT.has(ext(f));

function filenameFromText(s){
  s=norm(s); if(!s)return '';

  // UI labels can prepend an action verb, e.g.
  // aria-label="Open BRIDGE_V093_EXISTING_HAB_AUDIT.zip".
  // That verb is not part of the real filename.
  s=s.replace(/^(?:open|download|save|view)\s+/i,'').trim();

  let m=s.match(/^([^\r\n<>:"|?*\/\\]+?\.[A-Za-z0-9]{1,8})\b/i);
  if(m&&accepted(m[1].trim()))return m[1].trim();

  const pat=[...EXT].join('|');
  const rx=new RegExp(`([^\\/:*?"<>|\\r\\n]+?\\.(?:${pat}))\\b`,'ig');
  const all=[...s.matchAll(rx)];
  if(!all.length)return '';
  return all[all.length-1][1].trim().replace(/^(?:open|download|save|view)\s+/i,'').trim();
}


function artifactExtHint(s){
  s=norm(s); if(!s)return '';
  const literal=filenameFromText(s);
  if(literal)return ext(literal);
  const pat=[...EXT].sort((a,b)=>b.length-a.length).join('|');
  let m=s.match(new RegExp(`\\(\\s*(${pat})\\s*\\)\\s*$`,'i'));
  if(!m)m=s.match(new RegExp(`\\[\\s*(${pat})\\s*\\]\\s*$`,'i'));
  return m?m[1].toLowerCase():'';
}

function artifactLabel(el){
  if(!el)return '';
  for(const v of [
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('title'),
    el.getAttribute?.('data-filename'),
    el.getAttribute?.('data-file-name'),
    el.innerText,
    el.textContent
  ]){
    const s=norm(v);
    if(s)return s;
  }
  return '';
}

function looksLikeArtifactControl(el,label=''){
  if(!el)return false;
  label=norm(label||artifactLabel(el));
  if(!artifactExtHint(label))return false;
  return el.tagName==='A' || el.tagName==='BUTTON' ||
    ['link','button'].includes((el.getAttribute?.('role')||'').toLowerCase()) ||
    el.getAttribute?.('data-file-reference')==='true' ||
    el.getAttribute?.('data-d-component')==='pressable' ||
    /download|open|save|artifact|file/i.test(label);
}

function syntheticFilenameFromLabel(label,hint){
  label=norm(label)
    .replace(/^(?:open|download|save|view)\s+/i,'')
    .replace(/^(?:open|download|save|view)\s+/i,'')
    .replace(/\s*[\(\[]\s*[A-Za-z0-9]{1,8}\s*[\)\]]\s*$/,'')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  if(!label)label='ChatGPT artifact';
  if(label.length>140)label=label.slice(0,140).trim();
  return `${label}.${hint||'bin'}`;
}

function filenameFromElement(el){
  if(!el)return '';

  // Current DIL links expose the exact filename as visible text but prefix
  // aria-label with "Open ". Prefer the visible filename first.
  const textFile=filenameFromText(el.innerText||el.textContent||'');
  if(textFile)return textFile;

  for(const a of ['data-markdown-copy-text','aria-label','title','download','data-filename','data-file-name']){
    const f=filenameFromText(el.getAttribute?.(a)); if(f)return f;
  }
  const h=el.getAttribute?.('href')||'';
  if(h){try{const f=filenameFromText(decodeURIComponent(h));if(f)return f}catch(_){}}
  return '';
}

function isAssistantTurn(el){
  if(!el||el.nodeType!==1)return false;
  if(/:assistant$/i.test(el.getAttribute('data-content-search-unit-key')||''))return true;
  if(/:assistant$/i.test(el.getAttribute('data-chatgpt-search-unit-key')||''))return true;
  if((el.getAttribute('data-message-author-role')||'').toLowerCase()==='assistant')return true;
  return false; // A descendant assistant heading does NOT make a parent an assistant turn.
}

const unitSelector='[data-content-search-unit-key],[data-chatgpt-search-unit-key],[data-message-author-role]';
function actualRole(el){
  const unit=el?.closest?.(unitSelector);
  if(unit){
    const key=(unit.getAttribute('data-content-search-unit-key')||unit.getAttribute('data-chatgpt-search-unit-key')||'').toLowerCase();
    if(/:(user|assistant)$/.test(key))return key.split(':').pop();
    const role=(unit.getAttribute('data-message-author-role')||'').toLowerCase();
    if(role==='user'||role==='assistant')return role;
  }
  // Semantic headings are accepted only when they belong to a narrowly scoped
  // message wrapper, never from an arbitrary conversation ancestor.
  return '';
}

function turns(){
  const roots=new Set();
  document.querySelectorAll(
    '[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":assistant"],[data-message-author-role="assistant"]'
  ).forEach(x=>roots.add(x));

  document.querySelectorAll('[data-conversation-role="assistant"]').forEach(role=>{
    const root=role.closest('[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":assistant"]');
    if(root)roots.add(root);
  });

  let a=[...roots];
  if(!a.length)a=[...document.querySelectorAll('[data-message-author-role="assistant"]')];

  return a.filter((x,i,arr)=>!arr.some((y,j)=>j!==i&&y.contains(x)));
}

function owner(el){
  const unit=el?.closest?.(unitSelector);
  return unit&&actualRole(el)==='assistant'&&isAssistantTurn(unit)?unit:null;
}

function messageIdentity(root){
  if(!root)return '';
  const raw=root.getAttribute?.('data-chatgpt-search-message-ids')||
    root.querySelector?.('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')||'';
  const list=raw.trim().split(/\s+/).filter(Boolean);
  if(list.length)return list[list.length-1];
  return root.getAttribute?.('data-chatgpt-selection-message-id')||
    root.querySelector?.('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id')||'';
}

function userTurns(){
  const a=[...document.querySelectorAll(
    '[data-chatgpt-search-unit-key$=":user"],[data-content-search-unit-key$=":user"],[data-message-author-role="user"]'
  )];
  return a.filter((x,i,arr)=>!arr.some((y,j)=>i!==j&&y.contains(x)));
}

function atConversationBottom(){
  const scroller=document.querySelector('[data-app-action-timeline-scroll]') ||
    document.querySelector('[aria-label="Conversation"]');
  if(!scroller)return true; // Some renderer variants have no separate scroller.
  return scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<220;
}

function armFromNow(){
  if(!atConversationBottom()){
    scanEvent('baseline-blocked-not-at-bottom');
    setStatus('scroll to latest message to begin capture');return false;
  }
  const users=userTurns(),assistants=turns();
  if(!users.length&&!assistants.length){scanEvent('baseline-waiting-for-messages');setStatus('waiting for conversation before capture starts');return false}
  seenUsers.clear();seenAssistants.clear();freshAssistants.clear();
  for(const r of users){const id=messageIdentity(r);if(id)seenUsers.add(id)}
  for(const r of assistants){const id=messageIdentity(r);if(id)seenAssistants.add(id)}
  pendingUserId='';pendingUserRoot=null;initialized=true;
  record('baseline',{userTurns:users.length,assistantTurns:assistants.length,userIds:seenUsers.size,assistantIds:seenAssistants.size});
  setStatus('listening for new assistant artifacts (message IDs)');
  return true;
}

function pageConversation(){
  const m=location.pathname.match(/^\/c\/([^/?#]+)/); return m?m[1]:'';
}

function ids(el,turn){
  let conversation='', message='';
  for(let n=el,d=0;n&&d<24;n=n.parentElement,d++){
    conversation ||= n.getAttribute?.('data-chatgpt-selection-conversation-id')||'';
    message ||= n.getAttribute?.('data-chatgpt-selection-message-id')||n.getAttribute?.('data-dil-source-message-id')||n.getAttribute?.('data-dil-message-id')||n.getAttribute?.('data-message-id')||'';
    if(conversation&&message)break;
  }
  if(turn){
    conversation ||= turn.querySelector?.('[data-chatgpt-selection-conversation-id]')?.getAttribute('data-chatgpt-selection-conversation-id')||'';
    message ||= turn.querySelector?.('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id')||turn.querySelector?.('[data-dil-source-message-id]')?.getAttribute('data-dil-source-message-id')||turn.querySelector?.('[data-dil-message-id]')?.getAttribute('data-dil-message-id')||'';
    if(!message){const a=(turn.getAttribute?.('data-chatgpt-search-message-ids')||'').trim().split(/\s+/).filter(Boolean);if(a.length)message=a[a.length-1];}
  }
  return {conversationId:conversation||pageConversation(),messageId:message};
}

function kind(el){
  if(el.matches?.('[data-file-reference="true"]'))return 'legacy-file-reference';
  if(el.matches?.('[data-d-component="pressable"][role="link"],[data-d-component="pressable"][role="button"]'))return 'dil-pressable';
  const q=((el.getAttribute?.('aria-label')||'')+' '+(el.getAttribute?.('title')||'')+' '+(el.getAttribute?.('data-testid')||'')).toLowerCase();
  if(el.tagName==='BUTTON'&&q.includes('download'))return 'explicit-download-button';
  if(el.tagName==='A'&&el.hasAttribute('download'))return 'download-anchor';
  if(el.tagName==='A')return 'anchor';
  if(el.getAttribute?.('role')==='link')return 'role-link';
  if(el.getAttribute?.('role')==='button')return 'role-button';
  return 'text-fallback';
}

function sandboxPath(el,filename){
  for(let n=el,d=0;n&&d<12;n=n.parentElement,d++){
    for(const a of ['data-sandbox-path','data-file-path','data-path','href']){
      const s=n.getAttribute?.(a)||''; const m=s.match(/(?:sandbox:)?(\/(?:mnt\/data|workspace\/scratch\/[^/]+)\/[^"'?#<>\s]+)/i);
      if(m){try{return decodeURIComponent(m[1])}catch(_){return m[1]}}
    }
  }
  return filename?(calibration.directory?`${calibration.directory}${filename}`:`/mnt/data/${filename}`):'';
}

function calibrationPath(text){
  // Exact, explicitly requested marker; never infer from arbitrary prose.
  const match=String(text||'').match(/^\s*LATEST_ZIP\s*=\s*['"`]?((?:\/mnt\/data|\/workspace\/scratch\/[^\s/]+)\/[^\r\n'"`<>]+?\.zip)\s*['"`]?\s*$/im);
  return match?match[1].trim():'';
}
function findCalibrationCandidate(path){
  const filename=path.split('/').pop();
  for(const turn of turns().reverse()){
    const match=discover(turn).find(c=>c.exactFilename&&c.filename===filename&&!c.nativeOnly&&c.messageId);
    if(match)return match;
  }
  return null;
}
let calibrationBusy=false;
async function pollCalibration(){
  if(!calibration.pending||calibrationBusy)return;
  const responses=turns().filter(t=>{const id=messageIdentity(t);return id&&!calibration.baselineIds.includes(id)});
  for(const turn of responses){
    const path=calibrationPath(turn.innerText||turn.textContent||'');
    if(!path)continue;
    calibrationBusy=true;
    try{
      const directory=path.slice(0,path.lastIndexOf('/')+1);
      calibration={directory,verified:false,pending:false,baselineIds:[]};
      saveCalibration();record('calibration-learned',{directory,file:path.split('/').pop()});
      setStatus('workspace learned; awaiting successful direct download');refresh();
    }catch(e){
      calibration.pending=false;calibration.verified=false;saveCalibration();
      record('calibration-failed',{reason:String(e.message||e)});setStatus(`calibration failed: ${e.message||e}`);refresh();
    }finally{calibrationBusy=false}
    return;
  }
}
function beginCalibration(){
  if(!pageConversation()){setStatus('open a conversation before calibrating');return}
  const prompt='OUT-OF-BAND FILE-TRANSFER CALIBRATION (not a project instruction): Please inspect the actual filesystem and report the full absolute path of the most recent ZIP file YOU generated and linked for download in this conversation. Output exactly one line: LATEST_ZIP=/absolute/path/to/file.zip (no code fence). Do not create, move, rename, or rebuild any files for this check. IMPORTANT WORKFLOW CONTINUITY: Treat this calibration request AND your calibration response as a temporary technical aside, not as a new project task or a change in priorities. Keep the existing plan, constraints, current version, pending result, and iteration sequence from the last substantive project exchange. After answering, resume that existing work at precisely the point you left off, without re-planning, restarting, or waiting for new approval solely because of this calibration aside.';
  // The newer ChatGPT composer is ProseMirror rather than Lexical and has no
  // prompt-textarea ID. Keep the legacy selectors for older UI variants.
  const editor=document.querySelector('[data-composer-markdown][contenteditable="true"], .ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"]');
  if(!editor){setStatus('composer not found; calibration not started');return}
  editor.focus();
  const selected=window.getSelection();
  const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);selected?.removeAllRanges();selected?.addRange(range);
  const ok=document.execCommand('insertText',false,prompt);
  if(!ok){setStatus('could not insert prompt; calibration not started');return}
  calibration.pending=true;calibration.baselineIds=turns().map(messageIdentity).filter(Boolean);saveCalibration();
  record('calibration-requested',{baselineAssistants:calibration.baselineIds.length});
  setStatus('calibration prompt ready — press Send');refresh();
}

function candidate(el,turn=owner(el)){
  // Fail closed: a user upload, composer attachment, or unowned/global button
  // can NEVER qualify just because its label ends in .zip/.py/etc.
  if(!turn||!isAssistantTurn(turn)||!turn.contains(el)||actualRole(el)!=='assistant'||!owner(el))return null;
  if(!el.matches?.('a,button,[role="link"],[role="button"],[data-file-reference="true"]'))return null;

  const exactFilename=filenameFromElement(el);
  if(accepted(exactFilename)){
    return {...ids(el,turn),filename:exactFilename,exactFilename:true,nativeOnly:false,label:artifactLabel(el),
      sandboxPath:sandboxPath(el,exactFilename),kind:kind(el),el,turn};
  }

  const label=artifactLabel(el);
  const hint=artifactExtHint(label);
  if(!hint||!looksLikeArtifactControl(el,label))return null;

  return {...ids(el,turn),filename:syntheticFilenameFromLabel(label,hint),exactFilename:false,nativeOnly:true,
    label,sandboxPath:'',kind:(el.getAttribute?.('data-d-component')==='pressable'?'dil-native-artifact':'native-artifact-control'),
    el,turn};
}

function discover(turn){
  const out=[];
  const selectors=[
    '[data-file-reference="true"]',
    '[data-d-component="pressable"][role="link"]',
    '[data-d-component="pressable"][role="button"]',
    'button[aria-label]',
    '[role="button"][aria-label]',
    '[role="link"][aria-label]',
    '[title]',
    '[data-testid*="download" i]',
    'a','[role="link"]','[role="button"]'
  ].join(',');

  turn.querySelectorAll(selectors).forEach(el=>{
    const c=candidate(el,turn);
    if(c)out.push(c);
  });

  // Never infer a downloadable artifact from arbitrary assistant prose.

  const rank={'legacy-file-reference':110,'dil-pressable':105,'explicit-download-button':100,'download-anchor':95,
    'dil-native-artifact':92,'native-artifact-control':90,'anchor':80,'role-link':75,'role-button':70,'text-fallback':10};

  const m=new Map();
  for(const c of out){
    const identity=String(c.exactFilename?c.filename:(c.label||c.filename)).toLowerCase();
    const k=`${c.messageId||'?'}::${identity}`;
    const old=m.get(k);
    if(!old||(rank[c.kind]||0)>(rank[old.kind]||0))m.set(k,c);
  }
  return [...m.values()];
}

const ident=c=>`${c.conversationId||'?'}::${c.messageId||'?'}::${String(c.exactFilename?c.filename:(c.label||c.filename)).toLowerCase()}`;

async function token(){
  const r=await fetch('/api/auth/session',{credentials:'include',cache:'no-store'});
  if(!r.ok)throw Error(`session HTTP ${r.status}`);
  const j=await r.json(); if(!j?.accessToken)throw Error('session returned no accessToken');
  return j.accessToken;
}

async function signedUrl(c,t){
  if(!c.conversationId)throw Error('missing conversation id'); if(!c.messageId)throw Error('missing assistant message id');
  const q=new URLSearchParams({download_intent:'true',message_id:c.messageId,sandbox_path:c.sandboxPath});
  const u=`/backend-api/conversation/${encodeURIComponent(c.conversationId)}/interpreter/download?${q}`;
  const r=await fetch(u,{credentials:'include',cache:'no-store',headers:{Authorization:`Bearer ${t}`,Accept:'application/json'}});
  if(!r.ok)throw Error(`interpreter/download HTTP ${r.status}`);
  const j=await r.json(),x=j?.download_url||j?.downloadUrl||j?.url;if(!x)throw Error('download endpoint returned no URL');return x;
}

function validate(filename,b){
  const u=new Uint8Array(b),e=ext(filename); if(!u.length)throw Error('empty file');
  if(e==='zip'&&!(u.length>=4&&u[0]===0x50&&u[1]===0x4b&&[3,5,7].includes(u[2])&&[4,6,8].includes(u[3])))throw Error('not ZIP');
  if(e==='png'&&!(u.length>=8&&[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((v,i)=>u[i]===v)))throw Error('not PNG');
  if(e==='pdf'&&new TextDecoder().decode(u.slice(0,5))!=='%PDF-')throw Error('not PDF');
  if(e==='blend'&&new TextDecoder().decode(u.slice(0,7))!=='BLENDER')throw Error('not BLEND');
}

function saveFile(filename,b,type){
  const u=URL.createObjectURL(new Blob([b],{type:type||'application/octet-stream'}));
  const a=document.createElement('a');a.href=u;a.download=filename;a.style.display='none';document.documentElement.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),10000);
}

async function direct(c){
  if(c.nativeOnly||!c.exactFilename||!c.sandboxPath)throw Error('opaque artifact: native activation required');
  const t=await token(),u=await signedUrl(c,t);const r=await fetch(u,{cache:'no-store'});
  if(!r.ok)throw Error(`file HTTP ${r.status}`);
  const b=await r.arrayBuffer();validate(c.filename,b);saveFile(c.filename,b,r.headers.get('content-type'));
}

async function nativeActivate(el){
  if(!el||!document.contains(el))throw Error('native artifact control disappeared');

  try{el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})}catch(_){}
  try{el.focus({preventScroll:true})}catch(_){}

  // First try the element's own native click method.
  try{ if(typeof el.click==='function'){ el.click(); return; } }catch(_){}

  // React/Pressable variants may listen to a pointer/mouse sequence rather than
  // a bare synthetic click. Reproduce the common sequence as a fallback.
  const common={bubbles:true,cancelable:true,composed:true,view:window,button:0,buttons:1};
  try{el.dispatchEvent(new PointerEvent('pointerdown',{...common,pointerId:1,pointerType:'mouse',isPrimary:true}))}catch(_){}
  try{el.dispatchEvent(new MouseEvent('mousedown',common))}catch(_){}
  try{el.dispatchEvent(new PointerEvent('pointerup',{...common,buttons:0,pointerId:1,pointerType:'mouse',isPrimary:true}))}catch(_){}
  try{el.dispatchEvent(new MouseEvent('mouseup',{...common,buttons:0}))}catch(_){}
  try{el.dispatchEvent(new MouseEvent('click',{...common,buttons:0}))}catch(_){}
}

async function fallback(c){
  if(!c.el||!document.contains(c.el))throw Error('fallback control disappeared');
  if(c.el.tagName==='A'&&c.el.href){
    const a=document.createElement('a');a.href=c.el.href;
    if(c.exactFilename)a.download=c.filename;
    document.body.appendChild(a);a.click();a.remove();return;
  }
  await nativeActivate(c.el);
}

const ui={};
function setStatus(s){status=s;if(ui.status)ui.status.textContent=s;if(ui.icon)ui.icon.title=s}
function refresh(){
  if(!ui.icon)return;ui.icon.style.background=state.enabled?'#4CAF50':'#F44336';ui.icon.style.boxShadow=state.enabled?'0 0 12px #4CAF50':'0 4px 12px rgba(0,0,0,.35)';
  ui.count.textContent=state.infinite?`Downloaded: ${state.downloaded}/∞`:`Downloaded: ${state.downloaded}/${state.target}`;ui.input.value=state.target;ui.input.disabled=state.infinite;ui.inf.style.background=state.infinite?'#2f7d32':'#444';ui.status.textContent=status;
  if(ui.calibration)ui.calibration.textContent=calibration.pending?'🟡 Awaiting calibration reply':calibration.verified?'🟢 Workspace verified':calibration.directory?'🔵 Workspace learned (unverified)':'🟡 Workspace unknown';
}

async function handle(c,force=false){
  if(!c)return false;latest=c;const id=ident(c);if(!force&&(done.has(id)||busy.has(id))){scanEvent('already-handled-or-busy',diagnosticIdentity(c));return false}
  if(!state.infinite&&state.downloaded>=state.target){record('target-reached',{counter:state.downloaded});state.enabled=false;save();refresh();setStatus('target reached');return false}
  busy.add(id);setStatus(`trying ${c.filename} [${c.kind}]`);
  record('scraper-attempt',{...diagnosticIdentity(c),forced:!!force,route:c.nativeOnly?'native':'direct-then-native'});
  try{
    let err=null,verified=false,route='native';
    if(c.nativeOnly){
      record('native-fallback-start',{...diagnosticIdentity(c),cause:'opaque-artifact'});
      await fallback(c);
    }else{
      for(const wait of [0,800,1800]){
        if(wait)await new Promise(r=>setTimeout(r,wait));
        try{
          await direct(c);err=null;verified=true;route='direct';
          if(calibration.directory&&c.sandboxPath.startsWith(calibration.directory)&&!calibration.verified){
            calibration.verified=true;saveCalibration();record('calibration-verified',{directory:calibration.directory,file:c.filename});refresh();
          }
          break;
        }catch(e){err=e;record('direct-attempt-failed',{...diagnosticIdentity(c),reason:String(e.message||e),retryDelay:wait})}
      }
      if(err){
        if(calibration.directory&&c.sandboxPath.startsWith(calibration.directory)&&/interpreter\/download HTTP 404/.test(String(err))){
          calibration.verified=false;saveCalibration();record('calibration-unverified',{file:c.filename,reason:'path rejected HTTP 404'});refresh();
        }
        console.warn(LOG,'direct route failed, using native fallback:',String(err));
        record('native-fallback-start',{...diagnosticIdentity(c),cause:String(err.message||err)});await fallback(c)}
    }
    done.add(id);saveDone();state.downloaded++;save();refresh();
    record('scraper-result',{...diagnosticIdentity(c),route,verification:verified?'bytes-validated-download-triggered':'native-activation-unverified',
      counter:state.downloaded,credit:'v4.4-attempt-count'});
    setStatus(`${c.nativeOnly?'activated native':'downloaded'} ${c.filename} [${c.kind}]`);
    console.info(LOG,'handled',{filename:c.filename,label:c.label||'',kind:c.kind,nativeOnly:!!c.nativeOnly,messageId:c.messageId||'(missing)'});
    return true;
  }catch(e){record('scraper-error',{...diagnosticIdentity(c),reason:String(e.message||e)});setStatus(`FAILED ${c.filename}: ${e.message||e}`);console.error(LOG,e);return false}finally{busy.delete(id)}
}

async function scan(){
  if(!state.enabled)return;
  if(!initialized){armFromNow();return}
  const a=turns(),users=userTurns();
  // A newly submitted user message at the bottom arms a single fresh response.
  // Old user messages revealed through scrolling cannot arm a download.
  if(atConversationBottom())for(const u of users){
    const id=messageIdentity(u);
    if(id&&!seenUsers.has(id)){
      seenUsers.add(id);pendingUserId=id;pendingUserRoot=u;freshAssistants.clear();
      record('fresh-user-turn',{messageId:id});
    }
  }

  let inspected=0,found=0,blocked='',visiblePressables=0,visibleLinks=0;
  for(let i=a.length-1;i>=0;i--){
    const assistantId=messageIdentity(a[i]);
    if(!assistantId){blocked='assistant-missing-id';continue}
    if(seenAssistants.has(assistantId)&&!freshAssistants.has(assistantId)){blocked='previously-seen-assistant';continue}
    if(!pendingUserId||!atConversationBottom()){
      blocked=!pendingUserId?'no-fresh-user-turn':'not-at-conversation-bottom';
      seenAssistants.add(assistantId);continue;
    }
    const anchor=pendingUserRoot?.isConnected?pendingUserRoot:
      users.find(u=>messageIdentity(u)===pendingUserId);
    if(!anchor||!(anchor.compareDocumentPosition(a[i])&Node.DOCUMENT_POSITION_FOLLOWING)){
      blocked='assistant-not-after-fresh-user';
      seenAssistants.add(assistantId);continue;
    }
    seenAssistants.add(assistantId);
    // A new assistant response can stream for minutes before the file control
    // appears. Keep checking this response until its artifacts arrive.
    freshAssistants.add(assistantId);
    const cs=discover(a[i]);
    // Read-only renderer fingerprint for responses that never yield a file.
    // No message body or link URL is collected.
    visiblePressables+=a[i].querySelectorAll('[data-d-component="pressable"]').length;
    visibleLinks+=a[i].querySelectorAll('a,[role="link"]').length;
    inspected++;found+=cs.length;
    for(let j=cs.length-1;j>=0;j--){
      latest=cs[j];
      if(done.has(ident(cs[j]))||busy.has(ident(cs[j]))){scanEvent('candidate-already-handled',diagnosticIdentity(cs[j]));continue}
      record('candidate-eligible',diagnosticIdentity(cs[j]));
      await handle(cs[j]);return;
    }
  }

  scanEvent('no-action',{assistantTurns:a.length,userTurns:users.length,eligibleAssistants:inspected,candidates:found,
    visiblePressables,visibleLinks,freshAssistantIds:freshAssistants.size,pendingUser:!!pendingUserId,blocked});
  setStatus(a.length?'listening for NEW assistant artifacts':'waiting for assistant messages');
}
function schedule(ms=120){clearTimeout(scanDelay);scanDelay=setTimeout(()=>scan().catch(e=>{record('scan-error',{reason:String(e.message||e)});setStatus(`scan error: ${e.message||e}`)}),ms)}
function show(v){ui.panel.style.display=v?'flex':'none';ui.panel.style.opacity=v?'1':'0';ui.panel.style.transform=v?'translateX(0)':'translateX(8px)'}

function installUI(){
  document.getElementById(WID)?.remove();const host=document.createElement('div'),icon=document.createElement('div'),panel=document.createElement('div');host.id=WID;
  Object.assign(host.style,{position:'fixed',top:'34%',right:'8px',width:'38px',height:'38px',zIndex:'2147483647',fontFamily:'sans-serif',pointerEvents:'none'});
  icon.textContent='📦';Object.assign(icon.style,{width:'38px',height:'38px',borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'18px',cursor:'pointer',userSelect:'none',transition:'.18s',pointerEvents:'auto'});
  Object.assign(panel.style,{display:'none',position:'absolute',right:'46px',top:'0',flexDirection:'column',gap:'7px',width:'172px',background:'rgba(25,25,25,.97)',padding:'10px',borderRadius:'12px',color:'white',fontSize:'12px',boxShadow:'0 6px 18px rgba(0,0,0,.42)',opacity:'0',transform:'translateX(8px)',transition:'opacity .14s, transform .14s',pointerEvents:'auto'});
  const title=document.createElement('div');title.textContent=`ADAPTIVE FILE v${V}`;title.style.fontWeight='bold';const row=document.createElement('div');row.style.display='flex';row.style.gap='6px';
  const input=document.createElement('input');input.type='number';input.min='1';Object.assign(input.style,{width:'58px',background:'#333',border:'1px solid #555',color:'white',padding:'4px',borderRadius:'4px'});
  const inf=document.createElement('button');inf.textContent='∞';Object.assign(inf.style,{border:'1px solid #666',color:'white',padding:'3px 9px',borderRadius:'5px',cursor:'pointer',width:'33px',height:'28px'});
  const reset=document.createElement('button');reset.textContent='↻';reset.title='Reset counter';reset.setAttribute('aria-label','Reset counter');Object.assign(reset.style,{border:'1px solid #666',background:'#444',color:'white',padding:'3px',borderRadius:'5px',cursor:'pointer',width:'33px',height:'28px',fontSize:'17px'});
  const count=document.createElement('div');count.style.fontWeight='bold';const retry=document.createElement('button');retry.textContent='Retry latest file';const diag=document.createElement('button');diag.textContent='Scan / show renderer';
  const calib=document.createElement('button');calib.textContent='Calibrate this chat';calib.title='Insert a path request into this chat; press Send when ready.';
  const calibState=document.createElement('div');Object.assign(calibState.style,{fontSize:'10px',color:'#ccc'});
  const diagRow=document.createElement('div');Object.assign(diagRow.style,{display:'flex',gap:'5px'});
  const exportLog=document.createElement('button');exportLog.textContent='Export log';exportLog.title='Save diagnostic JSON';
  const clearLog=document.createElement('button');clearLog.textContent='Clear log';clearLog.title='Erase stored diagnostics for this conversation';
  for(const b of [retry,diag,calib,exportLog,clearLog])Object.assign(b.style,{background:'#444',border:'1px solid #666',color:'white',borderRadius:'6px',padding:'6px',cursor:'pointer',fontSize:'11px'});
  for(const b of [exportLog,clearLog])b.style.flex='1';diagRow.append(exportLog,clearLog);
  const stat=document.createElement('div');Object.assign(stat.style,{fontSize:'10px',lineHeight:'1.25',color:'#bbb',overflowWrap:'anywhere',maxHeight:'84px',overflow:'hidden'});
  row.append(input,inf,reset);panel.append(title,row,count,retry,diag,calib,calibState,diagRow,stat);host.append(icon,panel);document.documentElement.appendChild(host);Object.assign(ui,{host,icon,panel,input,inf,count,status:stat,calibration:calibState});
  icon.onmouseenter=()=>show(true);host.onmouseleave=()=>{if(!panelPinned)show(false)};
  icon.onclick=e=>{if(e.ctrlKey||e.metaKey){state.enabled=!state.enabled;record('capture-toggled',{enabled:state.enabled});if(state.enabled){initialized=false;armFromNow()}save();refresh();if(!state.enabled)setStatus('disabled');if(state.enabled)schedule(0);e.stopPropagation();return}panelPinned=!panelPinned;show(panelPinned)};
  input.onchange=()=>{state.target=Math.max(1,parseInt(input.value||'1',10)||45);save();refresh()};inf.onclick=()=>{state.infinite=!state.infinite;save();refresh()};reset.onclick=()=>{state.downloaded=0;save();refresh();setStatus('counter reset (file history retained)')};retry.onclick=()=>latest?handle(latest,true):schedule(0);
  diag.onclick=()=>{const a=turns(),cs=a.length?discover(a[a.length-1]):[];record('manual-scan',{assistantTurns:a.length,candidates:cs.length,kinds:cs.map(c=>c.kind)});console.table(cs.map(c=>({filename:c.filename,label:c.label||'',kind:c.kind,nativeOnly:!!c.nativeOnly,conversationId:c.conversationId,messageId:c.messageId,sandboxPath:c.sandboxPath||''})));setStatus(cs.length?`detected: ${cs.map(c=>c.kind).join(', ')}`:'no supported node in latest assistant turn')};
  calib.onclick=beginCalibration;
  exportLog.onclick=()=>{record('diagnostics-exported',{events:events.length});exportDiagnostics();setStatus(`exported ${events.length} diagnostic events`)};
  clearLog.onclick=()=>{events=[];dirty=true;scanSeen.clear();flushDiagnostics();setStatus('diagnostic log cleared')};refresh();
}

function boot(){
  installUI();new MutationObserver(()=>{if(state.enabled)schedule();if(calibration.pending)pollCalibration().catch(e=>record('calibration-error',{reason:String(e)}))}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-file-reference','data-d-component','role','aria-label','title','data-conversation-role','data-chatgpt-selection-message-id','data-dil-source-message-id','data-dil-message-id']});
  // Only trusted physical user clicks count as manual actions. Synthetic
  // scraper clicks are untrusted and never enter this lane or the UI counter.
  document.addEventListener('click',e=>{
    if(!e.isTrusted||e.target?.closest?.(`#${WID}`))return;
    const el=e.target?.closest?.('a,button,[role="link"],[role="button"],[data-file-reference="true"]');
    if(!el)return;const c=candidate(el);if(c)record('user-click-artifact-unverified',diagnosticIdentity(c));
  },true);
  // After a full page reload, baseline again. Never treat messages loaded by
  // the new document as new deliveries merely because their DOM is new.
  record('script-loaded',{enabled:state.enabled,previousCounter:state.downloaded});
  if(state.enabled){initialized=false;setStatus('waiting to baseline this page')}
  setInterval(()=>{if(state.enabled)schedule(0);if(calibration.pending)pollCalibration().catch(e=>record('calibration-error',{reason:String(e)}))},900);if(state.enabled)schedule(250);console.info(LOG,`v${V} active; new-deliveries-only mode.`);
}
if(document.body)boot();else new MutationObserver((_,o)=>{if(document.body){o.disconnect();boot()}}).observe(document.documentElement,{childList:true,subtree:true});
})();
