require('dotenv').config();
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');
const multer = require('multer');
function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = ffmpegPath || 'ffmpeg';
    const args = ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath];
    execFile(ff, args, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error('ffmpeg failed: ' + (err.message || stderr || stdout)));
      }
      return resolve(outputPath);
    });
  });
}


const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname)));

const upload = multer({ dest: path.join(__dirname, 'tmp') });

const ELEVEN_KEY = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// --- ffmpeg conversion setup (ffmpeg-static + fluent-ffmpeg) ---
try {
  
} catch (e) {
  // ffmpeg-static not installed or not available; conversion will be skipped
  console.warn('ffmpeg-static not available; audio conversion will be attempted only if ffmpeg is on PATH');
}

// Text chat endpoint -> OpenAI
app.post('/api/chat', async (req, res) => {
  try {
    const userText = (req.body.message || req.body.text || '').toString();
    if (!userText) return res.status(400).json({ error: 'Missing message field' });
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    const payload = {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful, concise assistant.' },
        { role: 'user', content: userText }
      ],
      max_tokens: 512,
      temperature: 0.2
    };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(()=>null);
    if (!r.ok) {
      console.error('OpenAI chat error', r.status, j);
      return res.status(500).json({ error: 'OpenAI error', detail: j });
    }
    const answer = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    return res.json({ answer });
  } catch (err) {
    console.error('api/chat exception', err);
    return res.status(500).json({ error: String(err) });
  }
});

// Voice endpoint: STT -> OpenAI -> TTS (ElevenLabs)
app.post('/api/voice/chat', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!ELEVEN_KEY || !ELEVEN_VOICE_ID) {
      try { fs.unlinkSync(req.file.path); } catch(e){}
      return res.status(500).json({ error: 'ELEVEN_API_KEY or ELEVEN_VOICE_ID not configured' });
    }
    if (!OPENAI_KEY) {
      try { fs.unlinkSync(req.file.path); } catch(e){}
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    }

    const filePath = req.file.path;

    // STT request to ElevenLabs - send multipart/form-data with model_id and file

    // --- Transcrição via OpenAI Whisper (substituição do STT da ElevenLabs) ---
    
    // Ensure file is in a Whisper-supported format: convert to WAV 16k mono if possible
    let sendPath = filePath;
    const wavPath = filePath + ".wav";
    try {
      if (ffmpegPath) { // attempt conversion if ffmpeg is available in any form
        await convertToWav(filePath, wavPath);
        sendPath = wavPath;
      }
    } catch (convErr) {
      console.warn('Conversion to WAV failed, will attempt to send original file to OpenAI:', convErr && convErr.message ? convErr.message : convErr);
      sendPath = filePath;
    }
const formOpenAI = new FormData();
    formOpenAI.append('model', 'whisper-1');
    formOpenAI.append('file', fs.createReadStream(sendPath));

    const openaiHeaders = Object.assign({
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    }, (formOpenAI.getHeaders ? formOpenAI.getHeaders() : {}));

    const sttResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: openaiHeaders,
      body: formOpenAI
    });

    const sttText = await sttResp.text().catch(()=>null);
    let sttJson = null;
    try { sttJson = sttText ? JSON.parse(sttText) : null; } catch(e) { /* not json */ }

    try { fs.unlinkSync(filePath); } catch(e){}

    if (!sttResp.ok) {
      console.error('ElevenLabs STT error', sttResp.status, sttText);
      return res.status(500).json({ error: 'STT failed', status: sttResp.status, detail: sttJson || sttText });
    }

    const userText = (sttJson && (sttJson.text || sttJson.transcription)) || '';
    if (!userText) {
      return res.json({ transcript: '', reply: 'Não consegui transcrever o áudio.', audio_base64: '' });
    }

    // Send to OpenAI
    const aiPayload = {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'Você é um assistente útil e conciso. Responda em português quando o usuário falar em português.' },
        { role: 'user', content: userText }
      ],
      max_tokens: 512,
      temperature: 0.2
    };

    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify(aiPayload)
    });

    const aiJson = await aiResp.json().catch(()=>null);
    if (!aiResp.ok) {
      console.error('OpenAI error', aiResp.status, aiJson);
      return res.status(500).json({ transcript: userText, reply: '', error: 'OpenAI error', detail: aiJson });
    }
    const replyText = (aiJson.choices && aiJson.choices[0] && aiJson.choices[0].message && aiJson.choices[0].message.content) || '';

    // TTS via ElevenLabs
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const ttsResp = await fetch(ttsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
        'xi-api-key': ELEVEN_KEY
      },
      body: JSON.stringify({ text: replyText })
    });

    if (!ttsResp.ok) {
      const txt = await ttsResp.text().catch(()=>null);
      console.error('TTS error', ttsResp.status, txt);
      return res.status(500).json({ transcript: userText, reply: replyText, error: 'TTS error', detail: txt });
    }

    const buffer = Buffer.from(await ttsResp.arrayBuffer());
    const audio_base64 = buffer.toString('base64');

    return res.json({ transcript: userText, reply: replyText, audio_base64 });
  } catch (err) {
    console.error('voice/chat exception', err);
    return res.status(500).json({ error: String(err) });
  }
});

// TTS-only endpoint (text -> audio)
app.post('/api/voice/tts', express.json(), async (req, res) => {
  try {
    const text = req.body.text || '';
    if (!text) return res.status(400).json({ error: 'Missing text' });
    if (!ELEVEN_KEY || !ELEVEN_VOICE_ID) return res.status(500).json({ error: 'ELEVEN not configured' });

    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const ttsResp = await fetch(ttsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg', 'xi-api-key': ELEVEN_KEY },
      body: JSON.stringify({ text })
    });
    if (!ttsResp.ok) {
      const txt = await ttsResp.text().catch(()=>null);
      return res.status(500).json({ error: 'TTS failed', detail: txt });
    }
    const buffer = Buffer.from(await ttsResp.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${port}`);
});
