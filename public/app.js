const $=id=>document.getElementById(id);
let history=[];
let pc=null, localStream=null, dataChannel=null;

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

function handleRealtime(raw){
  let e;try{e=JSON.parse(raw)}catch{return}
  if(e.type==='conversation.item.input_audio_transcription.completed'&&e.transcript?.trim()){
    const t=e.transcript.trim(); history.push({role:'user',content:t}); addMessage(t,'user');
  }
  if((e.type==='response.output_audio_transcript.done'||e.type==='response.output_audio_transcript.delta')&&e.transcript?.trim()){
    if(e.type==='response.output_audio_transcript.done'){
      const t=e.transcript.trim(); history.push({role:'assistant',content:t}); addMessage(t,'assistant');
    }
  }
  if(e.type==='input_audio_buffer.speech_started') setStatus('Listening…');
  if(e.type==='response.created') setStatus('Thinking…');
  if(e.type==='response.done') setStatus('Voice live');
}

async function startVoice(){
  if(pc)return;
  try{
    setStatus('Starting microphone…');
    $('voiceButton').disabled=true;
    pc=new RTCPeerConnection();
    localStream=await navigator.mediaDevices.getUserMedia({audio:true});
    localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
    pc.ontrack=e=>{$('remoteAudio').srcObject=e.streams[0]; $('remoteAudio').play().catch(()=>{});};
    dataChannel=pc.createDataChannel('oai-events');
    dataChannel.onopen=()=>setStatus('Voice live — start speaking');
    dataChannel.onmessage=e=>handleRealtime(e.data);
    dataChannel.onerror=()=>setStatus('Voice connection issue');
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r=await fetch('/api/realtime/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sdp:offer.sdp,style:$('style').value,focus:$('focus').value,memories:[]})});
    if(!r.ok){let d={};try{d=await r.json()}catch{}throw new Error(d.error||'Voice could not start')}
    const sdp=await r.text();
    await pc.setRemoteDescription({type:'answer',sdp});
    $('voiceButton').classList.add('hidden');
    $('endVoice').classList.remove('hidden');
  }catch(e){
    stopVoice();
    addMessage(`Voice could not start: ${e.message}`,'assistant');
    setStatus('Voice unavailable');
  }finally{$('voiceButton').disabled=false;}
}
function stopVoice(){
  if(localStream)localStream.getTracks().forEach(t=>t.stop());
  if(dataChannel)try{dataChannel.close()}catch{}
  if(pc)try{pc.close()}catch{}
  pc=null;localStream=null;dataChannel=null;
  $('remoteAudio').srcObject=null;
  $('voiceButton').classList.remove('hidden');
  $('endVoice').classList.add('hidden');
  setStatus('Ready');
}
$('voiceButton').onclick=startVoice;
$('endVoice').onclick=stopVoice;
window.addEventListener('beforeunload',stopVoice);

init();
