#!/usr/bin/env node

/**
 * 🌐 Russian 🔄 English Real-Time Live Voice Translator CLI
 * Supporting virtual microphone output via PipeWire / ALSA loopback.
 *
 * Requirements on your terminal:
 * 1. Node.js (18+)
 * 2. install dependencies: npm install @google/genai dotenv
 * 3. Loopback audio setup via Pipewire (pw-loopback) or PulseAudio (pacmd)
 * 4. API Key: Export GEMINI_API_KEY environment variable.
 */

import { spawn, execSync } from 'child_process';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('\x1b[31mError: GEMINI_API_KEY environment variable is not set!\x1b[0m');
  console.log('Please set it in your environment before running:');
  console.log('  \x1b[1mexport GEMINI_API_KEY="your_api_key_here"\x1b[0m\n');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

console.log('\x1b[36m┌────────────────────────────────────────────────────────┐');
console.log('│  🌐 Russian 🔄 English REAL-TIME LIVE VOICE TRANSLATOR  │');
console.log('└────────────────────────────────────────────────────────┘\x1b[0m');

// Audio specifications
const RECORD_RATE = 16000;
const PLAYBACK_RATE = 24000;

// Set target device/sink from args, defaulting to 'Virtual_Sink'
const TARGET_SINK = process.argv.includes('--target') 
  ? process.argv[process.argv.indexOf('--target') + 1] 
  : 'Virtual_Sink';

// Set source capture device from args, defaulting to null (meaning default system recording device)
const CAPTURE_SOURCE = process.argv.includes('--source') 
  ? process.argv[process.argv.indexOf('--source') + 1] 
  : null;

// Detect audio command utility
let usePipewire = false;
try {
  execSync('which pw-record', { stdio: 'ignore' });
  usePipewire = true;
} catch (e) {
  usePipewire = false;
}

console.log(`🤖 System Detection: \x1b[35m${usePipewire ? 'PipeWire (pw-record/pw-play)' : 'ALSA (arecord/aplay)'}\x1b[0m`);
console.log(`🎙️  Mic capture device: \x1b[33m${CAPTURE_SOURCE || 'Default Microphone (System Default)'}\x1b[0m`);
console.log(`🎙️  Mic capture rate: \x1b[33m16kHz Mono 16-bit signed PCM\x1b[0m`);
console.log(`🔊  Playback output target: \x1b[32m${TARGET_SINK}\x1b[0m`);
console.log('💡  Make sure your loopback devices are created using pw-loopback:');
console.log('    \x1b[34mpw-loopback -m "[ FL FR ]" --capture-props="media.class=Audio/Sink node.name=Virtual_Sink node.description=\'Virtual_Sink\'" --playback-props="media.class=Audio/Source node.name=Virtual_Source node.description=\'Virtual_Microphone\'"\x1b[0m');
console.log('🌟  \x1b[1;33mCRITICAL ROUTING NOTICE:\x1b[0m If your system default microphone automatically changes to "Virtual_Source" (silence),');
console.log('    it will stream silent chunks to Gemini, resulting in NO translation output. To override and target a physical mic, use:');
console.log(`    \x1b[36mnode cli-translator.js --source <your_physical_mic_name_or_id>\x1b[0m\n`);

// Perform some quick Pipewire/PulseAudio node diagnostics on startup
try {
  console.log('🔍 \x1b[34m[SYSTEM AUDIO ROUTING DIAGNOSTICS]\x1b[0m');
  if (usePipewire) {
    const nodes = execSync('pw-link -i -o 2>/dev/null', { encoding: 'utf8' });
    console.log('Active Pipewire I/O Links:\n' + (nodes.trim() || 'No active links found. (Checking loopback nodes other ways...)'));
  }
  const sources = execSync('pactl list sources short 2>/dev/null || true', { encoding: 'utf8' });
  if (sources.trim()) {
    console.log('\n--- PulseAudio/PipeWire Sources (Capture devices) ---');
    console.log(sources.trim());
    console.log('\n💡 Tip: Look at the names/IDs above. If you see your physical microphone, pass its ID/Name via the --source option!');
  }
  const sinks = execSync('pactl list sinks short 2>/dev/null || true', { encoding: 'utf8' });
  if (sinks.trim()) {
    console.log('\n--- PulseAudio/PipeWire Sinks (Playback targets) ---');
    console.log(sinks.trim());
  }
} catch (diagErr) {
  console.log('⚠️  Could not run complete command diagnostics, continuing to app startup...');
}
console.log('\x1b[34m────────────────────────────────────────────────────────\x1b[0m\n');

