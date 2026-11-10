// Transcrição de áudio via OpenAI, com a chave configurada nesta instalação.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const TRANSCRIPTION_ENABLED = (process.env.TRANSCRIPTION_ENABLED || 'true').toLowerCase() === 'true' && !!OPENAI_API_KEY;
const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';
const TRANSCRIPTION_LANGUAGE = process.env.TRANSCRIPTION_LANGUAGE || 'pt';
const MAX_AUDIO_BYTES = Number(process.env.TRANSCRIPTION_MAX_AUDIO_MB || '24') * 1024 * 1024;
const MAX_DURATION_SECONDS = Number(process.env.TRANSCRIPTION_MAX_DURATION_SECONDS || '1200');
const MAX_CONCURRENT = Number(process.env.TRANSCRIPTION_MAX_CONCURRENT || '2');
const CHUNK_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const REQUEST_TIMEOUT_MS = 120000;

// Formatos que a própria API da OpenAI aceita sem conversão - a grande
// maioria dos áudios do WhatsApp (audio/ogg;codecs=opus) já cai aqui, então
// na prática quase nunca precisamos do ffmpeg (ver seção 3 do pedido:
// "se a API aceitar o arquivo original, NÃO converter desnecessariamente").
const NATIVE_EXTENSIONS = new Set(['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']);

function mimetypeToExtension(mimetype) {
  const base = (mimetype || '').split(';')[0].trim().toLowerCase();
  const map = {
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'mp4',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/3gpp': '3gp',
    'audio/amr': 'amr',
  };
  return map[base] || base.split('/')[1] || 'bin';
}

// ---------------------------------------------------------------------------
// Cache persistente (sobrevive a restart/rebuild - arquivo em volume próprio)
// Chave primária: message_id. Chave secundária: audio_hash (SHA-256 do
// arquivo), para não pagar a API de novo se o MESMO áudio aparecer em outra
// mensagem (ex: encaminhado para vários chats).
// ---------------------------------------------------------------------------
export class TranscriptionCache {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _reload() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.byMessageId = new Map(data.byMessageId || []);
      this.byHash = new Map(data.byHash || []);
    } catch {
      this.byMessageId = new Map();
      this.byHash = new Map();
    }
    return this;
  }

  _save() {
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ byMessageId: [...this.byMessageId.entries()], byHash: [...this.byHash.entries()] }, null, 2)
    );
  }

  getByMessageId(messageId) {
    return this._reload().byMessageId.get(messageId) || null;
  }

  getByHash(hash) {
    return this._reload().byHash.get(hash) || null;
  }

  // Carrega o cache uma única vez para quem for consultar muitas mensagens
  // em sequência (ex: search_messages varrendo centenas de mensagens) - evita
  // reler/reparsear o arquivo a cada mensagem individual.
  allByMessageId() {
    return this._reload().byMessageId;
  }

  put(entry) {
    this._reload();
    this.byMessageId.set(entry.message_id, entry);
    this.byHash.set(entry.audio_hash, entry);
    this._save();
  }
}

// ---------------------------------------------------------------------------
// Limite de concorrência simples (semáforo) - evita tempestade de chamadas
// simultâneas para a API, conforme pedido (2-3 no máximo).
// ---------------------------------------------------------------------------
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
const semaphore = new Semaphore(MAX_CONCURRENT);

function isRetryable(status) {
  return status === 429 || status >= 500;
}

async function callTranscriptionApi(buffer, filename, mimetype) {
  let lastError;
  for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const form = new FormData();
      form.append('model', TRANSCRIPTION_MODEL);
      form.append('language', TRANSCRIPTION_LANGUAGE);
      form.append('response_format', 'text');
      form.append('file', new Blob([buffer], { type: mimetype }), filename);

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const status = res.status;
        const bodyText = await res.text().catch(() => '');
        const err = new Error(`OpenAI respondeu ${status}`);
        err.status = status;
        err.permanent = !isRetryable(status);
        // nunca inclui o corpo do erro bruto no log (pode ecoar parte do
        // payload) - só o status e um resumo curto.
        err.summary = bodyText.slice(0, 200);
        throw err;
      }
      const text = await res.text();
      return text.trim();
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      const permanent = err.permanent === true || err.name === 'AbortError' ? false : err.permanent;
      if (err.permanent || attempt >= CHUNK_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

// Converte para um formato aceito pela API só quando realmente necessário
// (mimetype fora da lista nativa). Usa ffmpeg (precisa estar instalado na
// imagem). Remove o arquivo temporário logo depois, com ou sem sucesso.
async function convertToSupportedFormat(buffer, tmpDir) {
  const inPath = `${tmpDir}/${crypto.randomUUID()}.input`;
  const outPath = `${tmpDir}/${crypto.randomUUID()}.ogg`;
  fs.writeFileSync(inPath, buffer);
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', inPath, '-ac', '1', '-c:a', 'libopus', outPath], { timeout: 60000 });
    return fs.readFileSync(outPath);
  } finally {
    fs.rmSync(inPath, { force: true });
    fs.rmSync(outPath, { force: true });
  }
}

