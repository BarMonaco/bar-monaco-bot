const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ── CONFIGURACIÓN ──────────────────────────────────────────
const CONFIG = {
  // WhatsApp
  WA_TOKEN:       process.env.WA_TOKEN,
  WA_PHONE_ID:    process.env.WA_PHONE_ID,
  VERIFY_TOKEN:   process.env.VERIFY_TOKEN,

  // Spotify
  SP_CLIENT_ID:     process.env.SP_CLIENT_ID,
  SP_CLIENT_SECRET: process.env.SP_CLIENT_SECRET,
  SP_REFRESH_TOKEN: process.env.SP_REFRESH_TOKEN,
};

// ── SPOTIFY: obtener access token ──────────────────────────
async function getSpotifyToken() {
  const creds = Buffer.from(
    `${CONFIG.SP_CLIENT_ID}:${CONFIG.SP_CLIENT_SECRET}`
  ).toString("base64");

  const res = await axios.post(
    "https://accounts.spotify.com/api/token",
    "grant_type=refresh_token&refresh_token=" + CONFIG.SP_REFRESH_TOKEN,
    {
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return res.data.access_token;
}

// ── SPOTIFY: buscar canción ────────────────────────────────
async function searchSong(query, token) {
  const res = await axios.get("https://api.spotify.com/v1/search", {
    headers: { Authorization: `Bearer ${token}` },
    params: { q: query, type: "track", limit: 1 },
  });

  const tracks = res.data.tracks.items;
  if (!tracks || tracks.length === 0) return null;

  const track = tracks[0];
  return {
    uri:    track.uri,
    name:   track.name,
    artist: track.artists[0].name,
  };
}

// ── SPOTIFY: agregar a la cola ─────────────────────────────
async function addToQueue(uri, token) {
  await axios.post(
    `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

// ── WHATSAPP: enviar mensaje ───────────────────────────────
async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${CONFIG.WA_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ── WEBHOOK: verificación de Meta ─────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── WEBHOOK: recibir mensajes ──────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const from = message.from;
    const text = message.text.body.trim();

    console.log(`📩 Mensaje de ${from}: "${text}"`);

    // Buscar en Spotify
    const spToken = await getSpotifyToken();
    const song    = await searchSong(text, spToken);

    if (!song) {
      await sendMessage(
        from,
        `❌ No encontré "${text}" en Spotify. Intenta con el nombre exacto de la canción o el artista. 🎵`
      );
      return;
    }

    // Agregar a la cola
    await addToQueue(song.uri, spToken);

    // Confirmar al cliente
    await sendMessage(
      from,
      `✅ ¡Listo! *${song.name}* de *${song.artist}* ya está en la cola, pronto la escucharás 🎶\n🏁🏁 Bar Mónaco 🏁🏁`
    );

    console.log(`🎵 Agregada: ${song.name} - ${song.artist}`);

  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);

    // Si Spotify no está reproduciendo nada
    if (err.response?.status === 404 || err.response?.status === 403) {
      const from = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) {
        await sendMessage(
          from,
          `⚠️ En este momento Spotify no está activo en el bar. Intenta en unos minutos. 🎵\n🏁🏁 Bar Mónaco 🏁🏁`
        );
      }
    }
  }
});

// ── INICIAR SERVIDOR ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bar Mónaco Bot corriendo en puerto ${PORT}`);
});
