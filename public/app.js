const $=id=>document.getElementById(id);
let history=[];

function addMessage(text,role){const d=document.createElement('div');d.className=`msg ${role}`;d.textContent=text;$('messages').appendChild(d);$('messages').scrollTop=$('messages').scrollHeight}
function setStatus(t){$('status').textContent=t}
async function jsonFetch(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||'Something went wrong');return d}

async function init(){try{const c=await fetch('/api/config').then(r=>r.json());if(c.accessRequired&&!c.authenticated){$('access').classList.remove('hidden')}else startChat()}catch(e){$('accessError').textContent='TalkWise server is not available yet.'}}
function startChat(){$('access').classList.add('hidden');$('chatPanel').classList.remove('hidden');if(!history.length)addMessage("Hi. I’m TalkWise, an AI conversation partner informed by psychology and behavioural science—not a psychologist or doctor. What’s been on your mind?",'assistant')}

$('accessBtn').onclick=async()=>{try{$('accessError').textContent='';await jsonFetch('/api/session',{code:$('accessCode').value});startChat()}catch(e){$('accessError').textContent=e.message}};
$('accessCode').addEventListener('keydown',e=>{if(e.key==='Enter')$('accessBtn').click()});

async function send(){const message=$('message').value.trim();if(!message)return;$('message').value='';addMessage(message,'user');setStatus('Thinking…');$('send').disabled=true;try{const d=await jsonFetch('/api/chat',{message,history,style:$('style').value,focus:$('focus').value,memories:[]});history.push({role:'user',content:message},{role:'assistant',content:d.reply});addMessage(d.reply,'assistant');setStatus(d.crisis?'Safety support mode':'Ready')}catch(e){addMessage(e.message,'assistant');setStatus('Error')}finally{$('send').disabled=false;$('message').focus()}}
$('send').onclick=send;
$('message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});

init();