/**
 * Transcreve o áudio de uma mensagem. Nunca lança - sempre devolve um objeto
 * {success, ...}. Verifica cache (por message_id e por hash do arquivo)
 * antes de chamar a API. Respeita limites de tamanho/duração/concorrência.
 */
export async function transcribeAudio({ messageId, buffer, mimetype, filename, durationSeconds, cache, log }) {
  const cached = cache.getByMessageId(messageId);
  if (cached) {
    log?.('[TRANSCRIPTION] cache_hit', messageId);
    return { success: true, ...cached, transcription_source: 'cache' };
  }

  if (!TRANSCRIPTION_ENABLED) {
    return { success: false, error: 'transcription_disabled', message: 'Transcrição desativada (TRANSCRIPTION_ENABLED=false ou OPENAI_API_KEY ausente).' };
  }
  if (durationSeconds && durationSeconds > MAX_DURATION_SECONDS) {
    return { success: false, error: 'audio_too_long', message: `Áudio de ${durationSeconds}s excede o limite de ${MAX_DURATION_SECONDS}s.` };
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    return { success: false, error: 'audio_too_large', message: `Arquivo de ${buffer.length} bytes excede o limite de ${MAX_AUDIO_BYTES} bytes.` };
  }

  const audioHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const byHash = cache.getByHash(audioHash);
  if (byHash) {
    log?.('[TRANSCRIPTION] cache_hit (mesmo áudio, outra mensagem)', messageId);
    const entry = { ...byHash, message_id: messageId };
    cache.put(entry);
    return { success: true, ...entry, transcription_source: 'cache' };
  }

  log?.('[TRANSCRIPTION] cache_miss', messageId);
  log?.('[TRANSCRIPTION] request', messageId, TRANSCRIPTION_MODEL);

  await semaphore.acquire();
  const startedAt = Date.now();
  try {
    let uploadBuffer = buffer;
    let uploadName = filename || `audio.${mimetypeToExtension(mimetype)}`;
    const ext = mimetypeToExtension(mimetype);
    if (!NATIVE_EXTENSIONS.has(ext)) {
      uploadBuffer = await convertToSupportedFormat(buffer, '/tmp');
      uploadName = 'audio.ogg';
    }

    const text = await callTranscriptionApi(uploadBuffer, uploadName, mimetype);
    const processingMs = Date.now() - startedAt;
    const entry = {
      message_id: messageId,
      audio_hash: audioHash,
      transcription: text,
      model: TRANSCRIPTION_MODEL,
      language: TRANSCRIPTION_LANGUAGE,
      created_at: new Date().toISOString(),
      duration_seconds: durationSeconds ?? null,
    };
    cache.put(entry);
    log?.('[TRANSCRIPTION] success', messageId, `${processingMs}ms`);
    return { success: true, ...entry, transcription_source: 'api', processing_time_ms: processingMs };
  } catch (err) {
    log?.('[TRANSCRIPTION] failed', messageId, err.status || err.name || 'erro');
    return {
      success: false,
      error: 'transcription_service_error',
      message: `Transcrição indisponível (${err.status ? `HTTP ${err.status}` : err.message || 'erro desconhecido'}).`,
    };
  } finally {
    semaphore.release();
  }
}

export function transcriptionConfigSummary() {
  return {
    enabled: TRANSCRIPTION_ENABLED,
    model: TRANSCRIPTION_MODEL,
    language: TRANSCRIPTION_LANGUAGE,
    max_audio_mb: MAX_AUDIO_BYTES / 1024 / 1024,
    max_duration_seconds: MAX_DURATION_SECONDS,
    max_concurrent: MAX_CONCURRENT,
  };
}
