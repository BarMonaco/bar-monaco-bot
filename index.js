const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ── CONFIGURACIÓN ──────────────────────────────────────────
const CONFIG = {
  WA_TOKEN:         process.env.WA_TOKEN,
  WA_PHONE_ID:      process.env.WA_PHONE_ID,
  VERIFY_TOKEN:     process.env.VERIFY_TOKEN,
  SP_CLIENT_ID:     process.env.SP_CLIENT_ID,
  SP_CLIENT_SECRET: process.env.SP_CLIENT_SECRET,
  SP_REFRESH_TOKEN: process.env.SP_REFRESH_TOKEN,
};

// ── RATE LIMITING ──────────────────────────────────────────
// Máximo 3 canciones cada 15 minutos por número
const LIMITE_CANCIONES = 3;
const VENTANA_MINUTOS  = 15;
const VENTANA_MS       = VENTANA_MINUTOS * 60 * 1000;

// Mapa: número -> [ timestamp1, timestamp2, ... ]
const solicitudes = new Map();

function puedesPedir(numero) {
  const ahora = Date.now();
  const tiempos = solicitudes.get(numero) || [];

  // Filtra solo los que están dentro de la ventana de 15 min
  const recientes = tiempos.filter(t => ahora - t < VENTANA_MS);
  solicitudes.set(numero, recientes);

  if (recientes.length >= LIMITE_CANCIONES) {
    // Calcula cuánto tiempo falta para poder pedir de nuevo
    const masAntiguo = recientes[0];
    const faltaMs    = VENTANA_MS - (ahora - masAntiguo);
    const faltaMin   = Math.ceil(faltaMs / 60000);
    return { permitido: false, faltaMin };
  }

  return { permitido: true };
}

function registrarSolicitud(numero) {
  const tiempos = solicitudes.get(numero) || [];
  tiempos.push(Date.now());
  solicitudes.set(numero, tiempos);
}

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
  res.sendStatus(200);

  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== "text") return;

    const from = message.from;
    const text = message.text.body.trim();

    console.log(`📩 Mensaje de ${from}: "${text}"`);

    // ── Verificar que no pida más de una canción por mensaje ──
    // Si el mensaje tiene más de 60 caracteres o contiene saltos de línea/comas/&/y
    const tieneSalto    = /[\n\r]/.test(text);
    const tieneConector = /\b(y|and|&|\+)\b/i.test(text);
    const muyLargo      = text.length > 60;

    if (tieneSalto || (tieneConector && muyLargo)) {
      await sendMessage(
        from,
        `Por favor pide una sola canción por mensaje 🎵\n\n🏁🏁 Bar Mónaco 🏁🏁`
      );
      return;
    }

    // ── Verificar límite de canciones ──
    const { permitido, faltaMin } = puedesPedir(from);

    if (!permitido) {
      await sendMessage(
        from,
        `⛔ Ya pediste ${LIMITE_CANCIONES} canciones en los últimos ${VENTANA_MINUTOS} minutos.\n\n⏱️ Puedes pedir de nuevo en ${faltaMin} minuto${faltaMin > 1 ? "s" : ""}.\n\n🏁🏁 Bar Mónaco 🏁🏁`
      );
      return;
    }

    // ── Buscar en Spotify ──
    const spToken = await getSpotifyToken();
    const song    = await searchSong(text, spToken);

    if (!song) {
      await sendMessage(
        from,
        `❌ No encontré "${text}" en Spotify. Intenta con el nombre exacto de la canción o el artista. 🎵\n\n🏁🏁 Bar Mónaco 🏁🏁`
      );
      return;
    }

    // ── Agregar a la cola y registrar solicitud ──
    await addToQueue(song.uri, spToken);
    registrarSolicitud(from);

    // ── Responder al cliente ──
    const recientes = (solicitudes.get(from) || []).length;
    const restantes = LIMITE_CANCIONES - recientes;

    await sendMessage(
      from,
      `✅ ¡Listo! *${song.name}* de *${song.artist}* ya está en la cola, pronto la escucharás 🎶\n\nPuedes pedir ${restantes} canción${restantes !== 1 ? "es" : ""} más en los próximos ${VENTANA_MINUTOS} minutos.\n\n🏁🏁 Bar Mónaco 🏁🏁`
    );

    console.log(`🎵 Agregada: ${song.name} - ${song.artist} | Restantes para ${from}: ${restantes}`);

  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);

    if (err.response?.status === 404 || err.response?.status === 403) {
      const from = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) {
        await sendMessage(
          from,
          `⚠️ En este momento Spotify no está activo en el bar. Intenta en unos minutos. 🎵\n\n🏁🏁 Bar Mónaco 🏁🏁`
        );
      }
    }
  }
});

// ── INICIAR SERVIDOR ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bar Mónaco Bot v2 corriendo en puerto ${PORT}`);
});