// Clean start for the physical debug audio translation trace file
const DEBUG_AUDIO_FILE = './debug_received_english.pcm';
try {
  if (fs.existsSync(DEBUG_AUDIO_FILE)) {
    fs.unlinkSync(DEBUG_AUDIO_FILE);
  }
} catch (e) {}

async function main() {
  console.log('📡 Connecting to Gemini Live Translate API...');
  
  let session;
  try {
    session = await ai.live.connect({
      model: "gemini-3.5-live-translate-preview",
      config: {
        responseModalities: ["AUDIO"],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: {
          targetLanguageCode: "en",
          echoTargetLanguage: false
        }
      },
      callbacks: {
        onopen: () => {
          console.log('\x1b[32m🟩 Gemini Live API Connected successfully!\x1b[0m');
          console.log('\x1b[1mSpeak in Russian and listen/route the translated English output.\x1b[0m');
          console.log('----------------------------------------------------');
          startAudioStreaming(session);
        },
        onmessage: (message) => {
          const content = message.serverContent;
          if (content) {
            if (content.inputTranscription?.text) {
              process.stdout.write(`🇷🇺  Russian Input:  \x1b[33m${content.inputTranscription.text}\x1b[0m\n`);
            }
            if (content.outputTranscription?.text) {
              process.stdout.write(`🇺🇸  English Translation: \x1b[32;1m${content.outputTranscription.text}\x1b[0m\n`);
            }
            if (content.modelTurn?.parts) {
              let audioPartsCount = 0;
              let totalAudioBytes = 0;
              for (const part of content.modelTurn.parts) {
                if (part.inlineData) {
                  audioPartsCount++;
                  const rawData = Buffer.from(part.inlineData.data, 'base64');
                  totalAudioBytes += rawData.length;
                  
                  // Progressively write translated audio PCM into physical file
                  try {
                    fs.appendFileSync(DEBUG_AUDIO_FILE, rawData);
                  } catch (writeErr) {
                    console.error('⚠️ Failed to append to diagnostic sound file:', writeErr.message);
                  }

                  // Direct binary audio playback channel
                  playTranslatedPcm(part.inlineData.data);
                }
              }
              if (audioPartsCount > 0) {
                console.log(`📡 [Audio Received] Decoded ${audioPartsCount} English speech frames (${totalAudioBytes} bytes) from Gemini and streamed to local playback.`);
                console.log(`💾 [Diag File Log] Appended to ${DEBUG_AUDIO_FILE} (size: ${fs.statSync(DEBUG_AUDIO_FILE).size} bytes). Run 'pw-play --rate=24000 ${DEBUG_AUDIO_FILE}' to local-test!`);
              }
            }
          }
        },
        onerror: (err) => {
          console.error('\n\x1b[31m❌ Live Session error:\x1b[0m', err.message || err);
        },
        onclose: (evt) => {
          console.log('\n\x1b[31m🔌 Session closed:\x1b[0m', evt.reason || 'Remote hangup');
          process.exit(0);
        }
      }
    });
  } catch (err) {
    console.error('\x1b[31m❌ Failed to establish live session:\x1b[0m', err);
    process.exit(1);
  }
}

