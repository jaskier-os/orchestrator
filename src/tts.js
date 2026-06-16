import { execFile } from 'child_process';
import { promisify } from 'util';
import config from './config.js';
import { createTtsAudioMessage, serializeMessage } from '@orchestrator/sdk/protocol';

const execFileAsync = promisify(execFile);

/**
 * Convert WAV buffer to OGG/Opus via ffmpeg.
 * @param {Buffer} wavBuf
 * @returns {Promise<Buffer>}
 */
async function wavToOpus(wavBuf) {
  // Validate WAV has RIFF header and data chunk
  if (wavBuf.length < 44 || wavBuf.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error(`Invalid WAV: too small (${wavBuf.length} bytes) or missing RIFF header`);
  }
  const { execSync } = await import('child_process');
  const { writeFileSync, readFileSync, unlinkSync } = await import('fs');
  const { randomUUID } = await import('crypto');
  const id = randomUUID();
  const tmpIn = `/tmp/tts_${id}.wav`;
  const tmpOut = `/tmp/tts_${id}.ogg`;
  try {
    writeFileSync(tmpIn, wavBuf);
    execSync(`ffmpeg -y -i ${tmpIn} -c:a libopus -b:a 32k ${tmpOut}`, { timeout: 30_000, stdio: 'pipe' });
    return readFileSync(tmpOut);
  } finally {
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
  }
}

/**
 * Replace http(s) URLs with their bare domain so TTS pronounces only the host.
 * @param {string} text
 * @returns {string}
 */
function stripUrlsToDomain(text) {
  // Protocol URLs: https://www.example.com/path -> example.com
  let result = text.replace(/\bhttps?:\/\/([^\s<>"'`)\]]+)/gi, (match) => {
    let host;
    try {
      host = new URL(match).hostname;
    } catch {
      host = match.replace(/^https?:\/\//, '').split(/[\/?#]/)[0];
    }
    return host.toLowerCase().replace(/^www\./, '');
  });

  // Bare www URLs: www.example.com/path -> example.com
  result = result.replace(/\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s)}\]>]*/gi, (match) => {
    return match.split(/[\/?#]/)[0].replace(/^www\./, '');
  });

  return result;
}

/**
 * Strip markdown formatting from text.
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text) {
  return stripUrlsToDomain(
    text
      .replace(/#{1,6}\s+/g, '')
      .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/^>\s+/gm, '')
      .replace(/^[-*_]{3,}$/gm, '')
      .replace(/^[\s]*[-*+]\s+/gm, '')
      .replace(/^[\s]*\d+\.\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
  ).trim();
}

/**
 * Split text into sentences.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const clean = stripMarkdown(text);
  // Split on sentence-ending punctuation, but not dots between digits (version numbers like 24.04.4)
  // or after single letters (abbreviations like "e.g.")
  const sentences = clean.match(/(?:[^.!?]|\.(?=\d))+[.!?]+/g);
  if (!sentences) {
    return clean.trim() ? [clean.trim()] : [];
  }
  // Filter out fragments shorter than 3 chars (stray punctuation artifacts)
  return sentences.map(s => s.trim()).filter(s => s.length >= 3);
}

/**
 * Check if a character is in the Cyrillic Unicode range.
 * @param {string} char
 * @returns {boolean}
 */
function isCyrillic(char) {
  const code = char.charCodeAt(0);
  return code >= 0x0400 && code <= 0x04FF;
}

/**
 * Check if a character is a Latin letter.
 * @param {string} char
 * @returns {boolean}
 */
function isLatin(char) {
  const code = char.charCodeAt(0);
  return (code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A);
}

/**
 * Split text into contiguous segments of same-language text.
 * Non-alphabetic characters (spaces, punctuation, digits) attach to the current segment.
 * @param {string} text
 * @returns {{ text: string, lang: 'en' | 'ru' }[]}
 */
