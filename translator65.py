import os
import pyaudio
import json
import logging
import base64
import asyncio
import time
from deep_translator import GoogleTranslator
from vosk import Model, KaldiRecognizer
from gtts import gTTS
import pygame
from tempfile import NamedTemporaryFile
import webrtcvad
import threading
import websockets

# ===================== CONFIG =====================
WS_URL = "ws://localhost:8765"  # Node.js WebSocket server
PLAY_LOCALLY = False            # True = also play translated audio locally (pygame)
SOURCE_LANG = "en"              # default source ("en","hi","zh/cn","de")
TARGET_LANG = "hi"              # default target
# ==================================================


# ---------------- Language normalization ----------------
LANG_ALIASES = {
    "en": "en",
    "english": "en",

    "hi": "hi",
    "hindi": "hi",

    "cn": "zh-CN",
    "zh": "zh-CN",
    "zh-cn": "zh-CN",
    "zh_cn": "zh-CN",
    "chinese": "zh-CN",


    "de": "de",
    "german": "de"
}

def normalize_lang(code: str) -> str:
    """Normalize language codes to consistent lowercase form."""
    if not code:
        return ""
    return LANG_ALIASES.get(code.strip().lower(), code.strip().lower())


# Suppress Vosk internal logs
logging.getLogger("vosk").setLevel(logging.ERROR)

def load_vosk_model():
    VOSK_MODELS = {
        "en": "/code/video-call/model1",
        "hi": "/code/video-call/model2",
        "zh-CN": "/code/video-call/model3",
        "zh-cn": "/code/video-call/model3",
        "de": "/code/video-call/model4",
    }

    norm_src = normalize_lang(SOURCE_LANG)
    model_path = VOSK_MODELS.get(norm_src)
    if not model_path:
        raise ValueError(f"Unsupported source language: {SOURCE_LANG} (normalized: {norm_src})")
    model_path = os.path.abspath(model_path)
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Vosk model not found at {model_path}")
    return Model(model_path)


# load initial model
vosk_model = load_vosk_model()

# ---------------- Translation / TTS ----------------
def translate(text, source_lang=None, target_lang=None):
    src = normalize_lang(source_lang or SOURCE_LANG)   ### CHANGED
    tgt = normalize_lang(target_lang or TARGET_LANG)   ### CHANGED
    try:
        return GoogleTranslator(source=src, target=tgt).translate(text)
    except Exception as e:
        print(f"[Translation Error] {e}")
        return ""

def tts_mp3_bytes(text, lang=None):
    lng = normalize_lang(lang or TARGET_LANG)          ### CHANGED
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
async def _send_ws_message_async(payload_json_str):
    try:
        async with websockets.connect(WS_URL, max_size=None) as ws:
            await ws.send(payload_json_str)
    except Exception as e:
        print("[WS send error]", e)

def send_ws_message(payload: dict):
    try:
        payload_json = json.dumps(payload)
        asyncio.run(_send_ws_message_async(payload_json))
    except Exception as e:
        print("[WS run error]", e)

# ---------------- VAD helpers ----------------
vad = webrtcvad.Vad(3)  # 0 least aggressive, 3 most aggressive

def is_speech(frame_bytes, sample_rate=16000):
    try:
        return vad.is_speech(frame_bytes, sample_rate)
    except Exception:
        return False

