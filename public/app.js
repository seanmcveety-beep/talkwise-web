const $=id=>document.getElementById(id);
let history=[];
let recognition=null;
let voiceMode=false;
let voiceBusy=false;
let lastSpoken='';

function addMessage(text,role){const d=document.createElement('div');d.className=`msg ${role}`;d.textContent=text;$('messages').appendChild(d);$('messages').scrollTop=$('messages').scrollHeight}
function setStatus(t){$('status').textContent=t}
async function jsonFetch(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||'Something went wrong');return d}

async function init(){try{const c=await fetch('/api/config',{cache:'no-store'}).then(r=>r.json());if(c.accessRequired&&!c.authenticated){$('access').classList.remove('hidden')}else startChat()}catch(e){$('accessError').textContent='TalkWise server is not available yet.'}}
function startChat(){$('access').classList.add('hidden');$('chatPanel').classList.remove('hidden');if(!history.length)addMessage("Hi. I’m TalkWise, an AI conversation partner informed by psychology and behavioural science—not a psychologist or doctor. What’s been on your mind?",'assistant')}

$('accessBtn').onclick=async()=>{try{$('accessError').textContent='';await jsonFetch('/api/session',{code:$('accessCode').value});startChat()}catch(e){$('accessError').textContent=e.message}};
$('accessCode').addEventListener('keydown',e=>{if(e.key==='Enter')$('accessBtn').click()});

async function askTalkWise(message,{speak=false}={}){
  const text=String(message||'').trim();
  if(!text)return;
  addMessage(text,'user');
  setStatus('Thinking…');
  voiceBusy=true;
  $('send').disabled=true;
  try{
    const d=await jsonFetch('/api/chat',{message:text,history,style:$('style').value,focus:$('focus').value,memories:[]});
    history.push({role:'user',content:text},{role:'assistant',content:d.reply});
    addMessage(d.reply,'assistant');
    if(speak&&voiceMode){
      await speakText(d.reply);
    }
    setStatus(voiceMode?'Listening — speak when you are ready':'Ready');
  }catch(e){
    addMessage(e.message,'assistant');
    setStatus('Error');
  }finally{
    voiceBusy=false;
    $('send').disabled=false;
    if(voiceMode)restartRecognitionSoon(); else $('message').focus();
  }
}

async function send(){const message=$('message').value.trim();if(!message)return;$('message').value='';await askTalkWise(message,{speak:false})}
$('send').onclick=send;
$('message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});

function getRecognitionCtor(){return window.SpeechRecognition||window.webkitSpeechRecognition||null}

function preferredVoice(){
  const voices=window.speechSynthesis?.getVoices?.()||[];
  return voices.find(v=>/Microsoft.*(Ava|Jenny|Aria|Guy|Ryan|Sonia)/i.test(v.name)&&/^en/i.test(v.lang))
    ||voices.find(v=>/^en-CA$/i.test(v.lang))
    ||voices.find(v=>/^en/i.test(v.lang))
    ||null;
}

function speakText(text){
  return new Promise(resolve=>{
    if(!voiceMode||!window.speechSynthesis){resolve();return}
    window.speechSynthesis.cancel();
    recognition?.abort?.();
    const u=new SpeechSynthesisUtterance(String(text||''));
    const v=preferredVoice();if(v)u.voice=v;
    u.rate=1.0;u.pitch=1.0;u.volume=1.0;
    u.onstart=()=>setStatus('TalkWise is speaking…');
    u.onend=()=>resolve();
    u.onerror=()=>resolve();
    window.speechSynthesis.speak(u);
  });
}

function buildRecognition(){
  const Ctor=getRecognitionCtor();
  if(!Ctor)throw new Error('Speech recognition is not available in this browser. Please use current Microsoft Edge or Google Chrome.');
  const r=new Ctor();
  r.lang='en-CA';
  r.continuous=false;
  r.interimResults=true;
  r.maxAlternatives=1;
  r.onstart=()=>setStatus('Listening — speak when you are ready');
  r.onspeechstart=()=>setStatus('Listening — I hear you…');
  r.onresult=e=>{
    let finalText='';let interim='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      const t=e.results[i][0]?.transcript||'';
      if(e.results[i].isFinal)finalText+=t;else interim+=t;
    }
    if(interim.trim())setStatus(`I hear: ${interim.trim()}`);
    if(finalText.trim()&&!voiceBusy){
      lastSpoken=finalText.trim();
      setStatus(`I heard: ${lastSpoken}`);
      r.stop();
      askTalkWise(lastSpoken,{speak:true});
    }
  };
  r.onerror=e=>{
    if(!voiceMode)return;
    if(e.error==='no-speech'){setStatus('Listening — speak when you are ready');return}
    if(e.error==='aborted')return;
    if(e.error==='not-allowed'||e.error==='service-not-allowed'){
      voiceMode=false;
      $('voiceButton').classList.remove('hidden');
      $('endVoice').classList.add('hidden');
      addMessage('Voice could not start because microphone or speech recognition permission was blocked. Allow microphone access for this site, refresh, and try again.','assistant');
      setStatus('Voice unavailable');
      return;
    }
    addMessage(`Voice recognition error: ${e.error}`,'assistant');
    setStatus('Voice recognition issue');
  };
  r.onend=()=>{if(voiceMode&&!voiceBusy)restartRecognitionSoon()};
  return r;
}

function restartRecognitionSoon(){
  if(!voiceMode||voiceBusy)return;
  setTimeout(()=>{
    if(!voiceMode||voiceBusy)return;
    try{
      recognition=buildRecognition();
      recognition.start();
    }catch(e){
      addMessage(`Voice could not start: ${e.message}`,'assistant');
      stopVoice(false);
      setStatus('Voice unavailable');
    }
  },350);
}

async function startVoice(){
  if(voiceMode)return;
  try{
    const Ctor=getRecognitionCtor();
    if(!Ctor)throw new Error('Speech recognition is not available in this browser. Please use current Microsoft Edge or Google Chrome.');
    voiceMode=true;
    $('voiceButton').classList.add('hidden');
    $('endVoice').classList.remove('hidden');
    setStatus('Starting microphone…');
    recognition=buildRecognition();
    recognition.start();
  }catch(e){
    voiceMode=false;
    $('voiceButton').classList.remove('hidden');
    $('endVoice').classList.add('hidden');
    addMessage(`Voice could not start: ${e.message}`,'assistant');
    setStatus('Voice unavailable');
  }
}

function stopVoice(resetStatus=true){
  voiceMode=false;
  voiceBusy=false;
  try{recognition?.abort?.()}catch{}
  recognition=null;
  try{window.speechSynthesis?.cancel?.()}catch{}
  $('voiceButton').classList.remove('hidden');
  $('endVoice').classList.add('hidden');
  if(resetStatus)setStatus('Ready');
}

$('voiceButton').onclick=startVoice;
$('endVoice').onclick=()=>stopVoice(true);
window.addEventListener('beforeunload',()=>stopVoice(false));
if(window.speechSynthesis)window.speechSynthesis.onvoiceschanged=()=>window.speechSynthesis.getVoices();

init();
