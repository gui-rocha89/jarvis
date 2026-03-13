// ============================================
// JARVIS 3.0 - Áudio (TTS + STT)
// ============================================
import OpenAI from 'openai';
import { writeFile, unlink, readFile } from 'fs/promises';
import { createReadStream } from 'fs';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { pool } from './database.mjs';

const execFileAsync = promisify(execFile);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

// Voice config - persiste no PostgreSQL
export let voiceConfig = {
  provider: 'elevenlabs',
  openai: { voice: 'onyx', model: 'tts-1' },
  elevenlabs: {
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'CstacWqMhJQlnfLPxRG4',
    model: 'eleven_v3',
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.0,
    use_speaker_boost: true,
  },
};

export async function loadVoiceConfig() {
  try {
    const { rows } = await pool.query("SELECT value FROM jarvis_config WHERE key = 'voice_config'");
    if (rows.length > 0) {
      const saved = rows[0].value;
      voiceConfig.provider = saved.provider || voiceConfig.provider;
      if (saved.openai) Object.assign(voiceConfig.openai, saved.openai);
      if (saved.elevenlabs) Object.assign(voiceConfig.elevenlabs, saved.elevenlabs);
      console.log('[VOICE] Config carregada:', JSON.stringify(voiceConfig));
    }
  } catch (err) {
    console.error('[VOICE] Erro ao carregar config:', err.message);
  }
}

export async function saveVoiceConfig() {
  try {
    await pool.query(
      `INSERT INTO jarvis_config (key, value, updated_at) VALUES ('voice_config', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(voiceConfig)]
    );
  } catch (err) {
    console.error('[VOICE] Erro ao salvar config:', err.message);
  }
}

export async function transcribeAudio(buffer) {
  const tmpFile = '/tmp/audio_' + randomUUID() + '.ogg';
  await writeFile(tmpFile, buffer);
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(tmpFile),
      model: 'whisper-1',
      language: 'pt',
    });
    return transcription.text;
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

export async function generateAudio(text) {
  let rawBuffer;
  const provider = voiceConfig.provider;

  if (provider === 'elevenlabs' && process.env.ELEVENLABS_API_KEY) {
    const vc = voiceConfig.elevenlabs;
    const vId = vc.voiceId || process.env.ELEVENLABS_VOICE_ID || 'CstacWqMhJQlnfLPxRG4';
    const mId = vc.model || 'eleven_v3';

    const voiceSettings = {
      stability: vc.stability ?? 0.5,
      similarity_boost: vc.similarity_boost ?? 0.75,
      style: vc.style ?? 0.0,
      use_speaker_boost: vc.use_speaker_boost ?? true,
    };

    const elResp = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vId, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: mId,
        voice_settings: voiceSettings,
      }),
    });
    if (!elResp.ok) throw new Error('ElevenLabs TTS erro: ' + elResp.status);
    rawBuffer = Buffer.from(await elResp.arrayBuffer());
  } else {
    const vc = voiceConfig.openai;
    const response = await openai.audio.speech.create({
      model: vc.model || 'tts-1',
      voice: vc.voice || 'onyx',
      input: text,
      response_format: 'opus',
    });
    rawBuffer = Buffer.from(await response.arrayBuffer());
  }

  // Converter para PTT do WhatsApp (OGG Opus mono 48kHz)
  const tmpIn = '/tmp/tts_in_' + randomUUID() + '.ogg';
  const tmpOut = '/tmp/tts_out_' + randomUUID() + '.ogg';
  await writeFile(tmpIn, rawBuffer);

  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', tmpIn,
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ac', '1',
      '-ar', '48000',
      '-application', 'voip',
      tmpOut,
    ]);
    const converted = await readFile(tmpOut);
    return converted;
  } catch (err) {
    console.error('[TTS] ffmpeg falhou, usando audio original:', err.message);
    return rawBuffer;
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}
