const $ = id => document.getElementById(id);
let history = [];
let pc = null;
let dc = null;
let micStream = null;
let voiceActive = false;

function addMessage(text, role) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  d.textContent = text;
  $('messages').appendChild(d);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function setStatus(text) { $('status').textContent = text; }
function setVoiceState(text) { $('voiceState').textContent = text; }
async function jsonFetch(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}

async function init() {
  try {
    const c = await fetch('/api/config', { cache: 'no-store' }).then(r => r.json());
    if (c.accessRequired && !c.authenticated) $('access').classList.remove('hidden');
    else startChat();
  } catch {
    $('accessError').textContent = 'TalkWise server is not available yet.';
  }
}

function startChat() {
  $('access').classList.add('hidden');
  $('chatPanel').classList.remove('hidden');
  if (!history.length) {
    addMessage("Hi. I’m TalkWise, an AI conversation partner informed by psychology and behavioural science—not a psychologist or doctor. What’s been on your mind?", 'assistant');
  }
}

$('accessBtn').onclick = async () => {
  try {
    $('accessError').textContent = '';
    await jsonFetch('/api/session', { code: $('accessCode').value });
    startChat();
  } catch (e) {
    $('accessError').textContent = e.message;
  }
};
$('accessCode').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('accessBtn').click();
});

async function getTalkWiseReply(message) {
  const text = String(message || '').trim();
  if (!text) return '';
  addMessage(text, 'user');
  setStatus('Thinking…');
  const d = await jsonFetch('/api/chat', {
    message: text,
    history,
    style: $('style').value,
    focus: $('focus').value,
    memories: []
  });
  history.push({ role: 'user', content: text }, { role: 'assistant', content: d.reply });
  addMessage(d.reply, 'assistant');
  return d.reply || '';
}

async function send() {
  const message = $('message').value.trim();
  if (!message) return;
  $('message').value = '';
  $('send').disabled = true;
  try {
    await getTalkWiseReply(message);
    setStatus('Ready');
  } catch (e) {
    addMessage(e.message, 'assistant');
    setStatus('Error');
  } finally {
    $('send').disabled = false;
    $('message').focus();
  }
}
$('send').onclick = send;
$('message').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

function voiceErrorMessage(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
    return 'Microphone permission is blocked. Allow the microphone for this site in Edge, then try again.';
  }
  if (e?.name === 'NotFoundError') return 'No microphone was found on this computer.';
  if (e?.name === 'NotReadableError') return 'The microphone is unavailable or being used by another application.';
  return e?.message || 'Voice could not start.';
}

function handleRealtimeEvent(raw) {
  let event;
  try { event = JSON.parse(raw); } catch { return; }
  if (event.type === 'input_audio_buffer.speech_started') {
    setVoiceState('Listening…');
    setStatus('Listening…');
  } else if (event.type === 'input_audio_buffer.speech_stopped') {
    setVoiceState('Thinking…');
    setStatus('Thinking…');
  } else if (event.type === 'response.created') {
    setVoiceState('TalkWise is responding…');
  } else if (event.type === 'response.done') {
    setVoiceState('Connected — speak naturally');
    setStatus('Voice live');
  } else if (event.type === 'error') {
    const msg = event.error?.message || 'Realtime voice error.';
    setVoiceState(msg);
    setStatus('Voice problem');
  }
}

async function startVoice() {
  if (voiceActive) return endVoice();
  $('voiceButton').disabled = true;
  setVoiceState('Connecting live voice…');
  setStatus('Connecting voice…');
  try {
    const tokenResponse = await fetch(`/api/realtime/token?style=${encodeURIComponent($('style').value)}&focus=${encodeURIComponent($('focus').value)}`, { cache: 'no-store' });
    let tokenData = {};
    try { tokenData = await tokenResponse.json(); } catch {}
    if (!tokenResponse.ok) throw new Error(tokenData.error || 'Could not create a voice session.');
    const ephemeralKey = tokenData.value;
    if (!ephemeralKey) throw new Error('The voice session token was not returned.');

    pc = new RTCPeerConnection();
    const audio = $('remoteAudio');
    audio.autoplay = true;
    audio.controls = false;
    pc.ontrack = e => {
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {
        setVoiceState('Voice is connected. Click anywhere on the page once if Edge blocks audio playback.');
      });
    };

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const track = micStream.getAudioTracks()[0];
    if (!track) throw new Error('No microphone audio track was available.');
    pc.addTrack(track, micStream);

    dc = pc.createDataChannel('oai-events');
    dc.onopen = () => {
      voiceActive = true;
      $('voiceButton').textContent = 'End voice conversation';
      $('voiceButton').classList.add('recording');
      setVoiceState(`Connected to ${track.label || 'your microphone'} — speak naturally`);
      setStatus('Voice live');
    };
    dc.onmessage = e => handleRealtimeEvent(e.data);
    dc.onerror = () => {
      setVoiceState('The live voice data connection encountered an error.');
      setStatus('Voice problem');
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setVoiceState('The live voice connection was interrupted.');
        setStatus('Voice problem');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        'Content-Type': 'application/sdp'
      }
    });
    const answerSdp = await sdpResponse.text();
    if (!sdpResponse.ok) throw new Error(`OpenAI voice connection failed (${sdpResponse.status}). ${answerSdp.slice(0, 220)}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  } catch (e) {
    endVoice(false);
    const msg = voiceErrorMessage(e);
    addMessage(`Voice problem: ${msg}`, 'assistant');
    setVoiceState(msg);
    setStatus('Voice problem');
  } finally {
    $('voiceButton').disabled = false;
  }
}

function endVoice(reset = true) {
  voiceActive = false;
  try { dc?.close(); } catch {}
  dc = null;
  try { pc?.close(); } catch {}
  pc = null;
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  const audio = $('remoteAudio');
  try {
    audio.pause();
    audio.srcObject = null;
  } catch {}
  $('voiceButton').textContent = '🎙 Start voice conversation';
  $('voiceButton').classList.remove('recording');
  if (reset) {
    setVoiceState('Voice off');
    setStatus('Ready');
  }
}

$('voiceButton').onclick = startVoice;
window.addEventListener('beforeunload', () => endVoice(false));

init();