export function segmentByLanguage(text) {
  if (!text) return [];

  const segments = [];
  let currentLang = 'en';
  let currentText = '';

  for (const char of text) {
    if (isCyrillic(char)) {
      if (currentLang !== 'ru' && currentText.length > 0) {
        segments.push({ text: currentText, lang: currentLang });
        currentText = '';
      }
      currentLang = 'ru';
      currentText += char;
    } else if (isLatin(char)) {
      if (currentLang !== 'en' && currentText.length > 0) {
        segments.push({ text: currentText, lang: currentLang });
        currentText = '';
      }
      currentLang = 'en';
      currentText += char;
    } else {
      // Non-alphabetic: attach to current segment
      currentText += char;
    }
  }

  if (currentText.length > 0) {
    segments.push({ text: currentText, lang: currentLang });
  }

  // Merge adjacent same-language segments
  const merged = [];
  for (const seg of segments) {
    if (merged.length > 0 && merged[merged.length - 1].lang === seg.lang) {
      merged[merged.length - 1].text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}

/**
 * Generate audio via Kokoro TTS (English).
 * @param {string} text
 * @returns {Promise<Buffer>}
 */
async function generateAudioKokoro(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${config.ttsUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kokoro',
        input: text,
        voice: 'am_echo',
        response_format: 'wav',
        speed: 1.0
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Kokoro TTS request failed: ${res.status} ${res.statusText}`);
    }

    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate Opus audio via Kokoro TTS.
 * Kokoro's native Opus encoder truncates at 5s, so we generate WAV
 * and convert to Opus via ffmpeg for full-length audio.
 * @param {string} text
 * @returns {Promise<Buffer>}
 */
async function generateAudioKokoroOpus(text) {
  const wav = await generateAudioKokoro(text);
  return wavToOpus(wav);
}

/**
 * Generate Opus audio via Piper TTS (Russian).
 * Requests Opus via Accept header; falls back to WAV if Piper lacks ffmpeg.
 * @param {string} text
 * @returns {Promise<Buffer>}
 */
async function generateAudioPiperOpus(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${config.piperTtsUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Accept': 'audio/opus, audio/ogg'
      },
      body: text,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Piper Opus failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Verify Piper actually returned Opus; fall back to ffmpeg conversion if WAV
    const ct = res.headers.get('content-type') || '';
    const isOpus = ct.includes('opus') || ct.includes('ogg');
    const header = buf.subarray(0, 4).toString('ascii');
    console.log(`[tts] Piper/TeraTTS response: content-type=${ct}, size=${buf.length}, header=${header}, isOpus=${isOpus}, text="${text.substring(0, 50)}"`);
    if (!isOpus && buf.length > 44) {
      console.log(`[tts] Got WAV instead of Opus, converting via ffmpeg. WAV sr=${buf.readUInt32LE(24)}, ch=${buf.readUInt16LE(22)}, bits=${buf.readUInt16LE(34)}`);
      return wavToOpus(buf);
    }
    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate audio via Piper TTS (Russian).
 * @param {string} text
 * @returns {Promise<Buffer>}
 */
async function generateAudioPiper(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${config.piperTtsUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Piper TTS request failed: ${res.status} ${res.statusText}`);
    }

    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Concatenate multiple WAV buffers into a single WAV buffer.
 * Assumes all buffers have the same audio format (sample rate, channels, bit depth).
 * WAV header is 44 bytes, followed by raw PCM data.
 * @param {Buffer[]} buffers
 * @returns {Buffer}
 */
function concatWavBuffers(buffers) {
  if (buffers.length === 0) return Buffer.alloc(0);
  if (buffers.length === 1) return buffers[0];

  // Extract PCM data from each buffer (skip 44-byte WAV header)
  const pcmChunks = buffers.map(buf => buf.subarray(44));
  const totalPcmLength = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);

  // Copy header from first buffer
  const header = Buffer.from(buffers[0].subarray(0, 44));

  // Update RIFF chunk size (bytes 4-7): total file size - 8
  header.writeUInt32LE(36 + totalPcmLength, 4);

  // Update data sub-chunk size (bytes 40-43): total PCM data size
  header.writeUInt32LE(totalPcmLength, 40);

  return Buffer.concat([header, ...pcmChunks]);
}

/**
 * Create a WAV file buffer from raw PCM data.
 * @param {Buffer} pcmBuffer
 * @param {number} sampleRate
 * @param {number} channels
 * @param {number} bitDepth
 * @returns {Buffer}
 */
function wrapPcmInWav(pcmBuffer, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcmBuffer.length;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Generate notification audio using Opus (English) for minimal size.
 * Falls back to WAV for Russian/mixed text.
 * @param {string} text
 * @returns {Promise<Buffer>}
 */
export async function generateNotifAudio(text) {
  text = stripUrlsToDomain(text);
  if (config.ttsRoutingMode === 'teratts') return generateAudioPiperOpus(text);
  const segments = segmentByLanguage(text);
  const allEnglish = segments.length === 0 || segments.every(s => s.lang === 'en');

  if (allEnglish) {
    // Kokoro supports Opus natively
    return generateAudioKokoroOpus(text);
  }

  const allRussian = segments.every(s => s.lang === 'ru');
  if (allRussian) {
    // Piper with Opus via Accept header
    return generateAudioPiperOpus(text);
  }

  // Mixed language: generate WAV, concat, then return as-is (glasses handle both WAV and Opus)
  return generateAudio(text);
}

/**
 * Generate audio for text, routing to the appropriate TTS engine based on language.
 * Handles mixed-language text by splitting into segments and concatenating results.
 * @param {string} text
 * @returns {Promise<Buffer>}
 */
export async function generateAudio(text) {
  if (config.ttsRoutingMode === 'teratts') return generateAudioPiper(text);
  const segments = segmentByLanguage(text);
  if (segments.length === 0) {
    return generateAudioKokoro(text);
  }

  const allSameLang = segments.every(s => s.lang === segments[0].lang);

  if (allSameLang) {
    // Fast path: single engine, no concatenation
    if (segments[0].lang === 'ru') {
      return generateAudioPiper(text);
    }
    return generateAudioKokoro(text);
  }

  // Mixed-language: generate per segment and concatenate
  const audioBuffers = [];
  for (const segment of segments) {
    const trimmed = segment.text.trim();
    if (!trimmed) continue;

    const buffer = segment.lang === 'ru'
      ? await generateAudioPiper(trimmed)
      : await generateAudioKokoro(trimmed);
    audioBuffers.push(buffer);
  }

  if (audioBuffers.length === 0) {
    return generateAudioKokoro(text);
  }

  return concatWavBuffers(audioBuffers);
}

/**
 * Stream Kokoro TTS audio chunks to a device WebSocket.
 * Calls Kokoro with stream: true, accumulates PCM into ~250ms buffers,
 * wraps each in a WAV header, and sends as tts_audio messages.
 * Uses a hold-one-back pattern so the last chunk can carry isFinal.
 * @param {string} text
 * @param {number} sentenceIndex
 * @param {number} totalSentences
 * @param {string} requestId
 * @param {() => import('ws').WebSocket | null} getDeviceWs
 * @param {{ aborted: boolean }} abortRef
 */
async function streamKokoroChunks(text, sentenceIndex, totalSentences, requestId, getDeviceWs, abortRef) {
  const SAMPLE_RATE = 24000;
  const BYTES_PER_SAMPLE = 2;
  const CHUNK_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 0.25; // ~250ms = 12000 bytes

  const controller = new AbortController();
  const streamTimeout = setTimeout(() => controller.abort(), 60_000);
  const res = await fetch(`${config.ttsUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kokoro',
      input: text,
      voice: 'am_echo',
      response_format: 'pcm',
      speed: 1.0,
      stream: true
    }),
    signal: controller.signal,
  });

  if (!res.ok) {
    clearTimeout(streamTimeout);
    throw new Error(`Kokoro TTS streaming request failed: ${res.status} ${res.statusText}`);
  }

  const isFinalSentence = sentenceIndex === totalSentences - 1;
  let pcmAccumulator = Buffer.alloc(0);
  let pendingWav = null;
  const reader = res.body.getReader();

  const sendPending = (isFinal) => {
    if (!pendingWav) return;
    const currentWs = getDeviceWs();
    if (!currentWs || currentWs.readyState !== 1) return;
    const msg = createTtsAudioMessage(requestId, {
      audioBase64: pendingWav.toString('base64'),
      sentenceIndex,
      totalSentences,
      text,
      isFinal
    });
    currentWs.send(serializeMessage(msg));
    pendingWav = null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const currentWs = getDeviceWs();
      if (abortRef.aborted || !currentWs || currentWs.readyState !== 1) return;

      pcmAccumulator = Buffer.concat([pcmAccumulator, Buffer.from(value)]);

      while (pcmAccumulator.length >= CHUNK_BYTES) {
        const pcmChunk = pcmAccumulator.subarray(0, CHUNK_BYTES);
        pcmAccumulator = Buffer.from(pcmAccumulator.subarray(CHUNK_BYTES));

        sendPending(false);
        pendingWav = wrapPcmInWav(pcmChunk);
      }
    }

    const finalWs = getDeviceWs();
    if (abortRef.aborted || !finalWs || finalWs.readyState !== 1) return;

    if (pcmAccumulator.length > 0) {
      sendPending(false);
      pendingWav = wrapPcmInWav(pcmAccumulator);
    }

    sendPending(isFinalSentence);
  } finally {
    clearTimeout(streamTimeout);
    reader.releaseLock();
  }
}

/**
 * Stream Kokoro PCM chunks as notification_tts_audio messages.
 * Each ~250ms PCM chunk is wrapped in WAV and sent individually (~16KB base64).
 * Naturally paced by Kokoro's generation speed -- no artificial throttling needed.
 * @param {string} text
 * @param {string} notifId
 * @param {boolean} isFinalSentence
 * @param {() => import('ws').WebSocket | null} getWs
 * @returns {Promise<number>} number of chunks sent
 */
export async function streamNotifChunks(text, notifId, isFinalSentence, getWs) {
  const SAMPLE_RATE = 24000;
  const BYTES_PER_SAMPLE = 2;
  const CHUNK_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 0.25; // ~250ms = 12000 bytes

  const controller = new AbortController();
  const streamTimeout = setTimeout(() => controller.abort(), 60_000);

  const res = await fetch(`${config.ttsUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kokoro',
      input: text,
      voice: 'am_echo',
      response_format: 'pcm',
      speed: 1.0,
      stream: true
    }),
    signal: controller.signal,
  });

  if (!res.ok) {
    clearTimeout(streamTimeout);
    throw new Error(`Kokoro notification TTS streaming failed: ${res.status}`);
  }

  let pcmAccumulator = Buffer.alloc(0);
  let pendingWav = null;
  let chunksSent = 0;
  const reader = res.body.getReader();

  const sendPending = async (isFinal) => {
    if (!pendingWav) return;
    const currentWs = getWs();
    if (!currentWs || currentWs.readyState !== 1) return;
    await new Promise((resolve, reject) => {
      currentWs.send(serializeMessage({
        type: 'notification_tts_audio',
        notifId,
        audioBase64: pendingWav.toString('base64'),
        isFinal,
      }), (err) => err ? reject(err) : resolve());
    });
    chunksSent++;
    pendingWav = null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const currentWs = getWs();
      if (!currentWs || currentWs.readyState !== 1) return chunksSent;

      pcmAccumulator = Buffer.concat([pcmAccumulator, Buffer.from(value)]);

      while (pcmAccumulator.length >= CHUNK_BYTES) {
        const pcmChunk = pcmAccumulator.subarray(0, CHUNK_BYTES);
        pcmAccumulator = Buffer.from(pcmAccumulator.subarray(CHUNK_BYTES));

        await sendPending(false);
        pendingWav = wrapPcmInWav(pcmChunk);
        // Pace chunks for remote connections -- allow TCP to flush each frame
        await new Promise(r => setTimeout(r, 150));
      }
    }

    const finalWs = getWs();
    if (!finalWs || finalWs.readyState !== 1) return chunksSent;

    if (pcmAccumulator.length > 0) {
      await sendPending(false);
      pendingWav = wrapPcmInWav(pcmAccumulator);
    }

    await sendPending(isFinalSentence);
  } finally {
    clearTimeout(streamTimeout);
    reader.releaseLock();
  }
  return chunksSent;
}

