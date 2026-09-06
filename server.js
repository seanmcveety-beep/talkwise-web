'use strict';
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-5.6-terra';
const VOICE_MODEL = process.env.OPENAI_VOICE_MODEL || 'gpt-realtime-2.1';
const VOICE = process.env.OPENAI_VOICE || 'marin';
const ACCESS_CODE = process.env.TALKWISE_ACCESS_CODE || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MASTER_PROMPT = fs.readFileSync(path.join(__dirname, 'agent_prompt.md'), 'utf8');

const CRISIS_PATTERN = /\b(kill myself|suicide|suicidal|end my life|want to die|hurt myself|self[- ]?harm|overdose|kill (him|her|them|someone)|hurt (him|her|them|someone)|can'?t keep myself safe)\b/i;
const stylePrompts = {
  reflective: `CONVERSATIONAL STYLE — REFLECTIVE ANALYST:\nBe calm, perceptive, curious, and psychologically sophisticated. Explore patterns and assumptions. Prefer one meaningful question at a time.`,
  warm: `CONVERSATIONAL STYLE — WARM GUIDE:\nBe especially warm, patient, encouraging, and emotionally attuned while remaining substantive. Do not become saccharine or automatically agree.`,
  direct: `CONVERSATIONAL STYLE — DIRECT CHALLENGER:\nBe candid, concise, and willing to challenge contradictions, avoidance, rationalization, and self-defeating patterns. Remain respectful and non-shaming.`,
  philosophical: `CONVERSATIONAL STYLE — PHILOSOPHICAL COMPANION:\nDraw more often on philosophy, meaning, values, mortality, freedom, responsibility, and the humanities. Stay practical and conversational rather than academic.`
};
const focusPrompts = {
  open: '',
  decision: `\n\nSESSION FOCUS — DECISION: Help clarify the decision, competing values, realistic options, uncertainty, trade-offs, reversible vs irreversible choices, and a practical next step. Do not make the decision for the user.`,
  relationship: `\n\nSESSION FOCUS — RELATIONSHIP: Pay close attention to communication, attachment, boundaries, assumptions about intent, patterns between people, unmet needs, responsibility, and what can actually be said or done.`,
  work: `\n\nSESSION FOCUS — WORK: Help distinguish facts from interpretations, incentives and power dynamics from emotion, short-term relief from long-term interests, and identify a constructive next move.`,
  grief: `\n\nSESSION FOCUS — GRIEF: Be patient and human. Do not rush toward reframing or productivity. Allow grief, ambivalence, memory, regret, love, anger, and meaning to coexist.`,
  meaning: `\n\nSESSION FOCUS — MEANING & PURPOSE: Explore values, identity, mortality, responsibility, freedom, contribution, relationships, and what a meaningful life would look like in concrete terms.`,
  pattern: `\n\nSESSION FOCUS — REPEATING PATTERN: Help identify antecedents, emotional triggers, rewards, avoidance, beliefs, relationship dynamics, and one realistic experiment that could interrupt the pattern.`
};

app.use('/api', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false }));

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function signSession(exp) {
  return `${exp}.${crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex')}`;
}
function validSession(req) {
  if (!ACCESS_CODE) return true;
  const raw = parseCookies(req).tw_session || '';
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = signSession(exp).split('.')[1];
  return safeEqual(sig, expected);
}
function requireSession(req, res, next) {
  if (validSession(req)) return next();
  res.status(401).json({ error: 'ACCESS_REQUIRED' });
}
function cleanStyle(s) { return stylePrompts[s] ? s : 'reflective'; }
function cleanFocus(f) { return focusPrompts[f] !== undefined ? f : 'open'; }
function sanitizeMemories(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 24).map(x => String(x?.text || x || '').trim().slice(0, 2400)).filter(Boolean);
}
function memoryContext(memories) {
  if (!memories.length) return '';
  return `\n\nUSER-APPROVED LONG-TERM MEMORY:\n${memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}\nUse these only when genuinely relevant. Treat them as potentially outdated.`;
}
function instructions(style, focus, memories, extra = '') {
  return `${MASTER_PROMPT}\n\n${stylePrompts[cleanStyle(style)]}${focusPrompts[cleanFocus(focus)]}${memoryContext(sanitizeMemories(memories))}${extra}`;
}
function sanitizeHistory(history) {
  const input = [];
  for (const item of (Array.isArray(history) ? history : []).slice(-50)) {
    if (!item || !['user', 'assistant'].includes(item.role)) continue;
    const content = String(item.content || '').trim().slice(0, 14000);
    if (content) input.push({ role: item.role, content });
  }
  return input;
}
function extractResponseText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const pieces = [];
  for (const item of data.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part.type === 'output_text' && part.text) pieces.push(part.text);
    }
  }
  return pieces.join('\n').trim();
}
function safetyIdentifier(req) {
  const source = `${req.ip || 'unknown'}:${req.headers['user-agent'] || ''}`;
  return crypto.createHash('sha256').update(`talkwise-web:${source}`).digest('hex');
}
async function openAI(req, endpoint, options = {}) {
  if (!OPENAI_API_KEY) throw Object.assign(new Error('OPENAI_API_KEY_MISSING'), { status: 500 });
  const response = await fetch(`https://api.openai.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Safety-Identifier': safetyIdentifier(req),
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    const err = new Error(`OPENAI_${response.status}`);
    err.status = response.status;
    err.detail = detail.slice(0, 1800);
    throw err;
  }
  return response;
}
function friendlyError(err) {
  if (err?.message === 'OPENAI_API_KEY_MISSING') return { status: 500, body: { error: 'TalkWise has not been connected to its AI service yet.' } };
  if (err?.status === 401) return { status: 500, body: { error: 'The TalkWise server API credential needs attention.' } };
  if (err?.status === 429) return { status: 429, body: { error: 'TalkWise is temporarily at its usage limit. Please try again shortly.' } };
  if (err?.status >= 500) return { status: 503, body: { error: 'The AI service is temporarily unavailable. Please try again.' } };
  return { status: 500, body: { error: 'TalkWise could not reach the AI service.' } };
}
async function respondText(req, instructionsText, input, maxOutputTokens = 1400) {
  const r = await openAI(req, '/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TEXT_MODEL,
      reasoning: { effort: 'medium' },
      instructions: instructionsText,
      input,
      max_output_tokens: maxOutputTokens
    })
  });
  return extractResponseText(await r.json());
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ accessRequired: Boolean(ACCESS_CODE), authenticated: validSession(req), voiceEnabled: true });
});

app.post('/api/session', (req, res) => {
  if (!ACCESS_CODE) return res.json({ ok: true });
  if (!safeEqual(String(req.body?.code || ''), ACCESS_CODE)) return res.status(401).json({ error: 'That access code is not correct.' });
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const secureFlag = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `tw_session=${encodeURIComponent(signSession(exp))}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secureFlag}`);
  res.json({ ok: true });
});

app.post('/api/chat', requireSession, async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.json({ reply: '', crisis: false });
  const crisis = CRISIS_PATTERN.test(message);
  const history = sanitizeHistory(req.body?.history);
  history.push({ role: 'user', content: message.slice(0, 14000) });
  const crisisExtra = crisis
    ? `\n\nCRISIS OVERRIDE FOR THIS TURN: The user's language may indicate self-harm, suicide, or imminent violence. Be calm and direct. Ask about immediate safety and intent where appropriate. Encourage a nearby trusted person. In Canada, mention call/text 988 for suicide crisis support and 911 for immediate danger. Keep engaging and do not overwhelm them.`
    : '';
  try {
    const reply = await respondText(req, instructions(req.body?.style, req.body?.focus, req.body?.memories, crisisExtra), history, 1500);
    res.json({ reply: reply || 'Could you say that another way?', crisis });
  } catch (err) {
    const f = friendlyError(err);
    res.status(f.status).json(f.body);
  }
});