// Helper to generate a WAV header for streaming (huge size)
function createWavHeader(sampleRate, numChannels, bitsPerSample) {
  const buffer = Buffer.alloc(44);
  
  // RIFF identifier
  buffer.write('RIFF', 0);
  // We use a very large size to represent a continuous stream
  buffer.writeUInt32LE(2147483647, 4); 
  buffer.write('WAVE', 8);
  
  // Format chunk identifier
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // Linear PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  buffer.writeUInt32LE(byteRate, 28);
  const blockAlign = (numChannels * bitsPerSample) / 8;
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  
  // Data chunk identifier
  buffer.write('data', 36);
  buffer.writeUInt32LE(2147483603, 40); // Large length
  
  return buffer;
}

let playbackProcess = null;
let isPlaybackHeaderSent = false;
let chunkCount = 0;
let totalBytesSent = 0;

function playTranslatedPcm(base64Audio) {
  if (!playbackProcess) {
    const args = usePipewire 
      ? [
          `--target=${TARGET_SINK}`,
          '-'
        ]
      : [
          '-t', 'raw',
          '-f', 'S16_LE',
          '-r', `${PLAYBACK_RATE}`,
          '-c', '1',
          '-D', TARGET_SINK === 'Virtual_Sink' ? 'default' : TARGET_SINK,
          '-'
        ];

    const cmd = usePipewire ? 'pw-play' : 'aplay';
    console.log(`🔊 [Playback Channel] Spawning standard audio player: \x1b[32m${cmd} ${args.join(' ')}\x1b[0m`);
    
    playbackProcess = spawn(cmd, args);
    isPlaybackHeaderSent = false;

    playbackProcess.on('error', (err) => {
      console.error(`\x1b[31m❌ Playback process error:\x1b[0m`, err.message);
    });

    // Capture and display playback utility errors for user diagnosis
    playbackProcess.stderr.on('data', (data) => {
      console.warn(`\x1b[33m[Audio Playback Warning] >>> ${data.toString().trim()}\x1b[0m`);
    });

    playbackProcess.on('close', (code) => {
      console.log(`🔊 [Playback Channel] Playback process closed with code: ${code}`);
      playbackProcess = null;
      isPlaybackHeaderSent = false;
    });
  }

  if (playbackProcess && playbackProcess.stdin.writable) {
    try {
      const audioBuffer = Buffer.from(base64Audio, 'base64');
      
      // For PipeWire, prepend a standard WAV container header so pw-play understands it
      if (usePipewire && !isPlaybackHeaderSent) {
        const header = createWavHeader(PLAYBACK_RATE, 1, 16);
        playbackProcess.stdin.write(header);
        isPlaybackHeaderSent = true;
        console.log(`🔊 [Playback Channel] Pre-pended standard WAV header to stdin stream.`);
      }

      playbackProcess.stdin.write(audioBuffer);
    } catch (e) {
      console.error(`❌ Playback channel buffering failure:`, e.message);
    }
  }
}

