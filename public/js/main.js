// Extract name from query parameter or sessionStorage
const urlParams = new URLSearchParams(window.location.search);
let queryName = urlParams.get('name') || urlParams.get('username') || "";
if (queryName) {
  sessionStorage.setItem('username', queryName.trim());
}

const username = { value: sessionStorage.getItem('username') || "" };
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

// ---- Helper to append formatted chat and transcript messages ----
const appendChatMsg = (sender, text, isSelf = false, isTranslation = false, originalText = "") => {
  if (!transcriptLog) return;
  const logEntry = document.createElement("div");
  logEntry.className = `chat-msg ${isSelf ? 'is-self' : ''}`;
  
  if (isTranslation) {
    logEntry.innerHTML = `
      <div class="msg-header">
        <span class="sender">${sender} (AI Translated)</span>
      </div>
      <div class="msg-bubble is-translated">
        ${originalText ? `<div class="msg-original">"${originalText}"</div>` : ''}
        <div>${text}</div>
      </div>
    `;
  } else {
    logEntry.innerHTML = `
      <div class="msg-header">
        <span class="sender">${isSelf ? 'You' : sender}</span>
      </div>
      <div class="msg-bubble">
        <div>${text}</div>
      </div>
    `;
  }
  
  transcriptLog.appendChild(logEntry);
  transcriptLog.scrollTop = transcriptLog.scrollHeight;
};
// ------------------------------------------------------------------

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
        appendChatMsg(payload.username || "Remote", payload.text, false, true, payload.original_text);
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

// Join Meeting Room Function
const joinMeetingRoom = () => {
  const roomId = window.location.pathname.split("/").pop() || "default";
  
  // Set header display name
  const headerUsernameEl = document.getElementById("header-username");
  if (headerUsernameEl) {
    headerUsernameEl.textContent = username.value;
  }
  
  // Update local video thumb label
  const localLabel = document.querySelector(".thumbnail.local-thumb .thumb-label");
  if (localLabel) {
    localLabel.textContent = `${username.value} (You)`;
  }

  socket.emit("join-room", { roomId, username: username.value });
  startMicStreaming(roomId);
};

// Check username availability and trigger modal if missing
const modalEl = document.getElementById("username-modal");
const modalInput = document.getElementById("username-modal-input");
const modalSubmitBtn = document.getElementById("username-modal-submit");

if (!username.value) {
  if (modalEl) {
    modalEl.style.display = "flex";
    modalInput.focus();
    
    const handleModalSubmit = () => {
      const enteredName = modalInput.value.trim();
      if (enteredName) {
        username.value = enteredName;
        sessionStorage.setItem("username", enteredName);
        modalEl.style.display = "none";
        joinMeetingRoom();
      } else {
        modalInput.style.borderColor = "var(--danger)";
        modalInput.placeholder = "Name cannot be empty!";
      }
    };

    modalSubmitBtn.addEventListener("click", handleModalSubmit);
    modalInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") handleModalSubmit();
    });
  } else {
    // fallback if no modal in HTML
    username.value = "User_" + Math.floor(Math.random()*1000);
    joinMeetingRoom();
  }
} else {
  // auto-join
  joinMeetingRoom();
}

if (endCallBtn) {
  endCallBtn.addEventListener("click", (e) => {
    const roomId = window.location.pathname.split("/").pop() || "default";
    socket.emit("call-ended", { roomId, caller });
  });
}

const disconnectHeaderBtn = document.getElementById("disconnect-header-btn");
if (disconnectHeaderBtn) {
  disconnectHeaderBtn.addEventListener("click", () => {
    const roomId = window.location.pathname.split("/").pop() || "default";
    socket.emit("call-ended", { roomId, caller });
    window.location.href = "/";
  });
}

