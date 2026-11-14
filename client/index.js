/**
 * Voice tools browser half: a microphone control between the model picker and the send button.
 *
 * Recording happens in the page, the finished clip is posted to the host route this bundle's
 * host half registers, and the transcript is appended to the current draft through the
 * composer's own input actions, so whatever the user already typed stays in front of it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-tools',
  factory(require) {
    const React = require('react')

    const h = React.createElement

    /** Host route registered by lib/index.js. */
    const TRANSCRIBE_URL = '/voice-tools/transcribe'

    /** ASR accepts at most 120 seconds of audio. */
    const MAX_SECONDS = 120

    /** Pick a container the ASR endpoint accepts for this browser. */
    function preferredMime() {
      if (typeof MediaRecorder === 'undefined') return ''
      const candidates = ['audio/wav', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm;codecs=opus']
      for (const mime of candidates) {
        try {
          if (MediaRecorder.isTypeSupported(mime)) return mime
        } catch {
          // Some builds throw on unknown types; keep probing.
        }
      }
      return ''
    }

    /**
     * Decode an arbitrary recording through the Web Audio API and re-encode it as the
     * 16-bit PCM WAV the endpoint documents. Returns undefined when the browser cannot decode.
     * @param blob - recorded audio.
     * @returns WAV blob, or undefined.
     */
    async function toWav(blob) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext
      if (!AudioCtor) return undefined
      const bytes = await blob.arrayBuffer()
      const context = new AudioCtor()
      let decoded
      try {
        decoded = await context.decodeAudioData(bytes)
      } catch {
        return undefined
      } finally {
        void context.close()
      }
      const samples = decoded.getChannelData(0)
      const out = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(out)
      const writeAscii = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
      }
      writeAscii(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      writeAscii(8, 'WAVE')
      writeAscii(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, decoded.sampleRate, true)
      view.setUint32(28, decoded.sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeAscii(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      let offset = 44
      for (let i = 0; i < samples.length; i++, offset += 2) {
        const clamped = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      }
      return new Blob([out], { type: 'audio/wav' })
    }

    /** A small microphone glyph; no shared icon package is reachable from this module. */
    function MicIcon(props) {
      return h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: props.style,
      },
      h('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }),
      h('path', { d: 'M5 10v1a7 7 0 0 0 14 0v-1' }),
      h('line', { x1: 12, y1: 19, x2: 12, y2: 22 }))
    }

    /** Stop glyph for the recording state. */
    function StopIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true,
      }, h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }))
    }

    const buttonStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, padding: 0, border: 'none', borderRadius: 8,
      background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.75,
    }
    const activeStyle = { ...buttonStyle, color: '#e5484d', opacity: 1 }

    /**
     * Microphone control. The component only touches props the composer already provides.
     * @param props - composer runtime props.
     */
    function VoiceButton(props) {
      const { inputActions, locked, onActiveChange } = props
      const [phase, setPhase] = React.useState('idle')
      const [message, setMessage] = React.useState('')
      const recorderRef = React.useRef(undefined)
      const chunksRef = React.useRef([])
      const timerRef = React.useRef(undefined)
      const cancelledRef = React.useRef(false)

      const expanded = phase !== 'idle'
      React.useLayoutEffect(() => {
        onActiveChange?.(expanded)
        return () => { onActiveChange?.(false) }
      }, [expanded, onActiveChange])

      React.useEffect(() => () => {
        clearTimeout(timerRef.current)
        const recorder = recorderRef.current
        if (recorder !== undefined && recorder.state !== 'inactive') {
          cancelledRef.current = true
          try { recorder.stop() } catch { /* already stopping */ }
        }
      }, [])

      const reset = () => {
        clearTimeout(timerRef.current)
        recorderRef.current = undefined
        chunksRef.current = []
        setPhase('idle')
        setMessage('')
      }

      const fail = (text) => {
        recorderRef.current = undefined
        chunksRef.current = []
        setMessage(text)
        setPhase('failed')
      }

      const send = async (blob) => {
        setPhase('transcribing')
        try {
          let payload = blob
          if (!blob.type.includes('wav')) {
            const wav = await toWav(blob)
            if (wav !== undefined) payload = wav
          }
          const response = await fetch(TRANSCRIBE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: payload,
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) {
            fail(body.error || `HTTP ${response.status}`)
            return
          }
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (text === '') {
            fail('No speech detected')
            return
          }
          if (typeof inputActions?.insertText !== 'function') {
            fail('This composer cannot accept inserted text')
            return
          }
          // Append at the caret span captured now, so existing draft text is kept.
          const inserted = inputActions.insertText(text, inputActions.captureInsertion())
          if (inserted === false) {
            fail('The draft is being edited; try again')
            return
          }
          reset()
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error))
        }
      }

      const start = async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
          })
          const mimeType = preferredMime()
          const recorder = mimeType === ''
            ? new MediaRecorder(stream)
            : new MediaRecorder(stream, { mimeType })
          recorderRef.current = recorder
          chunksRef.current = []
          cancelledRef.current = false
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
          }
          recorder.onstop = () => {
            for (const track of stream.getTracks()) track.stop()
            if (cancelledRef.current) { reset(); return }
            const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
            void send(blob)
          }
          recorder.start()
          setPhase('recording')
          timerRef.current = setTimeout(() => { stop() }, MAX_SECONDS * 1000)
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error))
        }
      }

      const stop = () => {
        const recorder = recorderRef.current
        if (recorder === undefined) return
        clearTimeout(timerRef.current)
        if (recorder.state !== 'inactive') recorder.stop()
      }

      const cancel = () => {
        clearTimeout(timerRef.current)
        cancelledRef.current = true
        const recorder = recorderRef.current
        if (recorder !== undefined && recorder.state !== 'inactive') recorder.stop()
        else reset()
      }

      if (phase === 'idle') {
        return h('button', {
          type: 'button',
          style: buttonStyle,
          disabled: locked,
          'aria-label': 'Voice input',
          title: 'Voice input',
          onMouseDown: (event) => { event.preventDefault() },
          onClick: () => { void start() },
        }, h(MicIcon, {}))
      }

      if (phase === 'recording') {
        return h('button', {
          type: 'button',
          style: activeStyle,
          'aria-label': 'Stop recording',
          title: 'Stop and transcribe',
          onClick: () => { stop() },
        }, h(StopIcon, {}))
      }

      if (phase === 'transcribing') {
        return h('span', {
          style: { fontSize: 12, opacity: 0.8, padding: '0 6px' }, role: 'status',
        }, 'Transcribing...')
      }

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { fontSize: 12, opacity: 0.8, maxWidth: 180 }, title: message }, message),
        h('button', {
          type: 'button', style: buttonStyle, 'aria-label': 'Retry', title: 'Retry',
          onClick: () => { reset(); void start() },
        }, h(MicIcon, {})),
        h('button', {
          type: 'button', style: buttonStyle, 'aria-label': 'Dismiss', title: 'Dismiss',
          onClick: () => { reset() },
        }, '\u00d7'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
          name: 'conversation.input.activity',
          id: 'voice-tools',
          order: 20,
        }, VoiceButton))
      },
    }
  },
})