# ---------------- Main RT loop ----------------
def real_time_translation(mic_index=None):
    """
    VAD-segmented recognition:
      - Buffer frames while speaking
      - On ~end_silence_ms of silence, finalize utterance, translate + TTS, send to Node
    """
    audio = pyaudio.PyAudio()

    frame_duration_ms = 20
    sample_rate = 16000
    bytes_per_sample = 2
    samples_per_frame = int(sample_rate * frame_duration_ms / 1000)
    bytes_per_frame   = samples_per_frame * bytes_per_sample

    end_silence_ms = 500
    max_utter_ms   = 30000

    stream = audio.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=sample_rate,
        input=True,
        frames_per_buffer=samples_per_frame,
        input_device_index=mic_index if mic_index is not None else None
    )
    stream.start_stream()

    print("🎤 Listening with VAD… (Ctrl+C to stop)")
    last_seen = (None, None)

    in_speech = False
    silence_acc_ms = 0
    utter_acc_ms = 0
    voiced_frames = []

    try:
        while True:
            # log when langs change
            if (SOURCE_LANG, TARGET_LANG) != last_seen:
                print(f"🔧 Translating {SOURCE_LANG} -> {TARGET_LANG}")
                last_seen = (SOURCE_LANG, TARGET_LANG)

            data = stream.read(samples_per_frame, exception_on_overflow=False)
            if not data or len(data) < bytes_per_frame:
                continue

            speech = is_speech(data)

            if speech:
                voiced_frames.append(data)
                utter_acc_ms += frame_duration_ms
                silence_acc_ms = 0
                if not in_speech:
                    in_speech = True
            else:
                if in_speech:
                    silence_acc_ms += frame_duration_ms

            # End of utterance?
            if in_speech and (silence_acc_ms >= end_silence_ms or utter_acc_ms >= max_utter_ms):
                audio_bytes = b"".join(voiced_frames)

                # recognizer uses the CURRENT vosk_model
                recognizer = KaldiRecognizer(vosk_model, sample_rate)
                recognizer.AcceptWaveform(audio_bytes)
                result = json.loads(recognizer.Result() or "{}")
                text = (result.get("text") or "").strip()

                # reset state
                in_speech = False
                silence_acc_ms = 0
                utter_acc_ms = 0
                voiced_frames.clear()

                if not text or len(text.split()) < 2:
                    continue

                print(f"[Recognized] {text}")

                translated = translate(text)
                print(f"[Translated] {translated}")

                mp3_bytes = tts_mp3_bytes(translated)
                if PLAY_LOCALLY and mp3_bytes:
                    speak_local(mp3_bytes)

                payload = {
                    "type": "translation",
                    "text": translated,
                    "audio_b64": base64.b64encode(mp3_bytes).decode("utf-8") if mp3_bytes else "",
                    "src": SOURCE_LANG,   # always current
                    "tgt": TARGET_LANG,   # always current
                    "timestamp": int(time.time() * 1000)
                }
                send_ws_message(payload)

    except KeyboardInterrupt:
        print("Stopping…")
    except Exception as e:
        print(f"[Audio Error] {e}")
        time.sleep(0.1)
    finally:
        try:
            stream.stop_stream()
            stream.close()
            audio.terminate()
        except:
            pass

# ---------------- Persistent control listener ----------------
async def ws_listener():
    global SOURCE_LANG, TARGET_LANG, vosk_model
    while True:
        try:
            async with websockets.connect(WS_URL, max_size=None) as ws:
                print("✅ Control channel connected (listening for setLangs)")
                while True:
                    msg = await ws.recv()
                    data = json.loads(msg)
                    if data.get("type") == "setLangs":
                        new_src = normalize_lang(data["src"])   ### CHANGED
                        new_tgt = normalize_lang(data["tgt"])   ### CHANGED
                        if new_src != SOURCE_LANG:
                            print(f"🔄 Reloading Vosk model {SOURCE_LANG} -> {new_src}")
                            SOURCE_LANG = new_src
                            vosk_model = load_vosk_model()  # re-create model
                        else:
                            SOURCE_LANG = new_src
                        TARGET_LANG = new_tgt
                        print(f"✅ Updated languages: {SOURCE_LANG} -> {TARGET_LANG}")

        except Exception as e:
            print("[WS listener error]", e)
            await asyncio.sleep(1)  # retry after a brief pause

def start_ws_listener():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(ws_listener())

# ---------------- Entry ----------------
if __name__ == "__main__":
    # Start background listener for control messages from Node
    threading.Thread(target=start_ws_listener, daemon=True).start()
    # Start mic -> STT -> Translate -> TTS -> send to Node
    real_time_translation()
