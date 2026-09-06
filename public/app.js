const $=id=>document.getElementById(id);
let history=[];
let voiceMode=false;
let voiceBusy=false;
let micStream=null;
let audioContext=null;
let analyser=null;
let mediaRecorder=null;
let monitorFrame=null;
let outputUrl=null;

function addMessage(text,role){const d=document.createElement('div');d.className=`msg ${role}`;d.textContent=text;$('messages').appendChild(d);$('messages').scrollTop=$('messages').scrollHeight}
function setStatus(t){$('status').textContent=t}
function setVoiceState(t){const el=$('voiceState');if(el)el.textContent=t}
async function jsonFetch(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||'Something went wrong');return d}

async function init(){try{const c=await fetch('/api/config',{cache:'no-store'}).then(r=>r.json());if(c.accessRequired&&!c.authenticated){$('access').classList.remove('hidden')}else startChat()}catch(e){$('accessError').textContent='TalkWise server is not available yet.'}}
function startChat(){$('access').classList.add('hidden');$('chatPanel').classList.remove('hidden');if(!history.length)addMessage("Hi. I’m TalkWise, an AI conversation partner informed by psychology and behavioural science—not a psychologist or doctor. What’s been on your mind?",'assistant')}

$('accessBtn').onclick=async()=>{try{$('accessError').textContent='';await jsonFetch('/api/session',{code:$('accessCode').value});startChat()}catch(e){$('accessError').textContent=e.message}};
$('accessCode').addEventListener('keydown',e=>{if(e.key==='Enter')$('accessBtn').click()});

async function getTalkWiseReply(message){
  const text=String(message||'').trim();
  if(!text)return '';
  addMessage(text,'user');
  setStatus('Thinking…');
  const d=await jsonFetch('/api/chat',{message:text,history,style:$('style').value,focus:$('focus').value,memories:[]});
  history.push({role:'user',content:text},{role:'assistant',content:d.reply});
  addMessage(d.reply,'assistant');
  return d.reply||'';
}

async function send(){
  const message=$('message').value.trim();if(!message)return;
  $('message').value='';$('send').disabled=true;
  try{await getTalkWiseReply(message);setStatus('Ready')}catch(e){addMessage(e.message,'assistant');setStatus('Error')}finally{$('send').disabled=false;$('message').focus()}
}
$('send').onclick=send;
$('message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});

function supportedMime(){
  const choices=['audio/webm;codecs=opus','audio/webm','audio/mp4'];
  return choices.find(t=>window.MediaRecorder?.isTypeSupported?.(t))||'';
}

function rmsLevel(){
  if(!analyser)return 0;
  const data=new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum=0;for(const v of data)sum+=v*v;
  return Math.sqrt(sum/data.length);
}

function friendlyMicError(e){
  if(e?.name==='NotAllowedError'||e?.name==='SecurityError')return 'Microphone permission is blocked. Click the microphone/site icon beside the address bar, set Microphone to Allow, refresh, and try again.';
  if(e?.name==='NotFoundError')return 'No microphone was found on this computer.';
  if(e?.name==='NotReadableError')return 'Your microphone is being used or blocked by another application.';
  return e?.message||'The microphone could not be started.';
}

async function startVoice(){
  if(voiceMode)return;
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('This browser cannot access a microphone on this page.');
    if(!window.MediaRecorder)throw new Error('This browser does not support microphone recording.');
    setVoiceState('Requesting microphone permission…');
    setStatus('Starting microphone…');
    $('voiceButton').disabled=true;
    micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    const AudioCtx=window.AudioContext||window.webkitAudioContext;
    audioContext=new AudioCtx();
    await audioContext.resume();
    const source=audioContext.createMediaStreamSource(micStream);
    analyser=audioContext.createAnalyser();
    analyser.fftSize=1024;
    analyser.smoothingTimeConstant=0.15;
    source.connect(analyser);
    voiceMode=true;
    $('voiceButton').classList.add('hidden');
    $('endVoice').classList.remove('hidden');
    setVoiceState('Listening — speak normally, then pause');
    setStatus('Listening — speak when you are ready');
    startListeningCycle();
  }catch(e){
    stopVoice(false);
    const msg=friendlyMicError(e);
    addMessage(`Voice could not start: ${msg}`,'assistant');
    setVoiceState(msg);setStatus('Voice unavailable');
  }finally{$('voiceButton').disabled=false;}
}

