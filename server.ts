import express from "express";
import path from "path";
import http from "http";
import ws, { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();
const PORT = 3000;

// Initialize Google Gen AI
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("Warning: GEMINI_API_KEY environment variable is not set. Real-time translation will not function.");
}

const ai = new GoogleGenAI({
  apiKey: apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// A simple API health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", hasApiKey: !!apiKey });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server for live translation
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (clientWs: WebSocket) => {
  console.log("Web client connected to WebSocket proxy");
  let geminiSession: any = null;
  let isClosed = false;

  const closeGeminiSession = () => {
    if (geminiSession) {
      try {
        geminiSession.close();
      } catch (err) {
        console.error("Error closing Gemini session:", err);
      }
      geminiSession = null;
    }
  };

  clientWs.on("close", () => {
    console.log("Web client disconnected");
    isClosed = true;
    closeGeminiSession();
  });

  clientWs.on("error", (err) => {
    console.error("Client WS error:", err);
    isClosed = true;
    closeGeminiSession();
  });

  // Target language code - defaults to English ('en')
  let currentTargetLanguage = "en";

  const initGeminiLiveSession = async (targetLanguage: string) => {
    closeGeminiSession();

    if (!apiKey) {
      clientWs.send(JSON.stringify({ 
        type: "error", 
        error: "GEMINI_API_KEY is missing on the server. Please check the Secrets settings of AI Studio." 
      }));
      return;
    }

    try {
      console.log(`Initializing Gemini Live Translate to target language: ${targetLanguage}`);
      clientWs.send(JSON.stringify({ type: "status", status: "connecting", targetLanguage }));

      geminiSession = await ai.live.connect({
        model: "gemini-3.5-live-translate-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: {
            targetLanguageCode: targetLanguage,
            echoTargetLanguage: false,
          }
        },
        callbacks: {
          onopen: () => {
            console.log("Connected to Gemini Live Translate API");
            if (!isClosed) {
              clientWs.send(JSON.stringify({ type: "status", status: "connected", targetLanguage }));
            }
          },
          onmessage: (message: any) => {
            if (isClosed) return;

            const serverContent = message.serverContent;
            if (serverContent) {
              // Handle input transcription (original speech text)
              if (serverContent.inputTranscription) {
                clientWs.send(JSON.stringify({
                  type: "inputTranscription",
                  text: serverContent.inputTranscription.text,
                  languageCode: serverContent.inputTranscription.languageCode
                }));
              }

              // Handle output transcription (translated speech text)
              if (serverContent.outputTranscription) {
                clientWs.send(JSON.stringify({
                  type: "outputTranscription",
                  text: serverContent.outputTranscription.text,
                  languageCode: serverContent.outputTranscription.languageCode
                }));
              }

              // Handle audio parts
              if (serverContent.modelTurn?.parts) {
                for (const part of serverContent.modelTurn.parts) {
                  if (part.inlineData) {
                    clientWs.send(JSON.stringify({
                      type: "audio",
                      data: part.inlineData.data // base64-encoded PCM (24kHz)
                    }));
                  }
                }
              }
            }
          },
          onerror: (err: any) => {
            console.error("Gemini Live translation error:", err);
            if (!isClosed) {
              clientWs.send(JSON.stringify({ type: "error", error: err.message || "Gemini translation error" }));
            }
          },
          onclose: (evt: any) => {
            console.log("Gemini Live session closed:", evt);
            if (!isClosed) {
              clientWs.send(JSON.stringify({ type: "status", status: "closed", reason: evt.reason || "session closed" }));
            }
          }
        }
      });
    } catch (err: any) {
      console.error("Failed to connect to Gemini Live Translate API:", err);
      if (!isClosed) {
        clientWs.send(JSON.stringify({ type: "error", error: err.message || "Failed to establish live session" }));
      }
    }
  };

  // Initialize the session immediately with English target language
  await initGeminiLiveSession(currentTargetLanguage);

  clientWs.on("message", async (data: Buffer | string) => {
    if (isClosed) return;

    try {
      const message = JSON.parse(data.toString());

      if (message.type === "audio" && message.data) {
        // We expect raw mono 16kHz PCM audio
        if (geminiSession) {
          geminiSession.sendRealtimeInput({
            audio: {
              data: message.data, // base64-encoded PCM
              mimeType: "audio/pcm;rate=16000"
            }
          });
        }
      } else if (message.type === "config") {
        if (message.targetLanguageCode && message.targetLanguageCode !== currentTargetLanguage) {
          currentTargetLanguage = message.targetLanguageCode;
          console.log(`Client requested target language change to: ${currentTargetLanguage}`);
          await initGeminiLiveSession(currentTargetLanguage);
        }
      }
    } catch (err) {
      console.error("Error parsing message from client WS:", err);
    }
  });
});

// Upgrade HTTP requests for WebSocket connection
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname;
  if (pathname === "/api/live-translate-ws") {
    wss.handleUpgrade(request, socket, head, (wsConnection) => {
      wss.emit("connection", wsConnection, request);
    });
  } else {
    socket.destroy();
  }
});

// Mount Vite middleware in development or static serving in production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