/**
 * Stream TTS audio for text to a device WebSocket.
 * @param {string} requestId
 * @param {string} text
 * @param {() => import('ws').WebSocket | null} getDeviceWs - getter returning current WS (survives reconnects)
 * @returns {{ abort: () => void, done: Promise<void> }}
 */
/**
 * Poll the dynamic getDeviceWs() until it returns an OPEN websocket, or
 * `timeoutMs` elapses, or `abortRef.aborted` flips. Returns the live ws
 * (readyState === 1) or null.
 *
 * Why dynamic: the phone reconnects to the orchestrator after WS drops by
 * sending a fresh `identify` envelope, which the server records in its
 * deviceConnections map. The TTS stream's `getDeviceWs` getter resolves
 * against that map every call, so the next poll automatically picks up
 * the post-reconnect socket without any explicit handoff.
 */
async function waitForReadyWs(getDeviceWs, abortRef, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!abortRef.aborted) {
    const ws = getDeviceWs();
    if (ws && ws.readyState === 1) return ws;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

export function streamTts(requestId, text, getDeviceWs) {
  const abortRef = { aborted: false };

  const abort = () => { abortRef.aborted = true; };

  const done = (async () => {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return;

    console.log(`[tts] Starting TTS stream for ${requestId}: ${sentences.length} sentences`);

    for (let i = 0; i < sentences.length; i++) {
      // Wait up to 30 s for a healthy WS before each sentence. The phone's
      // WS routinely drops on mobile networks during long TTS streams; if
      // we abort the moment the WS dies we lose the tail of the response
      // (observed: sentence 10/11 streamed, phone reconnected ~1 s later,
      // sentence 11 was never sent because we'd already returned). Poll
      // dynamically -- getDeviceWs() resolves to whatever device-WS is
      // currently registered for the requesting device, so once the phone
      // reconnects the next iteration picks up the new socket.
      const currentWs = await waitForReadyWs(getDeviceWs, abortRef, 30_000);
      if (abortRef.aborted || !currentWs) {
        console.log(`[tts] Stream ${requestId} aborted at sentence ${i}/${sentences.length} (no WS recovered within 30s)`);
        return;
      }

      const useTeratts = config.ttsRoutingMode === 'teratts';
      const isEnglish = !useTeratts && segmentByLanguage(sentences[i]).every(s => s.lang === 'en');

      try {
        if (isEnglish) {
          await streamKokoroChunks(sentences[i], i, sentences.length, requestId, getDeviceWs, abortRef);
        } else {
          // Use Opus for non-English to keep BT payload small (~20x smaller than WAV)
          let audioBuffer;
          if (useTeratts) {
            // teratts mode: TeraTTS pronounces everything (including English) via Russian phonemes
            audioBuffer = await generateAudioPiperOpus(sentences[i]);
          } else {
            const segments = segmentByLanguage(sentences[i]);
            const allRussian = segments.every(s => s.lang === 'ru');
            audioBuffer = allRussian
              ? await generateAudioPiperOpus(sentences[i])
              : await wavToOpus(await generateAudio(sentences[i]));
          }
          const b64 = audioBuffer.toString('base64');
          const audioHeader = audioBuffer.subarray(0, 4).toString('ascii');
          console.log(`[tts] Sending RU audio: sentence ${i+1}/${sentences.length}, format=${audioHeader === 'OggS' ? 'Opus' : 'WAV'}, rawBytes=${audioBuffer.length}, base64Len=${b64.length}, text="${sentences[i].substring(0, 40)}"`);

          const wsAfter = getDeviceWs();
          if (abortRef.aborted || !wsAfter || wsAfter.readyState !== 1) return;

          const msg = createTtsAudioMessage(requestId, {
            audioBase64: b64,
            sentenceIndex: i,
            totalSentences: sentences.length,
            text: sentences[i],
            isFinal: i === sentences.length - 1
          });

          wsAfter.send(serializeMessage(msg));
        }
      } catch (err) {
        console.error(`[tts] Failed to generate audio for sentence ${i}: ${err.message}`);
      }
    }

    console.log(`[tts] Stream ${requestId} complete`);
  })();

  return { abort, done };
}

