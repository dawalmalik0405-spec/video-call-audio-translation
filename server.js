import http from "http";
import express from "express";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
import { WebSocketServer } from "ws"; // For Python connection

const app = express();
const userLangs = {};  // { username: { src, tgt } }
const rooms = {};   // { username: { username, id } }

// Serve static files from the public folder
app.use(express.static("public"));

// Home page (create meeting)
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "app/home.html"));
});

// Meeting page (join room)
app.get("/room/:roomId", (req, res) => {
  res.sendFile(join(__dirname, "app/index.html"));
});

// -----------------
// WebRTC signaling
// -----------------
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// ... (rest of the file unchanged)

// app.get("/", (req, res) => {
//   console.log("GET Request /");
//   res.sendFile(join(__dirname + "/app/index.html"));
// });


// Home page (create meeting)
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "app/home.html"));
});

// Meeting page (join room)
app.get("/room/:roomId", (req, res) => {
  res.sendFile(join(__dirname, "app/index.html"));
});


// -----------------
// WebRTC signaling
// -----------------
io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("join-room", ({ roomId, username }) => {
    console.log(`${username} joined room ${roomId}`);


    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][username] = { username, id: socket.id };

    socket.join(roomId);
    io.to(roomId).emit("joined", rooms[roomId]);
  });

 
  socket.on("set-langs", ({ roomId, src, tgt, username }) => {
    if (!rooms[roomId] || !rooms[roomId][username]) return;
    userLangs[username] = { src, tgt };
    console.log(`User ${username} in ${roomId} langs: ${src} -> ${tgt}`);

    // Forward to Python
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "setLangs", src, tgt, username, roomId }));
      }
    });
  });

  socket.on("audio-chunk", ({ roomId, audio_b64, src, tgt, username }) => {
    const langs = userLangs[username] || { src: "en", tgt: "hi" };
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "audio", audio_b64, src: langs.src, tgt: langs.tgt, username, roomId }));
      }
    });
  });

  socket.on("offer", ({ roomId, from, to, offer }) => {
    if (rooms[roomId] && rooms[roomId][to]) {
      io.to(rooms[roomId][to].id).emit("offer", { from, to, offer, roomId });
    }
  });

  socket.on("answer", ({ roomId, from, to, answer }) => {
    if (rooms[roomId] && rooms[roomId][from]) {
      io.to(rooms[roomId][from].id).emit("answer", { from, to, answer, roomId});
    }
  });

  socket.on("end-call-btn", ({ roomId, from, to }) => {
  if (rooms[roomId] && rooms[roomId][to]) {
    io.to(rooms[roomId][to].id).emit("end-call", { from, to });
  }
  });

  socket.on("end-call", ({ roomId, from, to }) => {
  if (rooms[roomId] && rooms[roomId][to]) {
    io.to(rooms[roomId][to].id).emit("end-call", { from, to });
  }
  });

  socket.on("call-ended", ({ roomId, caller }) => {
  const [from, to] = caller;
  if (rooms[roomId] && rooms[roomId][from]) {
    io.to(rooms[roomId][from].id).emit("call-ended", caller);
  }
  if (rooms[roomId] && rooms[roomId][to]) {
    io.to(rooms[roomId][to].id).emit("call-ended", caller);
  }
  });

  socket.on("icecandidate", ({ roomId, candidate }) => {
    socket.to(roomId).emit("icecandidate", candidate);
  });

  socket.on("chat-message", ({ roomId, username, text }) => {
    io.to(roomId).emit("chat-message", { username, text });
  });


  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      for (const uname in rooms[roomId]) {
        if (rooms[roomId][uname].id === socket.id) {
          delete rooms[roomId][uname];
          io.to(roomId).emit("joined", rooms[roomId]);
          break;
        }
      }
    }
  });
});

// -----------------
// WebSocket for Python connection
// -----------------
const wss = new WebSocketServer({ port: 8765 });

wss.on("connection", (ws) => {
  console.log("✅ Python connected to WebSocket");

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log("From Python:", data);

      if (data.roomId && rooms[data.roomId]) {
  // send to everyone in the same room except the speaker
        for (const [uname, user] of Object.entries(rooms[data.roomId])) {
          if (uname !== data.username) {
            io.to(user.id).emit("translation", data);
          }
        }

      }else {
        io.emit("translation", data); // fallback
      }
    } catch (err) {
      console.error("Invalid JSON from Python:", err);
    }
  });

  ws.on("close", () => {
    console.log("❌ Python disconnected");
  });
});

// -----------------
httpServer.listen(process.env.PORT || 9000, () => {
  console.log(`✅ HTTP server running at http://localhost:${process.env.PORT || 9000}`);
});
