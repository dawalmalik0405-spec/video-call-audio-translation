const createUserBtn = document.getElementById("create-user");
const usernameInput = document.getElementById("username");
const username = usernameInput || { value: "User_" + Math.floor(Math.random()*1000) };
const allusersHtml = document.getElementById("allusers");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const endCallBtn = document.getElementById("end-call-btn");

const muteAudioBtn = document.getElementById("mute-audio-btn");
const muteVideoBtn = document.getElementById("mute-video-btn");
const transcriptLog = document.getElementById("transcript-log");

const socket = io();

// ---- Subtitle inside remoteVideo container ----
let subtitleEl = document.getElementById("subtitle");
if (!subtitleEl) {
  // make sure parent can hold absolute positioned children
  const remoteContainer = remoteVideo.parentElement;
  if (getComputedStyle(remoteContainer).position === "static") {
    remoteContainer.style.position = "relative";
  }

  subtitleEl = document.createElement("div");
  subtitleEl.id = "subtitle";
  subtitleEl.style.position = "absolute";
  subtitleEl.style.left = "50%";
  subtitleEl.style.transform = "translateX(-50%)";
  subtitleEl.style.bottom = "10px";
  subtitleEl.style.background = "rgba(0,0,0,0.6)";
  subtitleEl.style.color = "white";
  subtitleEl.style.padding = "6px 12px";
  subtitleEl.style.borderRadius = "6px";
  subtitleEl.style.fontSize = "18px";
  subtitleEl.style.maxWidth = "90%";
  subtitleEl.style.textAlign = "center";

  remoteContainer.appendChild(subtitleEl);
}
// ---------------------------------------------

socket.on("translation", (payload) => {
  try {
    // ✅ Show only if translation belongs to someone else
    if (payload.username && payload.username !== username.value) {
      if (payload.text) {
        subtitleEl.innerText = payload.text;
        clearTimeout(subtitleEl._clearT);
        subtitleEl._clearT = setTimeout(() => {
          subtitleEl.innerText = "";
        }, 4000);

        // Add to transcript log
        if (transcriptLog) {
          const logEntry = document.createElement("div");
          logEntry.className = "chat-msg";
          logEntry.innerHTML = `
            <div class="msg-header"><span class="sender">${payload.username || "Remote"}</span></div>
            <div class="msg-bubble is-translated">
              ${payload.original_text ? `<div class="msg-original">"${payload.original_text}"</div>` : ''}
              <div>${payload.text}</div>
            </div>
          `;
          transcriptLog.appendChild(logEntry);
          transcriptLog.scrollTop = transcriptLog.scrollHeight;
        }
      }

      if (payload.audio_b64) {
        const binary = atob(payload.audio_b64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes.buffer], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const a = new Audio(url);
        a.play().catch((e) => {
          console.warn(
            "Auto-play blocked, user gesture required to play audio",
            e
          );
        });
        a.onended = () => URL.revokeObjectURL(url);
      }
    }
  } catch (e) {
    console.error("Error handling translation payload", e);
  }
});

let localStream;
let caller = [];

// Single Method for peer connection
const PeerConnection = (function () {
  let peerConnection;

  const createPeerConnection = () => {
    const config = {
      iceServers: [
        {
          urls: "stun:stun.l.google.com:19302",
        },
      ],
    };
    peerConnection = new RTCPeerConnection(config);

    // add local stream to peer connection
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
    // listen to remote stream and add to peer connection
    peerConnection.ontrack = function (event) {
      remoteVideo.srcObject = event.streams[0];
    };
    // listen for ice candidate
    // ICE candidates
    peerConnection.onicecandidate = function (event) {
      if (event.candidate) {
        const roomId = window.location.pathname.split("/").pop() || "default"; // ✅ add
        socket.emit("icecandidate", { roomId, candidate: event.candidate });   // ✅ include roomId
      }
    };
    return peerConnection;
  };

  return {
    getInstance: () => {
      if (!peerConnection) {
        peerConnection = createPeerConnection();
      }
      return peerConnection;
    },
    resetInstance: () => {
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
    }
  };
})();

// handle browser events
if (createUserBtn && usernameInput) {
  createUserBtn.addEventListener("click", (e) => {
    if (username.value !== "") {
      const usernameContainer = document.querySelector(".username-input");
      const roomId = window.location.pathname.split("/").pop() || "default";
      socket.emit("join-room", { roomId, username: username.value });
      if (usernameContainer) usernameContainer.style.display = "none";
      startMicStreaming(roomId);
    }
  });
} else {
  // Auto-join if no username input exists in the new UI
  setTimeout(() => {
    const roomId = window.location.pathname.split("/").pop() || "default";
    socket.emit("join-room", { roomId, username: username.value });
    startMicStreaming(roomId);
  }, 1000);
}
if (endCallBtn) {
  endCallBtn.addEventListener("click", (e) => {
  const roomId = window.location.pathname.split("/").pop() || "default";
  socket.emit("call-ended", { roomId, caller });
});
}

if (muteAudioBtn) {
  muteAudioBtn.addEventListener("click", () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        muteAudioBtn.innerText = audioTrack.enabled ? "🎙️" : "🔇";
        muteAudioBtn.style.opacity = audioTrack.enabled ? "1" : "0.5";
      }
    }
  });
}

if (muteVideoBtn) {
  muteVideoBtn.addEventListener("click", () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        muteVideoBtn.innerText = videoTrack.enabled ? "📷" : "🚫";
        muteVideoBtn.style.opacity = videoTrack.enabled ? "1" : "0.5";
      }
    }
  });
}