app.get('/api/realtime/token', requireSession, async (req, res) => {
  try {
    const style = cleanStyle(String(req.query.style || 'reflective'));
    const focus = cleanFocus(String(req.query.focus || 'open'));
    const voiceExtra = `\n\nVOICE MODE: This is a live spoken conversation in English. Listen carefully and answer in natural spoken English. Keep most replies to 2–6 sentences, then pause. Ask one thoughtful question at a time. Do not read markdown punctuation aloud. If you are unsure what the user said, ask a brief clarification rather than guessing. Allow the user to interrupt naturally.`;
    const sessionConfig = {
      session: {
        type: 'realtime',
        model: VOICE_MODEL,
        instructions: instructions(style, focus, [], voiceExtra),
        output_modalities: ['audio'],
        audio: {
          input: {
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 650,
              create_response: true,
              interrupt_response: true
            }
          },
          output: { voice: VOICE }
        },
        max_output_tokens: 900
      }
    };
    const r = await openAI(req, '/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionConfig)
    });
    const data = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('Realtime token failed', { status: err?.status, detail: err?.detail });
    const f = friendlyError(err);
    res.status(f.status).json(f.body);
  }
});

app.post('/api/journal/reflect', requireSession, async (req, res) => {
  const body = String(req.body?.body || '').trim().slice(0, 40000);
  if (!body) return res.status(400).json({ error: 'Journal entry is empty.' });
  try {
    const extra = `\n\nJOURNAL REFLECTION MODE: Reflect on the journal entry. Identify themes, tensions, assumptions, values, or questions worth exploring. Do not diagnose. Be concise. End with one thoughtful question.`;
    const reply = await respondText(req, instructions(req.body?.style, 'open', req.body?.memories, extra), [{ role: 'user', content: body }], 900);
    res.json({ reply });
  } catch (err) {
    const f = friendlyError(err);
    res.status(f.status).json(f.body);
  }
});

app.post('/api/session/memory', requireSession, async (req, res) => {
  const input = sanitizeHistory(req.body?.history);
  if (!input.length) return res.status(400).json({ error: 'There is no conversation to summarize.' });
  try {
    const text = await respondText(req, `Create a compact long-term memory from this conversation for future TalkWise conversations. Include only durable, useful context the user would reasonably expect remembered: important relationships, goals, recurring concerns, preferences, or decisions. Exclude highly sensitive medical details unless the user clearly asked for them to be remembered. Write 2–5 concise bullets. Do not diagnose.`, input, 500);
    res.json({ text });
  } catch (err) {
    const f = friendlyError(err);
    res.status(f.status).json(f.body);
  }
});

app.post('/api/session/notes', requireSession, async (req, res) => {
  const input = sanitizeHistory(req.body?.history);
  if (!input.length) return res.status(400).json({ error: 'There is no conversation to summarize.' });
  try {
    const focus = cleanFocus(req.body?.focus);
    const note = await respondText(req, `Write private session notes for the user, not clinical records. Use these headings: What we discussed; Patterns or tensions noticed; What seemed important; Questions to consider; Possible next step. Be concise, neutral, non-diagnostic, and useful for personal reflection. Session focus: ${focus}.`, input, 1100);
    res.json({ note });
  } catch (err) {
    const f = friendlyError(err);
    res.status(f.status).json(f.body);
  }
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  next();
});

app.listen(PORT, '0.0.0.0', () => console.log(`TalkWise Web listening on http://0.0.0.0:${PORT}`));
