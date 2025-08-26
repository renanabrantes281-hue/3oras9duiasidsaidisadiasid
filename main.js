require('dotenv').config(); // Carrega o .env
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

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
  startCollector();
});

// ================== Collector ==================
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

async function pollNewMessages() {
  let lastId = null;
  while (true) {
    try {
      let url = `https://discord.com/api/v9/channels/${CHANNEL_ID}/messages?limit=50`;
      if (lastId) url += `&after=${lastId}`;

      let r = await axios.get(url, {
        headers: { Authorization: DISCORD_TOKEN, "User-Agent": "DiscordBot (example, v0.1)" },
      });

      if (r.status === 200 && r.data.length > 0) {
        let msgs = r.data.reverse();
        for (let m of msgs) {
          let parsed = parseEmbedFields(m);
          if (!parsed.jobId && !parsed.serverName) {
            lastId = m.id || lastId;
            continue;
          }
          let payload = {
            id: m.id,
            author: m.author?.username || "Unknown",
            serverName: parsed.serverName || "",
            moneyPerSec: parsed.moneyPerSec || 0,
            players: parsed.players || "",
            jobId: parsed.jobId || "",
          };
          try {
            await axios.post(`http://127.0.0.1:${PORT}/receive`, payload, { timeout: 6000 });
            console.log("Enviado ao localhost:", payload);
          } catch (err) {
            console.error("Falha ao enviar payload:", payload);
          }
          lastId = m.id || lastId;
        }
      }
    } catch (e) {
      console.error("Erro no poll:", e.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function startCollector() {
  console.log("Collector rodando (polling incremental). Ctrl+C para sair.");
  pollNewMessages();
}
