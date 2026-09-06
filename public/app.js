const $ = id => document.getElementById(id);
let history = [];
let micStream = null;
let mediaRecorder = null;
let chunks = [];
let outputUrl = null;
let recording = false;
let processing = false;

function addMessage(text, role) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  d.textContent = text;
  $('messages').appendChild(d);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function setStatus(text) { $('status').textContent = text; }
function setVoiceState(text) { const el = $('voiceState'); if (el) el.textContent = text; }
async function jsonFetch(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  if (!history.length) addMessage("Hi. I’m TalkWise, an AI conversation partner informed by psychology and behavioural science—not a psychologist or doctor. What’s been on your mind?", 'assistant');
}

$('accessBtn').onclick = async () => {
  try {
    $('accessError').textContent = '';
    await jsonFetch('/api/session', { code: $('accessCode').value });
    startChat();
  } catch (e) { $('accessError').textContent = e.message; }
};
$('accessCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('accessBtn').click(); });

async function getTalkWiseReply(message, voice = false) {
  const text = String(message || '').trim();
  if (!text) return '';
  addMessage(text, 'user');
  setStatus('Thinking…');
  const d = await jsonFetch('/api/chat', {
    message: text,
    history,
    style: $('style').value,
    focus: $('focus').value,
    memories: [],
    voice
  });
  history.push({ role: 'user', content: text }, { role: 'assistant', content: d.reply });
  addMessage(d.reply, 'assistant');
  return d.reply || '';
}

async function send() {
  const message = $('message').value.trim();
  if (!message || processing) return;
  $('message').value = '';
  $('send').disabled = true;
  try {
    await getTalkWiseReply(message, false);
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
$('message').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

function supportedMime() {
  const choices = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return choices.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}
function friendlyMicError(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return 'Microphone permission is blocked. Click the microphone/site icon beside the address bar, set Microphone to Allow, refresh, and try again.';
  if (e?.name === 'NotFoundError') return 'No microphone was found on this computer.';
  if (e?.name === 'NotReadableError') return 'Your microphone is being used or blocked by another application.';
  return e?.message || 'The microphone could not be started.';
}

async function beginRecording() {
  if (processing || recording) return;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a microphone on this page.');
    if (!window.MediaRecorder) throw new Error('This browser cannot record microphone audio.');

    setVoiceState('Opening microphone…');
    setStatus('Opening microphone…');
    $('voiceButton').disabled = true;

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = micStream.getAudioTracks()[0];
    if (!track) throw new Error('No microphone audio track was found.');

    chunks = [];
    const mime = supportedMime();
    mediaRecorder = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream);
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onerror = e => finishWithVoiceError(e.error?.message || 'Microphone recording failed.');
    mediaRecorder.onstop = processRecording;
    mediaRecorder.start();

    recording = true;
    $('voiceButton').textContent = '⏹ Stop & send';
    $('voiceButton').classList.add('recording');
    setVoiceState(`Recording from ${track.label || 'your microphone'} — speak now, then click Stop & send`);
    setStatus('Recording — speak now');
  } catch (e) {
    cleanupMic();
    finishWithVoiceError(friendlyMicError(e));
  } finally {
    $('voiceButton').disabled = false;
  }
}

function stopAndSend() {
  if (!recording || !mediaRecorder || processing) return;
  recording = false;
  processing = true;
  $('voiceButton').disabled = true;
  $('voiceButton').textContent = 'Processing…';
  setVoiceState('Sending your recording…');
  setStatus('Processing your voice…');
  try { mediaRecorder.stop(); } catch (e) { finishWithVoiceError(e.message || 'Could not stop the recording.'); }
}

function cleanupMic() {
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  mediaRecorder = null;
}

async function parseErrorResponse(r, defaultMsg) {
  try { const d = await r.json(); return d.error || defaultMsg; } catch { return defaultMsg; }
}

async function transcribeBlob(blob) {
  const r = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
    cache: 'no-store'
  });
  if (!r.ok) throw new Error(await parseErrorResponse(r, 'TalkWise could not understand the recording.'));
  const d = await r.json();
  return String(d.text || '').trim();
}

async function speakReply(text) {
  setVoiceState('TalkWise is preparing its spoken reply…');
  const r = await fetch('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    cache: 'no-store'
  });
  if (!r.ok) throw new Error(await parseErrorResponse(r, 'TalkWise could not generate spoken audio.'));
  const blob = await r.blob();
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = URL.createObjectURL(blob);
  const audio = $('remoteAudio');
  audio.src = outputUrl;
  audio.controls = true;
  audio.muted = false;
  audio.volume = 1;
  setVoiceState('TalkWise is speaking…');
  setStatus('TalkWise is speaking…');
  try {
    await new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onerror = () => reject(new Error('Audio playback failed.'));
      const p = audio.play();
      if (p) p.catch(reject);
    });
  } catch {
    setVoiceState('Reply ready — press Play below if your browser blocked automatic audio.');
  }
}

async function processRecording() {
  try {
    const mime = mediaRecorder?.mimeType || supportedMime() || 'audio/webm';
    const blob = new Blob(chunks, { type: mime });
    cleanupMic();
    if (blob.size < 1200) throw new Error('The recording was too short. Click Start talking, speak for a moment, then click Stop & send.');

    setVoiceState('Transcribing what you said…');
    const transcript = await transcribeBlob(blob);
    if (!transcript) throw new Error('I did not hear any words in that recording.');

    setVoiceState(`I heard: “${transcript}”`);
    const reply = await getTalkWiseReply(transcript, true);
    if (reply) await speakReply(reply);
    if ($('voiceState').textContent === 'TalkWise is speaking…') setVoiceState('Ready for another turn.');
    setStatus('Ready');
  } catch (e) {
    addMessage(`Voice problem: ${e.message}`, 'assistant');
    setVoiceState(e.message);
    setStatus('Voice problem');
  } finally {
    processing = false;
    recording = false;
    cleanupMic();
    $('voiceButton').disabled = false;
    $('voiceButton').textContent = '🎙 Start talking';
    $('voiceButton').classList.remove('recording');
  }
}

function finishWithVoiceError(message) {
  processing = false;
  recording = false;
  cleanupMic();
  addMessage(`Voice problem: ${message}`, 'assistant');
  setVoiceState(message);
  setStatus('Voice problem');
  $('voiceButton').disabled = false;
  $('voiceButton').textContent = '🎙 Start talking';
  $('voiceButton').classList.remove('recording');
}

$('voiceButton').onclick = () => recording ? stopAndSend() : beginRecording();
window.addEventListener('beforeunload', () => {
  cleanupMic();
  if (outputUrl) URL.revokeObjectURL(outputUrl);
});

init();
