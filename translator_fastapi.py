import asyncio
import json
import base64
import time
import os
import webrtcvad
import websockets
from deep_translator import GoogleTranslator
from gtts import gTTS
from tempfile import NamedTemporaryFile
import speech_recognition as sr
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from typing import Dict

# ===================== CONFIG =====================
WS_URL = os.getenv("NGROK_WS_URL", "ws://localhost:8765")  # Override with ngrok URL (e.g. wss://xxxx.ngrok.io)  # Node.js WebSocket server
SOURCE_LANG = "en"              # default source
TARGET_LANG = "hi"              # default target
SAMPLE_RATE = 16000             # audio sample rate expected from client
SAMPLE_WIDTH = 2                # bytes per sample (16-bit PCM)
FRAME_DURATION_MS = 20          # 10, 20 or 30 (webrtcvad requirement)
FRAME_SIZE = int(SAMPLE_RATE * (FRAME_DURATION_MS / 1000.0)) * SAMPLE_WIDTH  # bytes per frame
# ==================================================

# --- Language normalization ---
LANG_ALIASES = {
    "en": "en", "english": "en",
    "hi": "hi", "hindi": "hi",
    "cn": "zh-CN", "zh": "zh-CN", "zh-cn": "zh-CN",
    "zh_cn": "zh-CN", "chinese": "zh-CN",
    "de": "de", "german": "de"
}

def normalize_lang(code: str) -> str:
    if not code:
        return ""
    return LANG_ALIASES.get(code.strip().lower(), code.strip().lower())

# --- Translation / TTS ---
def translate(text, source_lang=None, target_lang=None):
    src = normalize_lang(source_lang or SOURCE_LANG)
    tgt = normalize_lang(target_lang or TARGET_LANG)
    try:
        return GoogleTranslator(source=src, target=tgt).translate(text)
    except Exception as e:
        print(f"[Translation Error] {e}")
        return ""

def tts_mp3_bytes(text, lang=None):
    lng = normalize_lang(lang or TARGET_LANG)
    try:
        with NamedTemporaryFile(delete=False, suffix=".mp3") as fp:
            tmp = fp.name
        gTTS(text=text, lang=lng).save(tmp)
        with open(tmp, "rb") as f:
            data = f.read()
        os.remove(tmp)
        return data
    except Exception as e:
        print(f"[TTS Error] {e}")
        return b""

# (Keepalive removed)

# --- Per-user buffers/state ---
# audio_buffers[username] holds a bytearray of pending bytes (raw PCM16LE)
audio_buffers = {}      # username -> bytearray()
speech_accums = {}      # username -> bytearray() (accumulated speech frames)
silence_counts = {}     # username -> int
user_langs = {}         # username -> {"src":..., "tgt":...}

# thresholds
vad_mode = 2                 # 0..3
vad = webrtcvad.Vad(vad_mode)
max_silence_frames = 30          # ~600ms with 20ms frames - allows full phrases
min_speech_bytes = FRAME_SIZE*2  # minimum speech to attempt recognition (tunable)
max_accumulated_bytes = SAMPLE_RATE * SAMPLE_WIDTH * 6  # 12 seconds safety cap

async def process_user_frames(username, roomId=None):
    """Process frames in audio_buffers[username], using VAD to accumulate speech frames
    and flush when silence detected OR when accumulated size gets large.
    """
    buf = audio_buffers.get(username, bytearray())
    if username not in speech_accums:
        speech_accums[username] = bytearray()
        silence_counts[username] = 0

    while len(buf) >= FRAME_SIZE:
        frame = bytes(buf[:FRAME_SIZE])
        del buf[:FRAME_SIZE]
        try:
            is_speech = vad.is_speech(frame, sample_rate=SAMPLE_RATE)
        except Exception as e:
            print("[VAD error]", e)
            is_speech = True
        if is_speech:
            silence_counts[username] = 0
            speech_accums[username].extend(frame)
        else:
            silence_counts[username] += 1
        if len(speech_accums[username]) >= max_accumulated_bytes:
            await flush_speech(username, roomId)
        if silence_counts[username] >= max_silence_frames and len(speech_accums[username]) >= min_speech_bytes:
            await flush_speech(username, roomId)
    audio_buffers[username] = buf