function startListeningCycle(){
  if(!voiceMode||voiceBusy||!micStream)return;
  const mime=supportedMime();
  const chunks=[];
  let speech=false;
  let speechStartedAt=0;
  let lastLoudAt=0;
  let startedAt=performance.now();
  let lastUi=0;
  let noiseSum=0,noiseCount=0,threshold=0.010;
  try{
    mediaRecorder=mime?new MediaRecorder(micStream,{mimeType:mime}):new MediaRecorder(micStream);
  }catch(e){
    addMessage(`Voice recording could not start: ${e.message}`,'assistant');stopVoice(false);setStatus('Voice unavailable');return;
  }
  mediaRecorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data)};
  mediaRecorder.onerror=e=>{addMessage(`Microphone recording error: ${e.error?.message||'unknown error'}`,'assistant');stopVoice(false)};
  mediaRecorder.onstop=async()=>{
    if(monitorFrame){cancelAnimationFrame(monitorFrame);monitorFrame=null}
    if(!voiceMode)return;
    if(!speech){setVoiceState('Listening — speak normally, then pause');setTimeout(startListeningCycle,150);return;}
    const blob=new Blob(chunks,{type:mediaRecorder?.mimeType||mime||'audio/webm'});
    await processVoiceTurn(blob);
  };
  mediaRecorder.start(200);

  const monitor=now=>{
    if(!voiceMode||!mediaRecorder||mediaRecorder.state==='inactive')return;
    const rms=rmsLevel();
    const elapsed=now-startedAt;
    if(elapsed<500){noiseSum+=rms;noiseCount++;}
    else if(noiseCount){
      const floor=noiseSum/noiseCount;
      threshold=Math.min(0.035,Math.max(0.008,floor*3.0));
      noiseCount=0;
    }
    const level=Math.min(100,Math.round(rms*1200));
    if(!speech&&now-lastUi>250){setVoiceState(`Listening — microphone level ${level}%`);lastUi=now;}
    if(rms>threshold){
      if(!speech){speech=true;speechStartedAt=now;setVoiceState('I hear you — keep speaking…');}
      lastLoudAt=now;
    }
    if(speech&&now-lastLoudAt>1100&&now-speechStartedAt>650){
      setVoiceState('Got it — processing what you said…');
      try{mediaRecorder.stop()}catch{}
      return;
    }
    if(!speech&&elapsed>20000){
      try{mediaRecorder.stop()}catch{}
      return;
    }
    monitorFrame=requestAnimationFrame(monitor);
  };
  monitorFrame=requestAnimationFrame(monitor);
}

async function parseErrorResponse(r,defaultMsg){
  try{const d=await r.json();return d.error||defaultMsg}catch{return defaultMsg}
}

async function transcribeBlob(blob){
  const r=await fetch('/api/voice/transcribe',{method:'POST',headers:{'Content-Type':blob.type||'audio/webm'},body:blob,cache:'no-store'});
  if(!r.ok)throw new Error(await parseErrorResponse(r,'TalkWise could not understand the microphone audio.'));
  const d=await r.json();return String(d.text||'').trim();
}

function browserSpeakFallback(text){
  return new Promise(resolve=>{
    if(!window.speechSynthesis){resolve();return}
    const u=new SpeechSynthesisUtterance(String(text||''));u.rate=1;u.pitch=1;u.volume=1;u.onend=resolve;u.onerror=resolve;window.speechSynthesis.speak(u);
  });
}

async function speakReply(text){
  setVoiceState('TalkWise is speaking…');setStatus('TalkWise is speaking…');
  try{
    const r=await fetch('/api/voice/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text}),cache:'no-store'});
    if(!r.ok)throw new Error(await parseErrorResponse(r,'Spoken reply could not be generated.'));
    const blob=await r.blob();
    if(outputUrl)URL.revokeObjectURL(outputUrl);
    outputUrl=URL.createObjectURL(blob);
    const audio=$('remoteAudio');audio.src=outputUrl;audio.volume=1;audio.muted=false;
    await new Promise((resolve,reject)=>{audio.onended=resolve;audio.onerror=()=>reject(new Error('Audio playback failed'));audio.play().catch(reject)});
  }catch(e){
    await browserSpeakFallback(text);
  }
}

async function processVoiceTurn(blob){
  voiceBusy=true;
  try{
    setVoiceState('Understanding what you said…');setStatus('Understanding…');
    const text=await transcribeBlob(blob);
    if(!text){setVoiceState('I did not catch any words. Try speaking a little louder.');return;}
    setVoiceState(`I heard: “${text}”`);
    const reply=await getTalkWiseReply(text);
    if(reply&&voiceMode)await speakReply(reply);
  }catch(e){
    addMessage(`Voice problem: ${e.message}`,'assistant');
    setVoiceState(e.message);setStatus('Voice problem');
  }finally{
    voiceBusy=false;
    if(voiceMode){setVoiceState('Listening — speak normally, then pause');setStatus('Listening — speak when you are ready');setTimeout(startListeningCycle,250)}
  }
}

function stopVoice(resetStatus=true){
  voiceMode=false;voiceBusy=false;
  if(monitorFrame){cancelAnimationFrame(monitorFrame);monitorFrame=null}
  if(mediaRecorder&&mediaRecorder.state!=='inactive'){try{mediaRecorder.stop()}catch{}}
  mediaRecorder=null;
  if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null}
  if(audioContext){try{audioContext.close()}catch{}audioContext=null}
  analyser=null;
  const audio=$('remoteAudio');try{audio.pause();audio.removeAttribute('src');audio.load()}catch{}
  if(outputUrl){URL.revokeObjectURL(outputUrl);outputUrl=null}
  try{window.speechSynthesis?.cancel?.()}catch{}
  $('voiceButton').classList.remove('hidden');$('endVoice').classList.add('hidden');
  setVoiceState('Voice off');if(resetStatus)setStatus('Ready');
}

$('voiceButton').onclick=startVoice;
$('endVoice').onclick=()=>stopVoice(true);
window.addEventListener('beforeunload',()=>stopVoice(false));

init();
