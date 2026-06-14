import React, { useState, useEffect, useRef } from "react";
import { 
  Mic, 
  MicOff, 
  Volume2, 
  VolumeX, 
  Wifi, 
  WifiOff, 
  Settings, 
  Play, 
  Terminal, 
  Copy, 
  Check, 
  RefreshCw, 
  Languages, 
  RotateCcw,
  Volume1,
  MessageSquare,
  ArrowRight,
  Info
} from "lucide-react";

interface LogSegment {
  id: string;
  russian: string;
  english: string;
  timestamp: string;
}

const SUPPORTED_LANGUAGES = [
  { name: "English (US/UK)", code: "en", flag: "🇺🇸" },
  { name: "Spanish (Español)", code: "es", flag: "es" },
  { name: "German (Deutsch)", code: "de", flag: "🇩🇪" },
  { name: "French (Français)", code: "fr", flag: "🇫🇷" },
  { name: "Italian (Italiano)", code: "it", flag: "🇮🇹" },
  { name: "Japanese (日本語)", code: "ja", flag: "🇯🇵" },
  { name: "Chinese Simplified (中文)", code: "zh-Hans", flag: "🇨🇳" },
  { name: "Arabic (العربية)", code: "ar", flag: "🇸🇦" }
];

export default function App() {
  const [activeTab, setActiveTab] = useState<"web" | "cli">("web");
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Real-time translation states
  const [targetLang, setTargetLang] = useState("en");
  const [russianAccumulated, setRussianAccumulated] = useState("");
  const [englishAccumulated, setEnglishAccumulated] = useState("");
  const [currentRussian, setCurrentRussian] = useState("");
  const [currentEnglish, setCurrentEnglish] = useState("");
  const [dialogueHistory, setDialogueHistory] = useState<LogSegment[]>([]);
  
  // CLI instructions tab states
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLoopback, setCopiedLoopback] = useState(false);

  // References for WebSockets and Audio
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const inputProcessorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);

  // Canvas refs for visualizer waves
  const inputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);

  // Clear translation logs
  const clearLogs = () => {
    setRussianAccumulated("");
    setEnglishAccumulated("");
    setCurrentRussian("");
    setCurrentEnglish("");
    setDialogueHistory([]);
  };

  // Convert buffer to base64
  const bufferToBase64 = (buffer: ArrayBuffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  };

  // Start the Live Translate Web Session
  const startSession = async () => {
    setErrorMsg(null);
    setStatus("connecting");
    setIsRecording(true);

    try {
      // 1. Request microphone permissions from active standard devices
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;

      // 2. Open standard secure/insecure client websocket proxy connection
      const isHttps = window.location.protocol === "https:";
      const wsUrl = `${isHttps ? "wss:" : "ws:"}//${window.location.host}/api/live-translate-ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // 3. Setup Audio contexts
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      
      // Standard input Context resampled directly to 16kHz for Gemini input
      const inputAudioCtx = new AudioContextClass({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputAudioCtx;
      
      // Standard output Context resampled to 24kHz for translated speech audio
      const outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });
      outputAudioCtxRef.current = outputAudioCtx;

      // 4. Input Analysis and capturing script processor
      const source = inputAudioCtx.createMediaStreamSource(stream);
      
      const inputAnalyser = inputAudioCtx.createAnalyser();
      inputAnalyser.fftSize = 128;
      inputAnalyserRef.current = inputAnalyser;

      const outputAnalyser = outputAudioCtx.createAnalyser();
      outputAnalyser.fftSize = 128;
      outputAnalyserRef.current = outputAnalyser;

      // Connect source sound down to the script processor
      const processor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
      inputProcessorNodeRef.current = processor;

      source.connect(inputAnalyser);
      inputAnalyser.connect(processor);
      processor.connect(inputAudioCtx.destination);

      nextStartTimeRef.current = 0;

      // Streaming processor logic
      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const channelData = e.inputBuffer.getChannelData(0);
        
        // Convert Float32 buffer to Int16 PCM array
        const pcmBuffer = new Int16Array(channelData.length);
        for (let i = 0; i < channelData.length; i++) {
          const s = Math.max(-1, Math.min(1, channelData[i]));
          pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const base64AudioChunk = bufferToBase64(pcmBuffer.buffer);
        ws.send(JSON.stringify({ type: "audio", data: base64AudioChunk }));
      };

      // WS handlers
      ws.onopen = () => {
        console.log("WebSocket connected to proxy");
        // Apply initially configured target language immediately
        ws.send(JSON.stringify({ type: "config", targetLanguageCode: targetLang }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === "status") {
          if (msg.status === "connected") {
            setStatus("connected");
          } else if (msg.status === "connecting") {
            setStatus("connecting");
          } else if (msg.status === "closed") {
            setStatus("disconnected");
          }
        } else if (msg.type === "error") {
          setErrorMsg(msg.error);
          setStatus("error");
          stopSession();
        } else if (msg.type === "inputTranscription") {
          // Accumulate Russian speech text
          const text = msg.text || "";
          setCurrentRussian(text);
          
          // If we receive text that completes, commit it to history
          if (text) {
            setRussianAccumulated(prev => {
              if (prev.endsWith(text) || text.includes(prev)) return text;
              return prev.length > 500 ? text : prev + " " + text;
            });
          }
        } else if (msg.type === "outputTranscription") {
          // Accumulate translated English speech text
          const text = msg.text || "";
          setCurrentEnglish(text);

          if (text) {
            setEnglishAccumulated(prev => {
              if (prev.endsWith(text) || text.includes(prev)) return text;
              return prev.length > 500 ? text : prev + " " + text;
            });
          }
        } else if (msg.type === "audio") {
          // Play returned 24kHz audio stream chunks securely
          playReturnedAudio(msg.data);
        }
      };

      ws.onerror = (err) => {
        console.error("WS client error:", err);
        setStatus("error");
        setErrorMsg("WebSocket connection failed. Ensure the server is online.");
      };

      ws.onclose = () => {
        console.log("WS proxy connection closed");
        setStatus("disconnected");
      };

      // Start frequencies render loop animation
      startVisualizationLoop();

    } catch (err: any) {
      console.error("Audio/WS session initialization failed:", err);
      setStatus("error");
      setErrorMsg(err.message || "Failed to access host microphone or audio hardware.");
      stopSession();
    }
  };

  // Play output audio PCM chunk safely
  const playReturnedAudio = (base64Data: string) => {
    const audioCtx = outputAudioCtxRef.current;
    if (!audioCtx || audioCtx.state === "suspended") return;

    try {
      const binaryString = window.atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const numSamples = len / 2;
      const floatData = new Float32Array(numSamples);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < numSamples; i++) {
        const intSample = view.getInt16(i * 2, true); // true for little-endian
        floatData[i] = intSample / 32768.0;
      }

      const audioBuffer = audioCtx.createBuffer(1, numSamples, 24000);
      audioBuffer.getChannelData(0).set(floatData);

      const sourceNode = audioCtx.createBufferSource();
      sourceNode.buffer = audioBuffer;

      // Connect source node to analyser and to Speakers output
      if (outputAnalyserRef.current) {
        sourceNode.connect(outputAnalyserRef.current);
      }
      sourceNode.connect(audioCtx.destination);

      // Smooth scheduling to avoid audio clips/gaps
      const currentTime = audioCtx.currentTime;
      if (nextStartTimeRef.current < currentTime) {
        // Safe buffer start
        nextStartTimeRef.current = currentTime + 0.04;
      }

      sourceNode.start(nextStartTimeRef.current);
      nextStartTimeRef.current += audioBuffer.duration;

    } catch (e) {
      console.error("Error decoding playback audio data chunks", e);
    }
  };

  // Stop current active sessions and release mic controls
  const stopSession = () => {
    setIsRecording(false);
    if (status !== "error") {
      setStatus("disconnected");
    }

    // Cancel animation viz loops
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }

    // Terminate sound processes
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (inputProcessorNodeRef.current) {
      try {
        inputProcessorNodeRef.current.disconnect();
      } catch (e) {}
      inputProcessorNodeRef.current = null;
    }

    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(track => track.stop());
      audioStreamRef.current = null;
    }

    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close();
      inputAudioCtxRef.current = null;
    }

    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close();
      outputAudioCtxRef.current = null;
    }

    // Save final lines into accumulated list logging
    if (currentRussian || currentEnglish) {
      setDialogueHistory(prev => [
        ...prev,
        {
          id: Date.now().toString(),
          russian: currentRussian || "...",
          english: currentEnglish || "...",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        }
      ]);
      setCurrentRussian("");
      setCurrentEnglish("");
    }
  };

  // Trigger changing the language configuration dynamically
  const handleLanguageChange = (code: string) => {
    setTargetLang(code);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "config", targetLanguageCode: code }));
    }
  };

  // Dynamic frequency visualizer rendering logic
  const startVisualizationLoop = () => {
    const draw = () => {
      // 1. Draw Input waves (Russian Microphone)
      if (inputCanvasRef.current && inputAnalyserRef.current) {
        const canvas = inputCanvasRef.current;
        const ctx = canvas.getContext("2d");
        const analyser = inputAnalyserRef.current;
        
        if (ctx) {
          const bufferLength = analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          analyser.getByteTimeDomainData(dataArray);

          ctx.fillStyle = "rgba(10, 15, 30, 0.4)";
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          ctx.lineWidth = 2.5;
          ctx.strokeStyle = "#38bdf8"; // Neon light blue
          ctx.beginPath();

          const sliceWidth = canvas.width / bufferLength;
          let x = 0;

          for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = (v * canvas.height) / 2;

            if (i === 0) {
              ctx.moveTo(x, y);
            } else {
              ctx.lineTo(x, y);
            }

            x += sliceWidth;
          }

          ctx.lineTo(canvas.width, canvas.height / 2);
          ctx.stroke();
        }
      }

      // 2. Draw Output waves (English Translated Speech)
      if (outputCanvasRef.current && outputAnalyserRef.current) {
        const canvas = outputCanvasRef.current;
        const ctx = canvas.getContext("2d");
        const analyser = outputAnalyserRef.current;

        if (ctx) {
          const bufferLength = analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          analyser.getByteFrequencyData(dataArray);

          ctx.fillStyle = "rgba(10, 15, 30, 0.4)";
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const barWidth = (canvas.width / bufferLength) * 1.8;
          let barHeight;
          let x = 0;

          for (let i = 0; i < bufferLength; i++) {
            barHeight = dataArray[i] / 1.5;

            // Draw beautiful neon green bars
            ctx.fillStyle = `rgb(34, 197, 94)`;
            ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

            x += barWidth + 2;
          }
        }
      }

      animationFrameIdRef.current = requestAnimationFrame(draw);
    };

    draw();
  };

  // Safe teardown on React unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
    };
  }, []);

  const copyCodeToClipboard = () => {
    const code = `#!/usr/bin/env node
import { spawn, execSync } from 'child_process';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('\\x1b[31mError: GEMINI_API_KEY is not set!\\x1b[0m');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: API_KEY });

