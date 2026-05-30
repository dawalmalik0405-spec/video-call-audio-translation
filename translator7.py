import os
import pyaudio
import json
import logging
import base64
import asyncio
import time
from deep_translator import GoogleTranslator
from gtts import gTTS
import pygame
from tempfile import NamedTemporaryFile
import webrtcvad
import threading
import websockets
import speech_recognition as sr

# ===================== CONFIG =====================
WS_URL = "ws://localhost:8765"   # Node.js WebSocket server
PLAY_LOCALLY = False             # True = also play translated audio locally (pygame)
SOURCE_LANG = "en"               # default fallback source
TARGET_LANG = "hi"               # default fallback target
USERNAME = os.getenv("USERNAME_ALIAS", "unknown")
# ==================================================

# ---------------- Language normalization ----------------
LANG_ALIASES = {
    "en": "en", "english": "en",
    "hi": "hi", "hindi": "hi",
    "cn": "zh-CN", "zh": "zh-CN", "zh-cn": "zh-CN", "zh_cn": "zh-CN", "chinese": "zh-CN",
    "de": "de", "german": "de"
}

def normalize_lang(code: str) -> str:
    if not code:
        return ""
    return LANG_ALIASES.get(code.strip().lower(), code.strip().lower())

# Suppress Vosk internal logs
logging.getLogger("vosk").setLevel(logging.ERROR)

# ---------------- Translation / TTS ----------------
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
        tts = gTTS(text=text, lang=lng)
        tts.save(tmp)
        with open(tmp, "rb") as f:
            data = f.read()
        os.remove(tmp)
        return data
    except Exception as e:
        print(f"[TTS Error] {e}")
        return b""

def speak_local(audio_bytes):
    try:
        with NamedTemporaryFile(delete=False, suffix=".mp3") as fp:
            tmp = fp.name
            fp.write(audio_bytes)
        pygame.mixer.init()
        pygame.mixer.music.load(tmp)
        pygame.mixer.music.play()
        while pygame.mixer.music.get_busy():
            time.sleep(0.05)
        pygame.mixer.quit()
        os.remove(tmp)
    except Exception as e:
        print(f"[Local Play Error] {e}")

# ---------------- WebSocket (send-only) ----------------
# ---------------- WebSocket (send-only) ----------------
# ---------------- WebSocket (send-only) ----------------
async def _send_ws_message(payload: dict):
    global ws_conn
    try:
        if ws_conn is not None:
            await ws_conn.send(json.dumps(payload))
        else:
            print("⚠️ No active WS connection, dropping message:", payload.get("type"))
    except Exception as e:
        print("[WS send error]", e)




def send_ws_message(payload: dict):
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.create_task(_send_ws_message(payload))
        else:
            loop.run_until_complete(_send_ws_message(payload))
    except Exception as e:
        print("[WS run error]", e)


# ---------------- VAD helpers ----------------
vad = webrtcvad.Vad(0)

def is_speech(frame_bytes, sample_rate=16000):
    try:
        return vad.is_speech(frame_bytes, sample_rate)
    except Exception:
        return False

# ---------------- User language state ----------------
user_langs = {}  # { username: {src, tgt} }

ws_conn = None


# ---------------- Chunk buffer ----------------
audio_buffers = {}  # { username: [bytes, bytes, ...] }

last_speech = time.time()

async def handle_audio(username, src, tgt, audio_bytes, roomId=None):
    global audio_buffers, last_speech

    if username not in audio_buffers:
        audio_buffers[username] = []

    # store this chunk
    audio_buffers[username].append(audio_bytes)
    last_speech = time.time()

    # check speech activity
    if not is_speech(audio_bytes) or (time.time() - last_speech) > 2.0:
        # silence detected → flush buffer
        if len(audio_buffers[username]) > 0:
            combined = b"".join(audio_buffers[username])
            audio_buffers[username] = []

            recognizer = sr.Recognizer()
            audio_data = sr.AudioData(combined, 16000, 2)

            try:
                text = recognizer.recognize_google(audio_data, language=src)
            except sr.UnknownValueError:
                text = ""
            except sr.RequestError as e:
                print(f"[Google Speech Error] {e}")
                text = ""

            if not text:
                return

            print(f"[{username} Recognized] {text}")

            translated = translate(text, source_lang=src, target_lang=tgt)
            print(f"[{username} Translated] {translated}")

            mp3_bytes = tts_mp3_bytes(translated, lang=tgt)
            if PLAY_LOCALLY and mp3_bytes:
                speak_local(mp3_bytes)

            payload = {
                "type": "translation",
                "text": translated,
                "audio_b64": base64.b64encode(mp3_bytes).decode("utf-8") if mp3_bytes else "",
                "src": src,
                "tgt": tgt,
                "username": username,
                "roomId": roomId,
                "timestamp": int(time.time() * 1000)
            }
            send_ws_message(payload)


# ---------------- Main loop: process incoming audio from Node ----------------
async def ws_listener():
    global user_langs, ws_conn
    backoff = 1
    while True:
        try:
            ws_conn = await websockets.connect(WS_URL, max_size=None, ping_interval=30,ping_timeout=30)
            print("✅ Connected to Node WebSocket (listening for messages)")
            backoff = 1

            last_heartbeat = time.time()

            async for msg in ws_conn:  # keep the connection open
                data = json.loads(msg)

                if data.get("type") == "setLangs":
                    username = data.get("username", "unknown")
                    user_langs[username] = {
                        "src": normalize_lang(data["src"]),
                        "tgt": normalize_lang(data["tgt"])
                    }
                    print(f"✅ {username} langs set: {user_langs[username]}")

                elif data.get("type") == "audio":
                    username = data.get("username", "unknown")
                    roomId = data.get("roomId", None)
                    langs = user_langs.get(username, {"src": SOURCE_LANG, "tgt": TARGET_LANG})
                    src = langs["src"]
                    tgt = langs["tgt"]

                    try:
                        audio_bytes = base64.b64decode(data["audio_b64"])
                    except Exception:
                        continue

                    
                    await handle_audio(username, src, tgt, audio_bytes , roomId=roomId)


                if time.time() - last_heartbeat > 60:
                    print("still connected to node...")
                    last_heartbeat = time.time()
                    


        except Exception as e:
            ws_conn = None
            print(f"[WS listener error], {e}).Reconnecting in {backoff}s,")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)  # exponential backoff up to 1 minute

# ---------------- Entry ----------------
if __name__ == "__main__":
    # just start the listener (no mic loop, since audio comes from Node now)
    asyncio.run(ws_listener())
