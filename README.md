# TranslateMeet 🌍📹

TranslateMeet is a modern, real-time video conferencing application equipped with **AI-powered live audio translation**. It enables seamless communication across language barriers by instantly translating spoken words during video calls and overlaying subtitles and translated audio for the recipient.

## ✨ Features

- **P2P Video Calling:** High-quality, low-latency video and audio streaming using WebRTC.
- **Real-Time AI Translation:** Automatically detects when you speak, translates your voice into the recipient's chosen language, and plays the translated audio (along with subtitles) on their end.
- **Smart Mute & Privacy:** The backend completely stops processing audio the moment you mute your microphone. The AI only activates when there is an active peer in the room.
- **Group Chat:** Built-in real-time text chat with an intuitive sidebar.
- **Premium Responsive UI:** A sleek, glassmorphic design that adapts perfectly to desktop and mobile devices.
- **Docker-Ready:** Completely containerized for simple one-click deployment on platforms like Render.

## 🛠️ Tech Stack

**Frontend:**
- HTML5, Vanilla CSS, Vanilla JavaScript
- WebRTC (Peer-to-Peer Media Streaming)
- Socket.IO-client

**Backend (Signaling & Chat):**
- Node.js & Express
- Socket.IO

**AI Translation Service:**
- Python 3 & FastAPI
- `webrtcvad` (Voice Activity Detection)
- `SpeechRecognition` (Google STT)
- `deep-translator` (Google Translate)
- `gTTS` (Google Text-to-Speech)

## 🚀 Getting Started

You can run this project locally using either Docker (recommended for production) or by manually spinning up the Node and Python servers.

### Prerequisites
- Node.js (v18+)
- Python (3.10+)
- Docker (optional)

### 🐳 Option 1: Run with Docker (Easiest)
1. Build the Docker image:
   ```bash
   docker build -t translatemeet .
   ```
2. Run the container:
   ```bash
   docker run -p 8000:8000 translatemeet
   ```
3. Open your browser and navigate to `http://localhost:8000` (or the port Docker exposed based on your environment).

### 💻 Option 2: Local Development Setup
1. **Install Node Dependencies:**
   ```bash
   npm install
   ```
2. **Install Python Dependencies:**
   ```bash
   # It is highly recommended to use a virtual environment
   pip install -r requirements.txt
   ```
3. **Start the Application:**
   The Python backend is designed to act as the master process and will automatically spin up the Node.js server for you.
   ```bash
   uvicorn translator_fastapi:app --host 0.0.0.0 --port 8000
   ```
4. **Access the App:**
   Navigate to `http://localhost:9000` (Node server default) in your browser.

## ⚙️ How it Works
1. **Audio Capture:** The browser captures 16kHz audio from your microphone and streams it over WebSockets to the Node.js server.
2. **Relay:** Node.js relays the audio chunks to the Python FastAPI backend.
3. **VAD & Recognition:** Python uses Voice Activity Detection to wait for silence, stitches the audio frames together, and sends them to Google's Speech-to-Text API.
4. **Translation & TTS:** The text is translated and converted back into speech.
5. **Playback:** The translated audio bytes are sent back to the frontend where they are played out loud for the remote peer, alongside translated subtitles.

## 📄 License
This project is open-source and available under the MIT License.