async function main() {
  console.log('📡 Connecting to Gemini Live Translate...');
  const session = await ai.live.connect({
    model: "gemini-3.5-live-translate-preview",
    config: {
      responseModalities: ["AUDIO"],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      translationConfig: { targetLanguageCode: "en", echoTargetLanguage: false }
    },
    callbacks: {
      onopen: () => console.log('\\x1b[32m🟩 Connected! Speak Russian now.\\x1b[0m'),
      onmessage: (msg) => {
        const content = msg.serverContent;
        if (content) {
          if (content.inputTranscription?.text) process.stdout.write(\`🇷🇺: \${content.inputTranscription.text}\\n\`);
          if (content.outputTranscription?.text) process.stdout.write(\`🇺🇸: \${content.outputTranscription.text}\\n\`);
          if (content.modelTurn?.parts) {
            for (const part of content.modelTurn.parts) {
              if (part.inlineData) playAudio(part.inlineData.data);
            }
          }
        }
      }
    }
  });
  
  // Records raw voice from physical microphone
  let hasSkippedWav = false;
  const recorder = spawn('pw-record', ['--format=s16', '--rate=16000', '--channels=1', '-']);
  recorder.stdout.on('data', c => {
    let audio = c;
    if (!hasSkippedWav) {
      hasSkippedWav = true;
      if (c.length >= 44 && c.toString('ascii', 0, 4) === 'RIFF') audio = c.subarray(44);
    }
    if (audio.length > 0) {
      session.sendRealtimeInput({ audio: { data: audio.toString('base64'), mimeType: "audio/pcm;rate=16000" } });
    }
  });
}

function createWavHeader(rate, ch, bits) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(2147483647, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(ch, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE((rate * ch * bits) / 8, 28);
  b.writeUInt16LE((ch * bits) / 8, 32); b.writeUInt16LE(bits, 34); b.write('data', 36); b.writeUInt32LE(2147483603, 40);
  return b;
}

let player = null;
let playerHeaderSent = false;
function playAudio(base64) {
  if (!player) {
    player = spawn('pw-play', ['--target=Virtual_Sink', '-']);
    playerHeaderSent = false;
    player.on('close', () => { player = null; playerHeaderSent = false; });
  }
  if (!playerHeaderSent) {
    player.stdin.write(createWavHeader(24000, 1, 16));
    playerHeaderSent = true;
  }
  player.stdin.write(Buffer.from(base64, 'base64'));
}
main();`;
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const copyLoopbackCommand = () => {
    const cmd = `pw-loopback -m '[ FL FR ]' --capture-props='media.class=Audio/Sink node.name=Virtual_Sink node.description="Virtual_Sink"' --playback-props='media.class=Audio/Source node.name=Virtual_Source node.description="Virtual_Microphone"'`;
    navigator.clipboard.writeText(cmd);
    setCopiedLoopback(true);
    setTimeout(() => setCopiedLoopback(false), 2000);
  };

  const getLanguageName = (code: string) => {
    const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
    return lang ? lang.name : "English";
  };

  return (
    <div className="min-h-screen bg-slate-950 font-sans text-slate-100 antialiased flex flex-col selection:bg-sky-500 selection:text-white" id="main_container">
      
      {/* Upper Navigation bar with status and tabs */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-50 px-4 py-3 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-gradient-to-tr from-sky-600 to-indigo-600 rounded-lg shadow-inner">
              <Languages className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-sky-400 via-indigo-200 to-emerald-400 bg-clip-text text-transparent">
                Gemini Voice Translate
              </h1>
              <p className="text-xs text-slate-400">Real-time speech-to-speech engine</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Status indicator bar */}
            <div className={`inline-flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold ${
              status === "connected" ? "bg-emerald-950/80 text-emerald-300 border border-emerald-800" :
              status === "connecting" ? "bg-amber-950/80 text-amber-300 border border-amber-800 animate-pulse" :
              status === "error" ? "bg-rose-950/80 text-rose-300 border border-rose-800" :
              "bg-slate-900 text-slate-400 border border-slate-800"
            }`}>
              {status === "connected" && (
                <>
                  <Wifi className="h-3.5 w-3.5 text-emerald-400 animate-pulse" />
                  <span>Gemini live</span>
                </>
              )}
              {status === "connecting" && (
                <>
                  <RefreshCw className="h-3.5 w-3.5 text-amber-400 animate-spin" />
                  <span>Connecting...</span>
                </>
              )}
              {status === "error" && (
                <>
                  <WifiOff className="h-3.5 w-3.5 text-rose-400" />
                  <span>Connection error</span>
                </>
              )}
              {status === "disconnected" && (
                <>
                  <WifiOff className="h-3.5 w-3.5 text-slate-500" />
                  <span>Offline</span>
                </>
              )}
            </div>

            {/* Navigation Tabs */}
            <nav className="flex bg-slate-950 p-1 rounded-lg border border-slate-800" id="nav_tabs">
              <button
                id="btn_tab_web"
                onClick={() => setActiveTab("web")}
                className={`px-4 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all duration-200 ${
                  activeTab === "web"
                    ? "bg-slate-800 text-sky-400 shadow-sm"
                    : "text-slate-400 hover:text-slate-100"
                }`}
              >
                🖥️ Web Application testing
              </button>
              <button
                id="btn_tab_cli"
                onClick={() => setActiveTab("cli")}
                className={`px-4 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all duration-200 ${
                  activeTab === "cli"
                    ? "bg-slate-800 text-sky-400 shadow-sm"
                    : "text-slate-400 hover:text-slate-100"
                }`}
              >
                🔌 CLI Zoom Virtual Mic Setup
              </button>
            </nav>
          </div>

        </div>
      </header>

      {/* Main Container Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {errorMsg && (
          <div className="mb-6 p-4 bg-rose-950/80 border border-rose-800 rounded-xl text-rose-200 text-sm flex items-start space-x-3 shadow-lg">
            <Info className="h-5 w-5 text-rose-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold">Backend Connection Issue</p>
              <p className="text-xs text-rose-300/80 mt-1">{errorMsg}</p>
            </div>
            <button 
              onClick={() => setErrorMsg(null)}
              className="text-xs text-rose-400 hover:text-rose-100 underline underline-offset-2 font-medium"
            >
              Dismiss
            </button>
          </div>
        )}

        {activeTab === "web" ? (
          <div className="space-y-6">
            
            {/* Introductory card */}
            <div className="bg-gradient-to-r from-slate-900 to-indigo-950/40 border border-slate-800 rounded-2xl p-6 relative overflow-hidden" id="web_intro_card">
              <div className="relative z-10 max-w-3xl">
                <span className="text-xs uppercase tracking-wider font-extrabold text-sky-400 px-2.5 py-1 bg-sky-950/80 border border-sky-800 rounded-full">
                  Real-time speech translation protocol
                </span>
                <h2 className="text-2xl font-bold tracking-tight text-white mt-4">
                  Translating Russian microphone speech directly to {getLanguageName(targetLang)} voice output
                </h2>
                <p className="text-slate-400 text-sm mt-2 leading-relaxed">
                  Test the Gemini Live Translate model <code className="bg-slate-950 px-1 py-0.5 rounded text-indigo-300 font-mono text-xs">gemini-3.5-live-translate-preview</code> directly in your browser. 
                  Make sure your microphone is connected, choose the translation language below, and trigger the recording session.
                </p>

                {/* Settings toolbar */}
                <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-slate-800/80 pt-4">
                  <div className="flex items-center space-x-2">
                    <Settings className="h-4 w-4 text-slate-400" />
                    <span className="text-xs text-slate-300 font-medium">Target language:</span>
                  </div>
                  
                  <div className="flex flex-wrap gap-2">
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <button
                        key={lang.code}
                        id={`btn_lang_${lang.code}`}
                        onClick={() => handleLanguageChange(lang.code)}
                        className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-all cursor-pointer ${
                          targetLang === lang.code
                            ? "bg-sky-500/10 border-sky-500 text-sky-300"
                            : "bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        {lang.flag} {lang.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Glowing gradient back decoration */}
              <div className="absolute right-0 top-0 w-80 h-80 bg-indigo-500/10 rounded-full blur-3xl -z-10 pointer-events-none" />
            </div>

            {/* Interactive Control Trigger Panel */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6" id="controls_panel">
              
              {/* Trigger Button component */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between items-center text-center shadow-lg">
                <div className="w-full">
                  <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500 block">Session controller</span>
                  <div className="my-6">
                    {isRecording ? (
                      <div className="relative inline-block">
                        <span className="absolute inset-0 bg-red-500/30 rounded-full animate-ping" />
                        <button
                          id="btn_stop_translation"
                          onClick={stopSession}
                          className="relative h-20 w-20 bg-gradient-to-tr from-rose-600 to-red-500 text-white rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-all shadow-lg hover:shadow-red-500/20 cursor-pointer"
                        >
                          <MicOff className="h-8 w-8" />
                        </button>
                      </div>
                    ) : (
                      <button
                        id="btn_start_translation"
                        onClick={startSession}
                        className="h-20 w-20 bg-gradient-to-tr from-sky-500 to-indigo-600 text-white rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-all shadow-lg hover:shadow-sky-500/25 cursor-pointer"
                      >
                        <Mic className="h-8 w-8 animate-pulse" />
                      </button>
                    )}
                  </div>
                  
                  <h3 className="font-bold text-slate-200">
                    {isRecording ? "Live Translate Active" : "Start Translation Testing"}
                  </h3>
                  <p className="text-xs text-slate-400 mt-2 max-w-xs mx-auto">
                    {isRecording 
                      ? "The system is streaming your local microphone input to Gemini. Speak in Russian details." 
                      : "Click the microphone button to initiate connection. We stream your Russian speech and receive real-time English translation audio."
                    }
                  </p>
                </div>

                <div className="w-full mt-6 pt-4 border-t border-slate-800/60 flex items-center justify-between text-slate-500 text-[11px] font-mono">
                  <span>PCM Mono 16kHz</span>
                  <ArrowRight className="h-3 w-3" />
                  <span>PCM Audio 24kHz</span>
                </div>
              </div>

              {/* Input Wave Visualizer Card */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between shadow-lg">
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500">RU Mic Frequency</span>
                    {isRecording && <span className="h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse" />}
                  </div>
                  <canvas 
                    ref={inputCanvasRef} 
                    className="w-full h-24 bg-slate-950 rounded-xl border border-slate-800"
                    width={400}
                    height={120}
                  />
                  <p className="text-[11px] text-slate-400 mt-3 leading-snug">
                    Displays raw 16kHz wave captured from your microphone. Highly reactive amplitude.
                  </p>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-500 pt-3 border-t border-slate-800/60 font-mono">
                  <span>Input Status</span>
                  <span className={isRecording ? "text-sky-400 font-medium" : ""}>
                    {isRecording ? "ACTIVE STREAM" : "OFFLINE"}
                  </span>
                </div>
              </div>

              {/* Output Wave Visualizer Card */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between shadow-lg">
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500">EN Audio Synthesis</span>
                    {isRecording && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />}
                  </div>
                  <canvas 
                    ref={outputCanvasRef} 
                    className="w-full h-24 bg-slate-950 rounded-xl border border-slate-800"
                    width={400}
                    height={120}
                  />
                  <p className="text-[11px] text-slate-400 mt-3 leading-snug">
                    Displays synthesized speech frequency output from the model. Plays automatically.
                  </p>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-500 pt-3 border-t border-slate-800/60 font-mono">
                  <span>Output Status</span>
                  <span className={currentEnglish ? "text-emerald-400 font-medium" : ""}>
                    {currentEnglish ? "STREAMING PLAYBACK" : "STANDBY"}
                  </span>
                </div>
              </div>

            </div>

            {/* Split Screen Transcription Interface */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" id="transcription_grid">
              
              {/* Left Panel: Russian original */}
              <div className="bg-slate-900/60 border border-slate-850 rounded-2xl p-5 flex flex-col min-h-[250px] shadow-sm relative">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
                  <div className="flex items-center space-x-2">
                    <span className="text-xl">🇷🇺</span>
                    <span className="font-semibold text-slate-200 text-sm">Русская речь (Microphone Input)</span>
                  </div>
                  <button 
                    onClick={() => navigator.clipboard.writeText(russianAccumulated || currentRussian)}
                    className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-800 transition"
                    title="Copy input text"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-4 max-h-[300px] pr-2 scrollbar-none">
                  {russianAccumulated ? (
                    <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-line font-medium">
                      {russianAccumulated}
                    </p>
                  ) : (
                    <div className="text-slate-500 text-xs italic flex flex-col items-center justify-center h-full space-y-2 py-6">
                      <MessageSquare className="h-8 w-8 text-slate-600 animate-pulse" />
                      <span>{isRecording ? "Listening... Speak in Russian" : "Wait for audio capture... Log will populate word by word"}</span>
                    </div>
                  )}

                  {currentRussian && (
                    <div className="p-3 bg-sky-950/30 border border-sky-900/40 rounded-xl text-sky-200 text-xs animate-fade-in font-mono mt-2">
                      <span className="text-sky-400 font-bold mr-1">🎙️ Realtime:</span> {currentRussian}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Panel: English translation */}
              <div className="bg-slate-900/60 border border-slate-850 rounded-2xl p-5 flex flex-col min-h-[250px] shadow-sm relative">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
                  <div className="flex items-center space-x-2">
                    <span className="text-xl">🇺🇸</span>
                    <span className="font-semibold text-slate-200 text-sm">English Output (Gemini Live Translate)</span>
                  </div>
                  <button 
                    onClick={() => navigator.clipboard.writeText(englishAccumulated || currentEnglish)}
                    className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-800 transition"
                    title="Copy English translation"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-4 max-h-[300px] pr-2 scrollbar-none">
                  {englishAccumulated ? (
                    <p className="text-emerald-350 text-sm leading-relaxed whitespace-pre-line font-medium text-emerald-400">
                      {englishAccumulated}
                    </p>
                  ) : (
                    <div className="text-slate-500 text-xs italic flex flex-col items-center justify-center h-full space-y-2 py-6">
                      <Volume1 className="h-8 w-8 text-slate-600" />
                      <span>{isRecording ? "Translating... Audio streams automatically" : "Translation output will display here with voice synthesizer"}</span>
                    </div>
                  )}

                  {currentEnglish && (
                    <div className="p-3 bg-emerald-950/30 border border-emerald-900/40 rounded-xl text-emerald-200 text-xs animate-fade-in font-mono mt-2">
                      <span className="text-emerald-400 font-bold mr-1">🔊 Output:</span> {currentEnglish}
                    </div>
                  )}
                </div>
              </div>

            </div>

            {/* Conversation Log history card */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5" id="history_logs">
              <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
                <div className="flex items-center space-x-2">
                  <RotateCcw className="h-4 w-4 text-sky-400" />
                  <h3 className="font-bold text-slate-200 text-sm">Completed Sentence Logs</h3>
                </div>
                <button 
                  onClick={clearLogs}
                  className="text-xs text-slate-400 hover:text-slate-200 bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-800 transition cursor-pointer flex items-center space-x-1"
                >
                  Clear loghistory
                </button>
              </div>

              {dialogueHistory.length > 0 ? (
                <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2 divide-y divide-slate-800/50">
                  {dialogueHistory.map((seg) => (
                    <div key={seg.id} className="pt-3 first:pt-0 flex flex-col sm:flex-row sm:items-start gap-2 text-xs">
                      <span className="text-slate-500 font-mono flex-shrink-0 w-16">{seg.timestamp}</span>
                      <div className="flex-1 space-y-1">
                        <p className="text-slate-400 font-medium"><span className="text-sky-400">RU:</span> {seg.russian}</p>
                        <p className="text-emerald-400 font-medium"><span className="text-green-500">EN:</span> {seg.english}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500 italic text-center py-6">
                  Session completed sentences history will save here when you turn off translation.
                </p>
              )}
            </div>

          </div>
        ) : (
          /* CLI Tools Zoom Setup Tab */
          <div className="space-y-6" id="cli_view">
            
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6">
              <span className="text-xs uppercase font-extrabold tracking-wider text-rose-400 px-2.5 py-1 bg-rose-950/80 border border-rose-800 rounded-full inline-block">
                Virtual Audio routing module
              </span>
              <h2 className="text-2xl font-bold tracking-tight text-white mt-4">
                Routing Translated Speech directly to Zoom on your Linux/macOS terminal
              </h2>
              <p className="text-slate-400 text-sm mt-2 leading-relaxed">
                By setting up a virtual loopback audio node in PipeWire, anything played into the virtual speaker Node automatically routes to the companion virtual microphone input. 
                Our console Node.js application registers to stream your physical mic input over the Gemini Live API, gets English translation wave chunks, and pipes them straight into the virtual speaker. 
                You can then choose <strong>"Virtual_Microphone"</strong> inside Zoom, Google Meet, or Discord.
              </p>
            </div>

            {/* Step-by-Step guides */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

              {/* Step 1: Virtual source and sink */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between shadow-lg">
                <div>
                  <div className="flex items-center space-x-2.5 mb-3">
                    <span className="h-6 w-6 rounded-full bg-indigo-950 text-indigo-400 flex items-center justify-center font-bold text-xs border border-indigo-800">1</span>
                    <h3 className="font-bold text-slate-200 text-sm">Create loopback audio sink and source</h3>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Execute the following terminal command on your Pipewire system to create the virtual background devices.
                    This command registers a virtual speaker target <code className="text-rose-300 font-mono">Virtual_Sink</code>, and a virtual mic device <code className="text-emerald-300 font-mono">Virtual_Source</code>.
                  </p>

                  <div className="mt-4 bg-slate-950 p-3 rounded-lg border border-slate-850 relative font-mono text-[10px] text-indigo-300 leading-normal select-all">
                    pw-loopback -m '[ FL FR ]' --capture-props='media.class=Audio/Sink node.name=Virtual_Sink node.description="Virtual_Sink"' --playback-props='media.class=Audio/Source node.name=Virtual_Source node.description="Virtual_Microphone"'
                    
                    <button 
                      onClick={copyLoopbackCommand}
                      className="absolute right-2 top-2 p-1.5 bg-slate-900 text-slate-400 hover:text-white rounded border border-slate-800 hover:bg-slate-800 transition cursor-pointer"
                      title="Copy Loopback setup command"
                    >
                      {copiedLoopback ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
                    </button>
                  </div>
                </div>
                <div className="mt-4 p-2.5 bg-slate-950/50 rounded-lg border border-slate-850/50 text-[11px] text-slate-400 flex items-start space-x-2">
                  <Info className="h-4 w-4 text-sky-400 flex-shrink-0 mt-0.5" />
                  <span>After running, you will see a new virtual recording device in your OS voice settings called <strong>"Virtual_Microphone"</strong>.</span>
                </div>
              </div>

              {/* Step 2: Running local Node.js CLI Script */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between shadow-lg">
                <div>
                  <div className="flex items-center space-x-2.5 mb-3">
                    <span className="h-6 w-6 rounded-full bg-indigo-950 text-indigo-400 flex items-center justify-center font-bold text-xs border border-indigo-800">2</span>
                    <h3 className="font-bold text-slate-200 text-sm">Download and Boot Translation CLI Script</h3>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Create a local file named <code className="bg-slate-950 text-sky-300 px-1 py-0.5 rounded font-mono">cli-translator.js</code> on your machine, initialize dependencies, and run with your personal credentials.
                  </p>

                  <div className="space-y-1.5 mt-4 text-[11px] font-mono text-slate-300">
                    <div className="p-2 bg-slate-950 rounded border border-slate-850">
                      npm install @google/genai dotenv
                    </div>
                    <div className="p-2 bg-slate-950 rounded border border-slate-850">
                      export GEMINI_API_KEY="AI_STUDIO_API_KEY"
                    </div>
                    <div className="p-2 bg-slate-950 rounded border border-slate-850">
                      node cli-translator.js
                    </div>
                  </div>
                </div>
                <div className="mt-4 text-[11px] text-slate-400 flex items-center justify-between">
                  <span>Script size: ~5KB standalone ESD</span>
                  <button
                    onClick={copyCodeToClipboard}
                    className="text-xs text-sky-400 hover:text-sky-300 flex items-center space-x-1.5 font-semibold bg-sky-950/40 px-2.5 py-1.5 rounded-lg border border-sky-900"
                  >
                    {copiedCode ? (
                      <>
                        <Check className="h-3 w-3 text-green-400" />
                        <span>Copied JavaScript!</span>
                      </>
                    ) : (
                      <>
                        <Terminal className="h-3 w-3" />
                        <span>Copy cli-translator.js Code</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

            </div>

            {/* Code presentation console panel */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5" id="code_preview_card">
              <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
                <div className="flex items-center space-x-2">
                  <Terminal className="h-4.5 w-4.5 text-rose-400" />
                  <h3 className="font-bold text-slate-200 text-sm">Full cli-translator.js Source Representation</h3>
                </div>
                <button
                  onClick={copyCodeToClipboard}
                  className="text-xs text-slate-400 hover:text-slate-250 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 transition cursor-pointer flex items-center space-x-1"
                >
                  {copiedCode ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedCode ? "Copied" : "Copy full source"}</span>
                </button>
              </div>

              <pre className="p-4 bg-slate-950 rounded-xl border border-slate-850 max-h-[350px] overflow-auto font-mono text-[11px] leading-relaxed text-slate-300">
{`#!/usr/bin/env node

/**
 * 🌐 Russian 🔄 English Real-Time Live Voice Translator CLI
 * Supporting virtual microphone output via PipeWire / ALSA loopback.
 */

import { spawn, execSync } from 'child_process';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('\\x1b[31mError: GEMINI_API_KEY is not set!\\x1b[0m');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

async function main() {
  console.log('📡 Connecting to Gemini Live Translate API...');
  
  const session = await ai.live.connect({
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
        console.log('\\x1b[32m🟩 Connected successfully! Speak Russian now.\\x1b[0m');
        startAudioStreaming(session);
      },
      onmessage: (message) => {
        const content = message.serverContent;
        if (content) {
          if (content.inputTranscription?.text) {
            process.stdout.write(\`🇷🇺 RU: \${content.inputTranscription.text}\\n\`);
          }
          if (content.outputTranscription?.text) {
            process.stdout.write(\`🇺🇸 EN: \${content.outputTranscription.text}\\n\`);
          }
          if (content.modelTurn?.parts) {
            for (const part of content.modelTurn.parts) {
              if (part.inlineData) playTranslatedPcm(part.inlineData.data);
            }
          }
        }
      }
    }
  });
}

// Helper to generate a WAV header for streaming (huge size)
function createWavHeader(sampleRate, numChannels, bitsPerSample) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(2147483647, 4); 
  buffer.write('WAVE', 8);
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
  buffer.write('data', 36);
  buffer.writeUInt32LE(2147483603, 40); // Large length
  return buffer;
}

let playbackProcess = null;
let isPlaybackHeaderSent = false;

function playTranslatedPcm(base64Audio) {
  if (!playbackProcess) {
    playbackProcess = spawn('pw-play', [
      '--target=Virtual_Sink',
      '-'
    ]);
    isPlaybackHeaderSent = false;
    playbackProcess.on('close', () => {
      playbackProcess = null;
      isPlaybackHeaderSent = false;
    });
  }
  if (playbackProcess && playbackProcess.stdin.writable) {
    try {
      if (!isPlaybackHeaderSent) {
        playbackProcess.stdin.write(createWavHeader(24000, 1, 16));
        isPlaybackHeaderSent = true;
      }
      playbackProcess.stdin.write(Buffer.from(base64Audio, 'base64'));
    } catch (e) {}
  }
}

function startAudioStreaming(session) {
  const recordProcess = spawn('pw-record', [
    '--format=s16',
    '--rate=16000',
    '--channels=1',
    '-'
  ]);

  let hasSkippedWavHeader = false;

  recordProcess.stdout.on('data', (chunk) => {
    let audioData = chunk;
    if (!hasSkippedWavHeader) {
      hasSkippedWavHeader = true;
      if (chunk.length >= 44 && chunk.toString('ascii', 0, 4) === 'RIFF') {
        audioData = chunk.subarray(44);
      }
    }

    if (audioData.length === 0) return;

    session.sendRealtimeInput({
      audio: {
        data: audioData.toString('base64'),
        mimeType: "audio/pcm;rate=16000"
      }
    });
  });
}

main();`}
              </pre>
            </div>

          </div>
        )}
      </main>

      {/* Footer credits bar */}
      <footer className="border-t border-slate-900 bg-slate-950 px-4 py-6 sm:px-6 mt-12 text-slate-500 text-xs text-center font-mono">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <span>Real-time Audio resampler protocol powered by Gemini Live Translate</span>
          <div>
            <span>Model: </span>
            <span className="text-sky-400 font-bold bg-sky-950/40 px-2 py-0.5 rounded border border-sky-900">
              gemini-3.5-live-translate-preview
            </span>
          </div>
        </div>
      </footer>

    </div>
  );
}