// handle socket events
socket.on("joined", (allusers) => {
  console.log({ allusers });
  const createUsersHtml = () => {
    allusersHtml.innerHTML = "";

    for (const user in allusers) {
      const li = document.createElement("li");
      li.textContent = `${user} ${user === username.value ? "(You)" : ""}`;

      if (user !== username.value) {
        const button = document.createElement("button");
        button.classList.add("call-btn");
        button.addEventListener("click", (e) => {
          startCall(user);
        });
        const img = document.createElement("img");
        img.setAttribute("src", "/images/phone.jpeg");
        img.setAttribute("width", 20);

        button.appendChild(img);

        li.appendChild(button);
      }

      allusersHtml.appendChild(li);
    }
  };

  createUsersHtml();
});
socket.on("offer", async ({ from, to, offer,roomId }) => {
  const pc = PeerConnection.getInstance();
  // set remote description
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("answer", { roomId, from, to, answer: pc.localDescription });
  caller = [from, to];
});
socket.on("answer", async ({ from, to, answer }) => {
  const pc = PeerConnection.getInstance();
  await pc.setRemoteDescription(answer);
  // show end call button
  endCallBtn.style.display = "block";
  // socket.emit("end-call", { from, to });
  caller = [from, to];
});
socket.on("icecandidate", async (candidate) => {
  console.log({ candidate });
  const pc = PeerConnection.getInstance();
  await pc.addIceCandidate(new RTCIceCandidate(candidate));
});
socket.on("end-call", ({ from, to }) => {
  endCallBtn.style.display = "block";
});
socket.on("call-ended", (caller) => {
  endCall();
});

// start call method
const startCall = async (user) => {
  console.log({ user });
  const pc = PeerConnection.getInstance();
  const offer = await pc.createOffer();
  console.log({ offer });
  await pc.setLocalDescription(offer);

  const roomId = window.location.pathname.split("/").pop() || "default";
  socket.emit("offer", {
    roomId,
    from: username.value,
    to: user,
    offer: pc.localDescription,
  });
};

const endCall = () => {
  PeerConnection.resetInstance();
  if (remoteVideo) remoteVideo.srcObject = null;
  if (endCallBtn) endCallBtn.style.display = "none";
};

const setLangBtn = document.getElementById("setLangBtn");
if (setLangBtn) {
  setLangBtn.addEventListener("click", () => {
    const src = document.getElementById("srcLang").value;
    const tgt = document.getElementById("tgtLang").value;
    const roomId = window.location.pathname.split("/").pop() || "default";
    socket.emit("set-langs", { roomId, username: username.value, src, tgt });
  });
}

// ---- handle create-room (only exists on home.html) ----
const createRoomBtn = document.getElementById("create-room");
if (createRoomBtn) {
  createRoomBtn.addEventListener("click", () => {
    const roomId = crypto.randomUUID();
    window.location.href = `/room/${roomId}`;
  });
}

// ---- Meeting Badge Logic ----
const meetingIdDisplay = document.getElementById("meeting-id-display");
const meetingBadge = document.getElementById("meeting-badge");
const currentRoomId = window.location.pathname.split("/").pop();

if (meetingIdDisplay && currentRoomId && currentRoomId !== "room") {
  meetingIdDisplay.innerText = currentRoomId;
}

if (meetingBadge) {
  meetingBadge.addEventListener("click", () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      const originalText = meetingIdDisplay.innerText;
      meetingIdDisplay.innerText = "Copied!";
      setTimeout(() => {
        meetingIdDisplay.innerText = originalText;
      }, 2000);
    });
  });
}



// initialize app
const startMyVideo = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    console.log({ stream });
    localStream = stream;
    localVideo.srcObject = stream;

    // --- Audio Analyzer for Mic Glow ---
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      const microphone = audioCtx.createMediaStreamSource(stream);
      microphone.connect(analyser);
      analyser.fftSize = 256;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      const localVideoContainer = localVideo.parentElement;

      setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const avg = sum / bufferLength;
        // If average volume is above threshold and audio track is enabled
        const audioTrack = localStream.getAudioTracks()[0];
        if (avg > 10 && audioTrack && audioTrack.enabled) {
          localVideoContainer.classList.add("is-speaking");
        } else {
          localVideoContainer.classList.remove("is-speaking");
        }
      }, 100);
    }
    // -----------------------------------
  } catch (error) {
    console.error("Camera access failed:", error);
    alert("Could not access camera/microphone. Please check permissions.");
  }
};




startMyVideo();




async function startMicStreaming(roomId) {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // ✅ Force 16kHz to match Python
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(micStream);

    // ✅ Larger buffer (~1 sec chunks)
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);

      // Float32 → Int16
      const buffer = new ArrayBuffer(inputData.length * 2);
      const view = new DataView(buffer);
      for (let i = 0; i < inputData.length; i++) {
        let s = Math.max(-1, Math.min(1, inputData[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }

      const int16Array = new Int16Array(buffer);
      const binary = String.fromCharCode(...new Uint8Array(int16Array.buffer));
      const audio_b64 = btoa(binary);

      const src = document.getElementById("srcLang").value;
      const tgt = document.getElementById("tgtLang").value;

      // ✅ Send to backend
      socket.emit("audio-chunk", { roomId, audio_b64, src, tgt, username: username.value });

      console.log("🎙️ Sent chunk", {
        src,
        tgt,
        samples: inputData.length,
        bytes: audio_b64.length,
      });
    };

    console.log("🎙️ Microphone streaming started (16kHz, buffer=16384)");
  } catch (err) {
    console.error("❌ Failed to start mic streaming:", err);
  }
}