const copyCodeBtn = document.getElementById("copy-code-btn");
if (copyCodeBtn) {
  copyCodeBtn.addEventListener("click", async () => {
    const roomId = window.location.pathname.split("/").pop() || "default";
    try {
      await navigator.clipboard.writeText(roomId);
      const originalTitle = copyCodeBtn.title;
      copyCodeBtn.title = "Copied!";
      const icon = copyCodeBtn.innerHTML;
      copyCodeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>`;
      setTimeout(() => {
        copyCodeBtn.title = originalTitle;
        copyCodeBtn.innerHTML = icon;
      }, 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
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

    let bgIndex = 0;
    for (const user in allusers) {
      // Don't show ourselves in the remote participants list since we have the large local video thumb
      if (user === username.value) continue;

      const li = document.createElement("li");
      li.className = "user-card";

      const firstLetter = user.charAt(0).toUpperCase() || "?";
      const bgClass = `bg-${(bgIndex % 5) + 1}`;
      bgIndex++;

      // Create card structure
      li.innerHTML = `
        <div class="user-avatar ${bgClass}">${firstLetter}</div>
        <div class="user-info">
          <div class="user-name">${user}</div>
          <div class="user-status">Online</div>
        </div>
      `;

      // Premium Call button
      const button = document.createElement("button");
      button.classList.add("call-btn-premium");
      button.title = `Call ${user}`;
      button.addEventListener("click", (e) => {
        startCall(user);
      });
      
      // Inline beautiful SVG phone icon
      button.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
      `;

      li.appendChild(button);
      allusersHtml.appendChild(li);
    }
  };

  createUsersHtml();

  // Dynamic date and user count header update
  const userCount = Object.keys(allusers).length;
  const headerSubtitleEl = document.getElementById("header-subtitle-info");
  if (headerSubtitleEl) {
    const today = new Date();
    const formattedDate = today.toLocaleDateString("en-US", {
      day: "numeric",
      month: "long",
      year: "numeric"
    });
    headerSubtitleEl.textContent = `${formattedDate} | ${userCount} user${userCount !== 1 ? 's' : ''}`;
  }
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
    // We can use the already captured localStream if available, or request anew.
    // For translation, we need 16kHz. MediaDevices might provide 48kHz by default, 
    // but AudioContext with sampleRate: 16000 will automatically resample it!
    const audioContext = new AudioContext({ sampleRate: 16000 });
    
    // Wait for localStream to be available
    while (!localStream) {
      await new Promise(r => setTimeout(r, 100));
    }
    
    const source = audioContext.createMediaStreamSource(localStream);

    // ✅ Larger buffer (~1 sec chunks)
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      // 1. Check if the microphone is explicitly enabled (not muted)
      const audioTrack = localStream.getAudioTracks()[0];
      if (!audioTrack || !audioTrack.enabled) return;

      // 2. Check if another user is connected to the video call
      if (!remoteVideo.srcObject || !remoteVideo.srcObject.active) return;

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
    };

    console.log("🎙️ Microphone streaming started (16kHz, buffer=16384)");
  } catch (err) {
    console.error("❌ Failed to start mic streaming:", err);
  }
}

// ==================================================================
// DYNAMIC MEET INTERACTIONS (Chat sidebar, tabs, timer, stats)
// ==================================================================

// 1. Dynamic Meeting Timer (00:00:00 -> Upwards count)
const callTimerEl = document.getElementById("call-timer");
if (callTimerEl) {
  callTimerEl.textContent = "00:00:00";
  let seconds = 0;
  setInterval(() => {
    seconds++;
    const hrs = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    callTimerEl.textContent = `${hrs}:${mins}:${secs}`;
  }, 1000);
}

// 2. Chat Sidebar toggle (using cross and left navigation links)
const rightSidebar = document.querySelector(".right-sidebar");
const closeChatBtn = document.getElementById("close-chat-btn");

if (closeChatBtn && rightSidebar) {
  closeChatBtn.addEventListener("click", () => {
    rightSidebar.classList.remove("active");
  });
}

// Toggle Chat Sidebar when clicking Chat button in bottom controls
const toggleChatBtn = document.getElementById("toggle-chat-btn");
if (toggleChatBtn && rightSidebar) {
  toggleChatBtn.addEventListener("click", () => {
    rightSidebar.classList.toggle("active");
  });
}

// 3. Dynamic chat message sending
const chatInput = document.getElementById("chat-input");
const sendChatBtn = document.getElementById("send-chat-btn");

const sendTextMessage = () => {
  if (!chatInput) return;
  const text = chatInput.value.trim();
  if (text) {
    const roomId = window.location.pathname.split("/").pop() || "default";
    socket.emit("chat-message", { roomId, username: username.value, text });
    chatInput.value = "";
  }
};

if (sendChatBtn && chatInput) {
  sendChatBtn.addEventListener("click", sendTextMessage);
  chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendTextMessage();
  });
}

// Listen for broadcasted chat messages
socket.on("chat-message", ({ username: msgUser, text }) => {
  appendChatMsg(msgUser, text, msgUser === username.value, false);
});

// 4. Tab switching inside chat sidebar
const tabAll = document.getElementById("tab-all");
const tabPrivate = document.getElementById("tab-private");

if (tabAll && tabPrivate) {
  tabAll.addEventListener("click", () => {
    tabPrivate.classList.remove("active");
    tabAll.classList.add("active");
  });
  tabPrivate.addEventListener("click", () => {
    tabAll.classList.remove("active");
    tabPrivate.classList.add("active");
  });
}
