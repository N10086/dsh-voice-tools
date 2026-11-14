/**
 * Voice kit host half: a DeepSeek text-to-speech tool for the model, and a speech-to-text
 * HTTP route for the browser microphone button.
 *
 * This module deliberately imports nothing from `@deepseek-ai/*`. A plugin installed in the
 * DSH profile resolves modules from the profile tree, and the shipped harness packages live
 * inside the application archive, so a bare import would fail at load time. Everything here
 * therefore talks to the harness through the Cordis context it is handed.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Plausible ffmpeg locations, most specific first. */
const FFMPEG_CANDIDATES = [
  join(homedir(), '.dsh', 'drawai-ffmpeg', 'win32-x64', 'ffmpeg.exe'),
  join(homedir(), '.dsh', 'drawai-ffmpeg', 'win32-x64', 'ffmpeg'),
]

/** `atempo` is stable and artefact-free across this range. */
const SPEED_MIN = 0.5
const SPEED_MAX = 2.0

/** Official DeepSeek endpoints for the two tool APIs. */
const TTS_URL = 'https://api.deepseek.com/v1/tools/tts'
const ASR_URL = 'https://api.deepseek.com/v1/tools/asr'

/** Accepted TTS voices. */
const VOICES = ['stella', 'tide']

/** Accepted TTS container formats. */
const FORMATS = ['wav', 'pcm']

/** Hard limits published by the ASR guide. */
const ASR_MAX_BYTES = 8 * 1024 * 1024
const ASR_MAX_SECONDS = 120

/**
 * Resolve the API key from the credential service first, then the process environment.
 * @param ctx - plugin context carrying the optional credentials service.
 * @param envName - reference name stored in the credential document.
 * @returns the key, or undefined when none is configured.
 */
async function resolveApiKey(ctx, envName) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.get === 'function') {
    try {
      const value = await credentials.get(envName)
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    } catch {
      // The managed document is authoritative when present; an unreadable entry falls back
      // to the environment so a launch-time variable still works.
    }
  }
  const fromEnv = process.env[envName]
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : undefined
}

/** Read the Wave header's duration so the tool can report what it produced. */
function wavSeconds(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return undefined
  const byteRate = buffer.readUInt32LE(28)
  if (byteRate === 0) return undefined
  return Math.round(((buffer.length - 44) / byteRate) * 10) / 10
}

/**
 * Locate an ffmpeg binary. The explicit config path wins; otherwise the bundled copy and
 * then PATH are tried. The DeepSeek TTS endpoint has no speed parameter, so pacing is applied
 * locally with ffmpeg's tempo filter.
 * @param configured - absolute path from configuration, when set.
 * @returns the executable path, or undefined when none is available.
 */
