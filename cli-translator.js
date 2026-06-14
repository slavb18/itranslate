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

// Detect audio command utility
let usePipewire = false;
try {
  execSync('which pw-record', { stdio: 'ignore' });
  usePipewire = true;
} catch (e) {
  usePipewire = false;
}

console.log(`🤖 System Detection: \x1b[35m${usePipewire ? 'PipeWire (pw-record/pw-play)' : 'ALSA (arecord/aplay)'}\x1b[0m`);
console.log(`🎙️  Mic capture rate: \x1b[33m16kHz Mono 16-bit signed PCM\x1b[0m`);
console.log(`🔊  Playback output target: \x1b[32m${TARGET_SINK}\x1b[0m`);
console.log('💡  Make sure your loopback devices are created using pw-loopback:');
console.log('    \x1b[34mpw-loopback -m "[ FL FR ]" --capture-props="media.class=Audio/Sink node.name=Virtual_Sink node.description=\'Virtual_Sink\'" --playback-props="media.class=Audio/Source node.name=Virtual_Source node.description=\'Virtual_Microphone\'"\x1b[0m\n');

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
              for (const part of content.modelTurn.parts) {
                if (part.inlineData) {
                  // Direct binary audio playback channel
                  playTranslatedPcm(part.inlineData.data);
                }
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

let playbackProcess = null;

function playTranslatedPcm(base64Audio) {
  if (!playbackProcess) {
    if (usePipewire) {
      playbackProcess = spawn('pw-play', [
        '--format=s16',
        `--rate=${PLAYBACK_RATE}`,
        '--channels=1',
        `--target=${TARGET_SINK}`,
        '-'
      ]);
    } else {
      // Fallback: standard aplay device routing
      playbackProcess = spawn('aplay', [
        '-t', 'raw',
        '-f', 'S16_LE',
        '-r', `${PLAYBACK_RATE}`,
        '-c', '1',
        '-D', TARGET_SINK === 'Virtual_Sink' ? 'default' : TARGET_SINK,
        '-'
      ]);
    }

    playbackProcess.on('error', (err) => {
      console.error('Playback utility execution error:', err.message);
    });

    playbackProcess.on('close', () => {
      playbackProcess = null;
    });
  }

  if (playbackProcess && playbackProcess.stdin.writable) {
    try {
      const audioBuffer = Buffer.from(base64Audio, 'base64');
      playbackProcess.stdin.write(audioBuffer);
    } catch (e) {
      // handle partial pipe write limits
    }
  }
}

function startAudioStreaming(session) {
  let recordProcess;

  if (usePipewire) {
    recordProcess = spawn('pw-record', [
      '--format=s16',
      `--rate=${RECORD_RATE}`,
      '--channels=1',
      '-'
    ]);
  } else {
    // Fallback: standard arecord capturing audio
    recordProcess = spawn('arecord', [
      '-t', 'raw',
      '-f', 'S16_LE',
      '-r', `${RECORD_RATE}`,
      '-c', '1',
      '-'
    ]);
  }

  console.log('\n\x1b[34m🎙️  [LIVE RECORDING] Speak into your physical microphone now...\x1b[0m');

  recordProcess.stdout.on('data', (chunk) => {
    if (session) {
      session.sendRealtimeInput({
        audio: {
          data: chunk.toString('base64'),
          mimeType: `audio/pcm;rate=${RECORD_RATE}`
        }
      });
    }
  });

  recordProcess.stderr.on('data', (data) => {
    // Quietly ignore command logging
  });

  recordProcess.on('close', (code) => {
    console.log(`\nRecorder stopped (Code: ${code})`);
    if (session) session.close();
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down translator CLI session gracefully...');
    recordProcess.kill('SIGINT');
    if (playbackProcess) playbackProcess.kill('SIGINT');
    process.exit(0);
  });
}

main();
