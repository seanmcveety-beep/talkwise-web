const $ = id => document.getElementById(id);
let history = [];
let micStream = null;
let mediaRecorder = null;
let chunks = [];
let outputUrl = null;
let recording = false;
let processing = false;
let audioContext = null;
let analyser = null;
let meterFrame = null;
let recordingPeak = 0;
let selectedMicId = '';
let lastMicLabel = '';

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
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => refreshMicrophoneList(false));
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
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'The selected microphone is not available. Choose another microphone and try again.';
  if (e?.name === 'NotReadableError') return 'Your microphone is being used or blocked by another application.';
  return e?.message || 'The microphone could not be started.';
}
function isLikelyVirtualMic(label) {
  return /(stereo mix|virtual|vb-audio|cable|loopback|what u hear|voicemeeter)/i.test(label || '');
}
function micPreferenceScore(label) {
  const s = String(label || '').toLowerCase();
  let score = 0;
  if (/microphone array|internal|built[- ]?in/.test(s)) score += 8;
  if (/realtek|intel|smart sound/.test(s)) score += 5;
  if (/headset|headphone/.test(s)) score += 4;
  if (/webcam|camera/.test(s)) score += 2;
  if (isLikelyVirtualMic(s)) score -= 20;
  return score;
}

async function refreshMicrophoneList(requestPermission = true) {
  const select = $('micSelect');
  if (!select || !navigator.mediaDevices?.enumerateDevices) return [];
  let permissionStream = null;
  try {
    if (requestPermission) permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const previous = selectedMicId || select.value;
    select.innerHTML = '';
    for (const [i, d] of devices.entries()) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${i + 1}`;
      select.appendChild(o);
    }
    if (!devices.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No microphone found';
      select.appendChild(o);
      return [];
    }
    let chosen = devices.find(d => d.deviceId === previous);
    if (!chosen) chosen = [...devices].sort((a, b) => micPreferenceScore(b.label) - micPreferenceScore(a.label))[0];
    select.value = chosen?.deviceId || devices[0].deviceId;
    selectedMicId = select.value;
    return devices;
  } finally {
    if (permissionStream) permissionStream.getTracks().forEach(t => t.stop());
  }
}

$('micSelect')?.addEventListener('change', () => {
  selectedMicId = $('micSelect').value;
  const label = $('micSelect').selectedOptions?.[0]?.textContent || 'selected microphone';
  setVoiceState(`Microphone selected: ${label}`);
});

async function openSelectedMicrophone() {
  const devices = await refreshMicrophoneList(true);
  if (!devices.length) throw new DOMException('No microphone was found.', 'NotFoundError');
  const deviceId = $('micSelect')?.value || selectedMicId;
  const constraints = {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    }
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

function startMeter(stream, track) {
  stopMeter();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  audioContext = new AudioCtx();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.1;
  source.connect(analyser);
  recordingPeak = 0;
  const data = new Float32Array(analyser.fftSize);
  const label = track?.label || $('micSelect')?.selectedOptions?.[0]?.textContent || 'microphone';
  lastMicLabel = label;
  const tick = () => {
    if (!recording || !analyser) return;
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const x of data) sum += x * x;
    const rms = Math.sqrt(sum / data.length);
    recordingPeak = Math.max(recordingPeak, rms);
    const pct = Math.min(100, Math.round(rms * 1600));
    setVoiceState(`Recording from ${label} — microphone level ${pct}%`);
    meterFrame = requestAnimationFrame(tick);
  };
  tick();
}
function stopMeter() {
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;
  analyser = null;
  if (audioContext) {
    try { audioContext.close(); } catch {}
    audioContext = null;
  }
}

async function beginRecording() {
  if (processing || recording) return;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a microphone on this page.');
    if (!window.MediaRecorder) throw new Error('This browser cannot record microphone audio.');
    setVoiceState('Checking your microphone…');
    setStatus('Opening microphone…');
    $('voiceButton').disabled = true;
    micStream = await openSelectedMicrophone();
    const track = micStream.getAudioTracks()[0];
    if (!track) throw new Error('No microphone audio track was found.');
    chunks = [];
    const mime = supportedMime();
    mediaRecorder = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream);
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onerror = e => finishWithVoiceError(e.error?.message || 'Microphone recording failed.');
    mediaRecorder.onstop = processRecording;
    mediaRecorder.start(200);
    recording = true;
    $('voiceButton').textContent = '⏹ Stop & send';
    $('voiceButton').classList.add('recording');
    setStatus('Recording — speak now');
    startMeter(micStream, track);
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
  stopMeter();
  $('voiceButton').disabled = true;
  $('voiceButton').textContent = 'Processing…';
  setVoiceState('Checking the recording…');
  setStatus('Processing your voice…');
  try { mediaRecorder.stop(); } catch (e) { finishWithVoiceError(e.message || 'Could not stop the recording.'); }
}

function cleanupMic() {
  stopMeter();
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

function nextMicrophoneId() {
  const select = $('micSelect');
  if (!select || select.options.length < 2) return '';
  const current = select.selectedIndex;
  for (let step = 1; step < select.options.length; step++) {
    const idx = (current + step) % select.options.length;
    const opt = select.options[idx];
    if (opt?.value && !isLikelyVirtualMic(opt.textContent)) return opt.value;
  }
  return '';
}

async function processRecording() {
  try {
    const mime = mediaRecorder?.mimeType || supportedMime() || 'audio/webm';
    const blob = new Blob(chunks, { type: mime });
    const peak = recordingPeak;
    cleanupMic();
    if (blob.size < 1500) throw new Error('The recording was too short. Speak for at least one full sentence before clicking Stop & send.');
    if (peak < 0.0018) {
      const next = nextMicrophoneId();
      if (next) {
        $('micSelect').value = next;
        selectedMicId = next;
        const nextLabel = $('micSelect').selectedOptions?.[0]?.textContent || 'another microphone';
        throw new Error(`I detected almost no sound from ${lastMicLabel || 'that microphone'}. I switched to ${nextLabel}. Click Start talking and try once more.`);
      }
      throw new Error(`I detected almost no sound from ${lastMicLabel || 'the selected microphone'}. Choose another microphone above, then try again.`);
    }
    setVoiceState('Transcribing what you said…');
    const transcript = await transcribeBlob(blob);
    if (!transcript) throw new Error('I received microphone audio but could not identify any words. Try again with the microphone closer to you.');
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