function startAudioStreaming(session) {
  let recordProcess;
  const cmd = usePipewire ? 'pw-record' : 'arecord';
  const args = usePipewire
    ? [
        '--format=s16',
        `--rate=${RECORD_RATE}`,
        '--channels=1',
        ...(CAPTURE_SOURCE ? [`--target=${CAPTURE_SOURCE}`] : []),
        '-'
      ]
    : [
        '-t', 'raw',
        '-f', 'S16_LE',
        '-r', `${RECORD_RATE}`,
        '-c', '1',
        ...(CAPTURE_SOURCE ? ['-D', CAPTURE_SOURCE] : []),
        '-'
      ];

  console.log(`🎙️  [Audio Capture] Spawning driver: \x1b[34m${cmd} ${args.join(' ')}\x1b[0m`);

  try {
    recordProcess = spawn(cmd, args);
  } catch (err) {
    console.error(`\x1b[31m❌ Critial err: Failed to launch ${cmd} recorder process:\x1b[0m`, err);
    process.exit(1);
  }

  recordProcess.on('error', (err) => {
    console.error(`\x1b[31m❌ Recorder process emit/spawn error:\x1b[0m`, err.message);
  });

  // Pipe Recorder stderr directly so we can diagnose permission/device issues
  recordProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) {
      console.warn(`\x1b[33m[Microphone Hardware Warning] >>> ${msg}\x1b[5m`);
    }
  });

  // Setup timeout to warn user if no mic data is flowing
  const micWarningTimeout = setTimeout(() => {
    if (chunkCount === 0) {
      console.warn('\n\x1b[33m⚠️  WARNING: No audio data has been received from the microphone after 4 seconds!\x1b[0m');
      console.warn('Common causes:');
      console.warn(' 1. Your physical microphone is muted or in use by another application.');
      console.warn(' 2. PipeWire has no default source set. Try verifying with: \x1b[1mpw-record test.wav\x1b[0m');
      console.warn(' 3. Run with ALSA instead by temporarily renaming/disabling pw-record if it is hanging.\n');
    }
  }, 4000);

  console.log('\n\x1b[34m🎙️  [LIVE RECORDING] Speak into your physical microphone now...\x1b[0m');

  let hasSkippedWavHeader = false;

  let silentChunksCount = 0;

  recordProcess.stdout.on('data', (chunk) => {
    let audioData = chunk;
    
    // Auto-detect and strip any WAV file headers produced by pw-record on stdout
    if (usePipewire && !hasSkippedWavHeader) {
      hasSkippedWavHeader = true;
      if (chunk.length >= 44 && chunk.toString('ascii', 0, 4) === 'RIFF') {
        console.log('🎙️  [Audio Capture] Detected auto-generated WAV header from pw-record. Stripping it for safe raw PCM streaming...');
        audioData = chunk.subarray(44);
      }
    }

    if (audioData.length === 0) return;

    // Analyze amplitude to detect 100% digital silence (muted hardware or wrong loopback source node)
    let maxVal = 0;
    for (let i = 0; i < audioData.length; i += 2) {
      if (i + 1 < audioData.length) {
        const sample = audioData.readInt16LE(i);
        const absVal = Math.abs(sample);
        if (absVal > maxVal) maxVal = absVal;
      }
    }

    if (maxVal < 10) {
      silentChunksCount++;
      if (silentChunksCount === 80) { // after ~8-10 seconds of pure silence
        console.warn('\n\x1b[33m⚠️  AUDIO STAGE WARNING: Captured stream is 100% digitally silent (flatline)!\x1b[0m');
        console.warn('   This usually means your physical microphone is muted in your OS settings or');
        console.warn('   PipeWire was routed to your Virtual_Source/Sink instead of your physical voice capture device.');
        console.warn('   Run standard diagnostics or launch with explicit input:');
        console.warn('   \x1b[36mnode cli-translator.js --source <your-physical-microphone-id-or-name>\x1b[0m\n');
      }
    } else {
      if (silentChunksCount >= 80) {
        console.log('\n\x1b[32m🎤 [Voice Stream] Real audio signal detected! Mute or silence resolved.\x1b[0m\n');
      }
      silentChunksCount = 0;
    }

    chunkCount++;
    totalBytesSent += audioData.length;
    
    // Periodically report streaming health status to terminal (every 40 chunks = ~4-5s)
    if (chunkCount % 40 === 0) {
      process.stdout.write(`\r\x1b[36m⚡ Streaming active: captured ${chunkCount} chunks (${Math.round(totalBytesSent / 1024)} KB sent)\x1b[0m`);
    }

    if (session) {
      try {
        session.sendRealtimeInput({
          audio: {
            data: audioData.toString('base64'),
            mimeType: `audio/pcm;rate=${RECORD_RATE}`
          }
        });
      } catch (err) {
        console.error(`\r❌ Error sending audio to Gemini Live:`, err.message);
      }
    }
  });

  recordProcess.on('close', (code) => {
    clearTimeout(micWarningTimeout);
    console.log(`\n🎙️  Recorder process closed (Exit Code: ${code})`);
    if (session) {
      console.log('🔌 Shutting down Gemini live session...');
      session.close();
    }
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down translator CLI session gracefully...');
    try {
      recordProcess.kill('SIGINT');
    } catch(e){}
    if (playbackProcess) {
      try {
        playbackProcess.kill('SIGINT');
      } catch(e){}
    }
    process.exit(0);
  });
}

main();
