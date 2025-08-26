require('dotenv').config(); // Carrega o .env
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const WebSocket = require("ws");

// ⚙️ Configurações
const PORT = process.env.PORT || 5000;
const EXPIRY_SECONDS = parseInt(process.env.EXPIRY_SECONDS) || 600;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// 🗃️ Armazenamento em memória
const store = new Map();

// 🔑 Gera chave
function makeKey(item) {
  if (item.jobId) return "job:" + item.jobId;
  return "msg:" + (item.id || Date.now().toString());
}

// 🧹 Limpeza periódica
setInterval(() => {
  const now = Date.now() / 1000;
  for (let [k, v] of store.entries()) {
    if (now - (v.lastSeen || 0) > EXPIRY_SECONDS) {
      store.delete(k);
    }
  }
}, 30 * 1000);

// 🚀 Servidor Express
const app = express();
app.use(bodyParser.json());

app.post("/receive", (req, res) => {
  let items = Array.isArray(req.body) ? req.body : [req.body];
  const now = Date.now() / 1000;

  items.forEach((it) => {
    const key = makeKey(it);
    if (store.has(key)) {
      const old = store.get(key);
      store.set(key, { ...old, ...it, lastSeen: now });
    } else {
      store.set(key, {
        serverName: it.serverName || "",
        moneyPerSec: it.moneyPerSec || 0,
        players: it.players || "",
        author: it.author || "",
        jobId: it.jobId || "",
        firstSeen: now,
        lastSeen: now,
        id: it.id || "",
      });
    }
  });

  res.json({ status: "ok", count: store.size });
});

app.get("/messages", (req, res) => {
  const now = Date.now() / 1000;
  let arr = [...store.values()].filter(
    (v) => now - (v.lastSeen || 0) <= EXPIRY_SECONDS
  );
  arr.sort((a, b) => b.lastSeen - a.lastSeen);
  res.json(arr);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://127.0.0.1:${PORT}`);
  startCollector(); // inicia o gateway
});

// ================== Parser ==================
function parseMoneyPerSec(raw) {
  if (!raw) return 0;
  let s = raw.replace(/\*/g, "").replace(/\s+/g, "");
  s = s.replace("/s", "").replace("persec", "");
  let m = s.match(/\$?([0-9]+(?:\.[0-9]+)?)([KkMmBbTtQq]?)/);
  if (!m) {
    let m2 = s.match(/([0-9]+(?:\.[0-9]+)?)/);
    return m2 ? parseInt(parseFloat(m2[1])) : 0;
  }
  let num = parseFloat(m[1]);
  let mult = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12, Q: 1e15 }[m[2].toUpperCase()] || 1;
  return Math.floor(num * mult);
}

function parseEmbedFields(msg) {
  let result = { serverName: null, moneyPerSec: 0, players: null, jobId: null };
  let content = msg.content || "";
  if (content.trim()) {
    let candidate = content.replace(/`/g, "").trim();
    if (candidate.length >= 10 && (candidate.includes("-") || candidate.includes("/"))) {
      result.jobId = candidate;
    }
  }

  (msg.embeds || []).forEach((embed) => {
    (embed.fields || []).forEach((field) => {
      let name = (field.name || "").trim();
      let value = (field.value || "").trim();

      if (/name/i.test(name)) result.serverName = value;
      else if (/money|per sec|💰|generation|📈/i.test(name)) result.moneyPerSec = parseMoneyPerSec(value);
      else if (/players|👥/i.test(name)) result.players = value.replace(/\*/g, "");
      else if (/job/i.test(name)) {
        let clean = value.replace(/`/g, "").trim();
        if (clean) {
          let parts = clean.split(/\s+/);
          result.jobId = parts.find((p) => p.length > 8) || clean;
        }
      }
    });

    if (!result.serverName && embed.title) result.serverName = embed.title;
    if (!result.jobId && embed.description) {
      let m = embed.description.match(/TeleportToPlaceInstance\([^)]+,\s*["'`]?(?<id>[^"'`,)\s]+)/);
      if (m) result.jobId = m.groups.id;
      let m2 = embed.description.match(/[0-9a-fA-F]{8}-[0-9a-fA-F-]{4,}-[0-9a-fA-F]{8,}/);
      if (m2) result.jobId = m2[0];
    }
  });

  return result;
}

// ================== Collector via Gateway ==================
function startCollector() {
  console.log("Collector rodando (Gateway WebSocket, instantâneo). Ctrl+C para sair.");

  const ws = new WebSocket("wss://gateway.discord.gg/?v=9&encoding=json");
  let heartbeat;

  ws.on("open", () => console.log("Conectado ao Gateway do Discord"));

  ws.on("message", async (raw) => {
    let payload = JSON.parse(raw);
    const { t, op, d } = payload;

    // 💓 Heartbeat
    if (op === 10) {
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        ws.send(JSON.stringify({ op: 1, d: null }));
      }, d.heartbeat_interval);

      // Identificação
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: DISCORD_TOKEN,
          intents: 513, // GUILD_MESSAGES + DIRECT_MESSAGES
          properties: { $os: "linux", $browser: "node", $device: "node" }
        }
      }));
    }

    // 📩 Nova mensagem
    if (t === "MESSAGE_CREATE" && d.channel_id === CHANNEL_ID) {
      const parsed = parseEmbedFields(d);
      if (!parsed.jobId && !parsed.serverName) return; // ignora irrelevantes

      const payloadToSend = {
        id: d.id,
        author: d.author?.username || "Unknown",
        serverName: parsed.serverName || "",
        moneyPerSec: parsed.moneyPerSec || 0,
        players: parsed.players || "",
        jobId: parsed.jobId || ""
      };

      try {
        await axios.post(`http://127.0.0.1:${PORT}/receive`, payloadToSend, { timeout: 6000 });
        console.log("Enviado instantâneo:", payloadToSend);
      } catch (err) {
        console.error("Erro ao enviar:", err.message);
      }
    }
  });

  ws.on("close", () => {
    console.log("Gateway desconectado, tentando reconectar em 5s...");
    clearInterval(heartbeat);
    setTimeout(startCollector, 5000);
  });

  ws.on("error", (err) => {
    console.error("Erro no WebSocket:", err.message);
  });
}