function findFfmpeg(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return existsSync(configured) ? configured : undefined
  }
  for (const candidate of FFMPEG_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  // Fall back to a PATH lookup resolved by the shell at spawn time.
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

/**
 * Re-time a WAV file without changing its pitch.
 * @param ffmpeg - executable path or bare command name.
 * @param input - source WAV path.
 * @param output - destination WAV path.
 * @param speed - tempo multiplier, already clamped by the caller.
 * @param signal - caller cancellation.
 * @returns nothing; rejects with ffmpeg's stderr tail on failure.
 */
function retimeWav(ffmpeg, input, output, speed, signal) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-filter:a', `atempo=${speed}`,
      output,
    ]
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    const onAbort = () => { child.kill() }
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(`ffmpeg could not start (${ffmpeg}): ${error.message}`))
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) { reject(new Error('speak_text: cancelled')); return }
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(-300)}`))
    })
  })
}

/**
 * Register the speak_text tool.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
function registerSpeakTool(ctx, config) {
  registerSpeakToolNamed(ctx, config, 'speak_text')
}

/**
 * Register one named synthesizer tool.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @param toolName - registered tool name.
 */
function registerSpeakToolNamed(ctx, config, toolName) {
  ctx.tools.register({
    name: toolName,
    description:
      'Synthesize speech audio from text with DeepSeek text-to-speech and save it as an audio file. '
      + 'Use when the user asks for spoken audio, a voice message, narration, or read-aloud output. '
      + 'Returns the saved file path; the audio is not attached to the conversation automatically.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description:
          'Text to speak, in the language it should be read in (Mandarin, Cantonese, English, Japanese, '
          + 'Korean, Malay, Arabic, Indonesian, Thai, Vietnamese). Markdown is stripped before reading.',
      },
      voice: {
        type: 'string',
        enum: VOICES,
        description: 'stella is female (default), tide is male.',
      },
      speed: {
        type: 'number',
        description:
          `Speaking rate multiplier from ${SPEED_MIN} to ${SPEED_MAX}: 1 is normal, below 1 is slower, `
          + 'above 1 is faster. Pitch is preserved. Defaults to the configured rate.',
      },
      filename: {
        type: 'string',
        description:
          'Base name for the saved audio file, without extension. Defaults to a timestamped name.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          seconds: { type: 'number' },
          voice: { type: 'string' },
          format: { type: 'string' },
          speed: { type: 'number' },
        },
        required: ['path', 'bytes', 'voice', 'format'],
        additionalProperties: false,
      },
      render(args, value) {
        const seconds = value.seconds === undefined ? '' : `, about ${value.seconds}s`
        const speed = value.speed === undefined || value.speed === 1 ? '' : `, speed ${value.speed}x`
        return [{
          type: 'text',
          text: `Audio saved to ${value.path} (${value.voice}, ${value.format}${speed}, ${value.bytes} bytes${seconds}).`,
        }]
      },
    },
    async execute(args, exec) {
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      if (text === '') throw new Error('speak_text: text must not be empty')
      const voice = VOICES.includes(args.voice) ? args.voice : config.voice
      const format = FORMATS.includes(config.format) ? config.format : 'wav'
      const apiKey = await resolveApiKey(ctx, config.apiKeyEnv)
      if (apiKey === undefined) {
        throw new Error(
          `speak_text: no DeepSeek API key. Set ${config.apiKeyEnv} in the Models page or the launch environment.`,
        )
      }
      const response = await fetch(TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice_id: voice, format }),
        signal: exec.signal,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        throw new Error(`speak_text: DeepSeek TTS returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
      }
      const audio = Buffer.from(await response.arrayBuffer())
      if (audio.length === 0) throw new Error('speak_text: DeepSeek TTS returned no audio')

      const raw = typeof args.filename === 'string' ? args.filename.trim() : ''
      const base = (raw === '' ? `speech-${Date.now()}` : raw)
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || `speech-${Date.now()}`
      const dir = join(homedir(), '.dsh', 'voice')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${base}.${format}`)
      await writeFile(path, audio)

      const value = { path, bytes: audio.length, voice, format }

      // Speed is not a DeepSeek TTS parameter, so pace is applied after synthesis with
      // ffmpeg's tempo filter, which keeps the pitch. The tool still succeeds at 1x when
      // no encoder is installed; only a requested non-default speed depends on it.
      const requested = typeof args.speed === 'number' && Number.isFinite(args.speed)
        ? args.speed
        : config.speed
      const speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, requested))
      if (Math.abs(speed - 1) > 0.001 && format === 'wav') {
        const ffmpeg = findFfmpeg(config.ffmpegPath)
        if (ffmpeg === undefined) {
          ctx.logger.warn('voice-tools: speed %s requested but ffmpeg was not found; keeping the original pace', speed)
        } else {
          const tmp = join(dir, `${base}.${Date.now()}.src.wav`)
          try {
            await retimeWav(ffmpeg, path, tmp, speed, exec.signal)
            await writeFile(path, await readFile(tmp))
            value.speed = speed
            value.bytes = (await stat(path)).size
          } catch (error) {
            ctx.logger.warn('voice-tools: speed adjustment failed, keeping normal pace: %s',
              error instanceof Error ? error.message : String(error))
          } finally {
            await rm(tmp, { force: true })
          }
        }
      }

      if (format === 'wav') {
        const seconds = wavSeconds(await readFile(path))
        if (seconds !== undefined) value.seconds = seconds
      }
      return value
    },
  })
}

/**
 * Register the transcription route the browser microphone posts a whole recording to.
 * @param ctx - plugin context, optionally carrying the webserver service.
 * @param config - resolved plugin configuration.
 */
function registerSpeechRoute(ctx, config) {
  const webserver = ctx.get('webServer')
  if (webserver === undefined || typeof webserver.register !== 'function') {
    ctx.logger.info('voice-tools: no web server in this composition; the microphone route stays off')
    return
  }
  const dispose = webserver.register({
    path: '/voice-tools/transcribe',
    kind: 'exact',
    async handler(req, res) {
      const chunks = []
      let size = 0
      try {
        for await (const chunk of req) {
          size += chunk.length
          if (size > ASR_MAX_BYTES) {
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'audio larger than 8 MiB' }))
            return
          }
          chunks.push(chunk)
        }
        const audio = Buffer.concat(chunks)
        if (audio.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'empty recording' }))
          return
        }
        const key = await resolveApiKey(ctx, config.apiKeyEnv)
        if (key === undefined) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `no DeepSeek API key (${config.apiKeyEnv})` }))
          return
        }
        const form = new FormData()
        form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav')
        const upstream = await fetch(ASR_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        })
        const body = await upstream.text()
        if (!upstream.ok) {
          res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
          res.end(body.slice(0, 2000))
          return
        }
        const parsed = JSON.parse(body)
        const text = typeof parsed.text === 'string' ? parsed.text : ''
        if (typeof parsed.duration_ms === 'number' && parsed.duration_ms > ASR_MAX_SECONDS * 1000) {
          ctx.logger.warn('voice-tools: transcription exceeded the published duration limit')
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text, durationMs: parsed.duration_ms ?? null }))
      } catch (error) {
        ctx.logger.warn('voice-tools: transcription failed: %s', error instanceof Error ? error.message : String(error))
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        } else {
          res.end()
        }
      }
    },
  })
  ctx.effect(() => dispose, 'voice-tools: transcription route')
}

/** Plugin name. */
export const name = 'voice-tools'

/** Required service: the tool registry. */
export const inject = ['tools']

/**
 * Activate the tool and the transcription route.
 *
 * No `Config` schema is exported: `@deepseek-ai/schemastery` cannot be imported from a
 * profile-installed plugin, and the loader validates every exported `Config`, so declaring
 * one without the real builder fails activation. Defaults are applied here instead.
 * @param ctx - plugin context.
 * @param config - plugin configuration from the bundle patch.
 */
export function apply(ctx, config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const resolved = {
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv : 'DEEPSEEK_API_KEY',
    voice: VOICES.includes(raw.voice) ? raw.voice : 'stella',
    format: FORMATS.includes(raw.format) ? raw.format : 'wav',
    speed: typeof raw.speed === 'number' && Number.isFinite(raw.speed)
      ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, raw.speed))
      : 1,
    ffmpegPath: typeof raw.ffmpegPath === 'string' ? raw.ffmpegPath : '',
  }
  registerSpeakTool(ctx, resolved)
  // Lets the user invoke synthesis directly from the '/' menu without going through the model.
  registerSpeakToolNamed(ctx, resolved, 'voice_kit_speech')
  registerSpeechRoute(ctx, resolved)
  ctx.logger.info('voice-tools: speak_text ready (voice %s, format %s)', resolved.voice, resolved.format)
}