async def flush_speech(username, roomId=None):
    """Run STT → translate → TTS for accumulated speech for a user and send result to Node."""
    accum = speech_accums.get(username, bytearray())
    if not accum or len(accum) < min_speech_bytes:
        speech_accums[username].clear()
        silence_counts[username] = 0
        return
    recognizer = sr.Recognizer()
    audio_data = sr.AudioData(bytes(accum), SAMPLE_RATE, SAMPLE_WIDTH)
    try:
        src = user_langs.get(username, {}).get("src", SOURCE_LANG)
        tgt = user_langs.get(username, {}).get("tgt", TARGET_LANG)
        # Try STT without blocking the event loop
        def do_stt():
            return recognizer.recognize_google(audio_data, language=src)
        text = await asyncio.to_thread(do_stt)
        print(f"[{username} Recognized] {text}")
    except sr.UnknownValueError:
        text = ""
    except sr.RequestError as e:
        print(f"[{username}] STT RequestError (Rate Limit/Network): {e}")
        # Add a small sleep to naturally back off if hitting limits
        await asyncio.sleep(1)
        text = ""
    speech_accums[username].clear()
    silence_counts[username] = 0
    if not text:
        return
    translated = await asyncio.to_thread(translate, text, src, tgt)
    print(f"[{username} Translated] {translated}")
    mp3_bytes = await asyncio.to_thread(tts_mp3_bytes, translated, tgt)
    if mp3_bytes:
        print(f"[{username}] TTS bytes: {len(mp3_bytes)}")
    payload = {
        "type": "translation",
        "original_text": text,
        "text": translated,
        "audio_b64": base64.b64encode(mp3_bytes).decode("utf-8") if mp3_bytes else "",
        "src": src,
        "tgt": tgt,
        "username": username,
        "roomId": roomId,
        "timestamp": int(time.time() * 1000)
    }
    try:
        if roomId:
            await manager.broadcast(roomId, payload)
        print(f"✅ Sent translation for {username} (room={roomId})")
    except Exception as e:
        print("[WS send error]", e)

# --- WebRTC & Routing ---
# --- WebSocket Client Bridge (Connects to Node.js) ---
async def ws_handler():
    """Connect to Node.js WebSocket server to receive audio chunks and send back translations."""
    while True:
        try:
            print(f"🔄 Connecting to Node.js at {WS_URL}...")
            async with websockets.connect(WS_URL) as ws:
                print("✅ Connected to Node.js server")
                global manager
                # Mock manager so process_user_frames can send via this websocket
                class DummyManager:
                    async def broadcast(self, roomId, payload):
                        await ws.send(json.dumps(payload))
                manager = DummyManager()

                while True:
                    message = await ws.recv()
                    data = json.loads(message)
                    msg_type = data.get("type")
                    username = data.get("username", "unknown")
                    roomId = data.get("roomId", "default")

                    if msg_type == "setLangs":
                        user_langs[username] = {"src": normalize_lang(data.get("src")), "tgt": normalize_lang(data.get("tgt"))}
                        print(f"[{username}] Languages updated: {user_langs[username]}")
                    elif msg_type == "audio":
                        chunk = base64.b64decode(data.get("audio_b64", ""))
                        if username not in audio_buffers:
                            audio_buffers[username] = bytearray()
                            speech_accums[username] = bytearray()
                            silence_counts[username] = 0
                            if username not in user_langs:
                                user_langs[username] = {"src": SOURCE_LANG, "tgt": TARGET_LANG}
                        audio_buffers[username].extend(chunk)
                        await process_user_frames(username, roomId=roomId)
        except Exception as e:
            print(f"❌ WebSocket connection lost: {e}. Retrying in 3s...")
            await asyncio.sleep(3)

app = FastAPI()

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.on_event("startup")
async def startup_event():
    import subprocess
    import sys
    import threading

    # 1. Start the Node server as a background process
    project_root = os.path.abspath(os.path.dirname(__file__))
    
    # Helper to free port 8765 if already in use by a zombie Node process
    def _kill_port(port):
        try:
            output = subprocess.check_output(['netstat', '-ano'], text=True)
            for line in output.splitlines():
                if f':{port}' in line:
                    parts = line.split()
                    if len(parts) >= 5:
                        pid = parts[-1]
                        try:
                            subprocess.run(['taskkill', '/F', '/PID', pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                            print(f"[Port cleanup] Killed PID {pid} on port {port}")
                        except Exception as e:
                            pass
        except Exception:
            pass
            
    _kill_port(8765)
    _kill_port(9000)
    
    print("🚀 Starting Node.js server...")
    proc = subprocess.Popen(
        ["npm.cmd", "run", "start"],
        cwd=project_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=0x00000200,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    app.state.node_process = proc

    def forward_output():
        for line in iter(proc.stdout.readline, ""):
            sys.stdout.buffer.write(("[node] " + line).encode('utf-8', errors='replace'))
            sys.stdout.buffer.flush()
        proc.stdout.close()
    threading.Thread(target=forward_output, daemon=True).start()
    
    # Give Node a second to spin up before Python connects
    await asyncio.sleep(2)
    
    # 2. Start the WebSocket bridge to connect to Node
    asyncio.create_task(ws_handler())

@app.on_event("shutdown")
async def stop_node():
    import signal
    import subprocess
    proc = getattr(app.state, "node_process", None)
    if proc and proc.poll() is None:
        print("🛑 Stopping Node.js server...")
        try:
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        except Exception:
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
