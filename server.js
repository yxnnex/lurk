const express = require('express');
const tmi = require('tmi.js');
const WebSocket = require('ws');

// ==========================================
// CONFIGURACIÓN (todo lo sensible va por variables de entorno)
// ==========================================
const USERNAME = (process.env.TWITCH_USERNAME || '').trim().toLowerCase(); // usuario del bot (la cuenta nueva)
const OAUTH_TOKEN = (process.env.TWITCH_OAUTH || '').trim();                // ej: oauth:xxxxxxxx
const CLIENT_ID = (process.env.TWITCH_CLIENT_ID || '').trim();
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;     // opcional: recuerda a quién ya saludó por follow
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PORT = process.env.PORT || 10000;

// Canal donde se agradecen los follows
const CANAL_FOLLOWS = 's2yone';
// Canales que el bot lurkea y saluda cuando se ponen online
const CANALES_ONLINE = ['m0t0maia', 'vladsuo', 'hella_tv', 'candeli_nn', 'bizarr0n', 'hunniuwu'];
// El bot entra a todos (sin repetir)
const CANALES = [...new Set([CANAL_FOLLOWS, ...CANALES_ONLINE])];

if (!USERNAME || !OAUTH_TOKEN || !CLIENT_ID) {
  console.error('❌ Faltan variables de entorno: TWITCH_USERNAME, TWITCH_OAUTH y TWITCH_CLIENT_ID son obligatorias');
  process.exit(1);
}
if (!REDIS_URL || !REDIS_TOKEN) {
  console.warn('⚠️ Sin Upstash: el bot recuerda a quién saludó por follow solo hasta el próximo reinicio.');
}

const client = new tmi.Client({
  options: { debug: false },
  connection: { reconnect: true, secure: true },
  identity: {
    username: USERNAME,
    password: OAUTH_TOKEN.startsWith('oauth:') ? OAUTH_TOKEN : `oauth:${OAUTH_TOKEN}`
  },
  channels: CANALES
});

client.on('connected', () => console.log('[BOT] Conectado y lurkeando en:', CANALES.join(', ')));
client.on('notice', (canal, id, msg) => console.warn(`[NOTICE] ${canal} (${id}): ${msg}`));

client.connect().catch(console.error);

// ==========================================
// UTILIDADES
// ==========================================
// Enviar mensaje sin que un error tire abajo el bot
async function decir(canal, mensaje) {
  try {
    await client.say(canal, mensaje);
  } catch (e) {
    console.error(`Error enviando mensaje a ${canal}:`, e.message || e);
  }
}

const TOKEN_API = OAUTH_TOKEN.replace(/^oauth:/, '');
const idsCache = new Map();

async function helix(ruta, metodo = 'GET', cuerpo = null) {
  const headers = { 'Client-Id': CLIENT_ID, Authorization: `Bearer ${TOKEN_API}` };
  if (cuerpo) headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://api.twitch.tv/helix${ruta}`, {
    method: metodo,
    headers,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    throw new Error(`Twitch API ${res.status}: ${detalle}`);
  }
  return res.status === 204 ? null : res.json();
}

async function idDeUsuario(login) {
  login = login.toLowerCase();
  if (idsCache.has(login)) return idsCache.get(login);

  const data = await helix(`/users?login=${encodeURIComponent(login)}`);
  const id = data && data.data && data.data[0] && data.data[0].id;
  if (!id) throw new Error(`No encontré al usuario ${login}`);

  idsCache.set(login, id);
  return id;
}

const usaRedis = Boolean(REDIS_URL && REDIS_TOKEN);

async function redisCmd(...args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ==========================================
// SALUDO CUANDO UN CANAL SE PONE ONLINE
// Revisa cada minuto con la API de Twitch. Saluda solo cuando pasa de offline a online.
// ==========================================
const INTERVALO_ONLINE = 60 * 1000;
const COOLDOWN_BIENVENIDA = 3 * 60 * 60 * 1000; // evita saludar de nuevo si el stream se cae y vuelve

const enVivoAntes = new Map();
const ultimaBienvenida = new Map();

const SALUDOS_ONLINE = (n) => [
  `¡Holaaa ${n}! ¡Que tengas un buen stream! dancer`,
  `¡Holi ${n}! ¡Buen stream! :3`,
  `¡Hola ${n}! Vine a lurkearte unu`
];

async function revisarOnline() {
  try {
    const params = CANALES_ONLINE.map((c) => `user_login=${encodeURIComponent(c)}`).join('&');
    const data = await helix(`/streams?${params}&first=100`);
    const vivos = new Map(
      (data.data || []).filter((s) => s.type === 'live').map((s) => [s.user_login.toLowerCase(), s])
    );

    for (const canal of CANALES_ONLINE) {
      const ahora = vivos.has(canal);
      const antes = enVivoAntes.get(canal);
      enVivoAntes.set(canal, ahora);

      // antes === undefined: primera revisión (o reinicio), no saluda a los que ya estaban online
      if (antes === undefined || antes || !ahora) continue;

      if (Date.now() - (ultimaBienvenida.get(canal) || 0) < COOLDOWN_BIENVENIDA) continue;
      ultimaBienvenida.set(canal, Date.now());

      const nombre = vivos.get(canal).user_name;
      const opciones = SALUDOS_ONLINE(nombre);
      await decir(`#${canal}`, opciones[Math.floor(Math.random() * opciones.length)]);
      console.log(`[ONLINE] ${canal} se puso en vivo, saludé`);
    }
  } catch (e) {
    console.error('[ONLINE] Error revisando canales:', e.message);
  }
}

revisarOnline();
setInterval(revisarOnline, INTERVALO_ONLINE);

// ==========================================
// GRACIAS POR EL FOLLOW EN #s2yone (EventSub por WebSocket)
// Necesita que el token tenga el scope moderator:read:followers
// y que la cuenta del bot sea moderadora (o dueña) del canal.
// ==========================================
const memoriaFollows = new Set();
const pendientesFollow = new Map();
let timerFollow = null;
let wsFollow = null;
let reintentosFollow = 0;

// Solo saluda la primera vez que alguien te sigue (evita spam de follow/unfollow)
async function esFollowNuevo(id) {
  try {
    if (usaRedis) return (await redisCmd('SADD', `follows:${CANAL_FOLLOWS}`, id)) === 1;
  } catch (e) {
    console.error('[FOLLOW] Error con Redis:', e.message);
  }
  if (memoriaFollows.has(id)) return false;
  memoriaFollows.add(id);
  return true;
}

// Junta los follows de 4 segundos en un solo mensaje (por si llegan varios juntos)
async function recibirFollow(id, nombre) {
  if (!(await esFollowNuevo(id))) return;
  pendientesFollow.set(id, nombre);
  if (!timerFollow) timerFollow = setTimeout(vaciarFollows, 4000);
}

function vaciarFollows() {
  timerFollow = null;
  const nombres = [...pendientesFollow.values()].slice(0, 5);
  pendientesFollow.clear();
  if (!nombres.length) return;

  const menciones = nombres.map((n) => `@${n}`).join(' ');
  decir(
    `#${CANAL_FOLLOWS}`,
    nombres.length === 1
      ? `holis ${menciones}, gracias por el folou`
      : `holis ${menciones}, gracias por los folous`
  );
}

async function suscribirFollows(sessionId) {
  const [broadcaster, moderador] = await Promise.all([
    idDeUsuario(CANAL_FOLLOWS),
    idDeUsuario(USERNAME)
  ]);
  await helix('/eventsub/subscriptions', 'POST', {
    type: 'channel.follow',
    version: '2',
    condition: { broadcaster_user_id: broadcaster, moderator_user_id: moderador },
    transport: { method: 'websocket', session_id: sessionId }
  });
}

function conectarFollows(url = 'wss://eventsub.wss.twitch.tv/ws', esReconexion = false) {
  const ws = new WebSocket(url);
  wsFollow = ws;
  let watchdog = null;
  let timeoutSeg = 30;

  const armarWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      console.warn('[FOLLOW] Sin señal de Twitch, reconectando...');
      ws.terminate();
    }, (timeoutSeg + 10) * 1000);
  };

  ws.on('message', async (raw) => {
    armarWatchdog();
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const tipo = msg.metadata && msg.metadata.message_type;

    if (tipo === 'session_welcome') {
      timeoutSeg = msg.payload.session.keepalive_timeout_seconds || 30;
      armarWatchdog();
      reintentosFollow = 0;
      if (!esReconexion) {
        try {
          await suscribirFollows(msg.payload.session.id);
          console.log('[FOLLOW] Suscripto a los follows de', CANAL_FOLLOWS);
        } catch (e) {
          console.error('[FOLLOW] No pude suscribirme (revisá el scope moderator:read:followers y que el bot sea mod):', e.message);
        }
      }
    } else if (tipo === 'session_reconnect') {
      conectarFollows(msg.payload.session.reconnect_url, true);
    } else if (tipo === 'notification' && msg.payload.subscription.type === 'channel.follow') {
      const ev = msg.payload.event;
      recibirFollow(ev.user_id, ev.user_name || ev.user_login);
    } else if (tipo === 'revocation') {
      console.error('[FOLLOW] Twitch revocó la suscripción:', msg.payload.subscription.status);
    }
  });

  ws.on('error', (e) => console.error('[FOLLOW] Error de WebSocket:', e.message));

  ws.on('close', () => {
    clearTimeout(watchdog);
    if (wsFollow !== ws) return; // era el socket viejo tras un session_reconnect
    const espera = Math.min(60000, 2000 * 2 ** reintentosFollow++);
    console.warn(`[FOLLOW] Conexión cerrada, reintento en ${espera / 1000}s`);
    setTimeout(() => conectarFollows(), espera);
  });
}

conectarFollows();

// ==========================================
// SERVIDOR HTTP (para que Render lo mantenga activo)
// ==========================================
const app = express();
const VERSION = 'v1-2026-11-24';

app.get('/', (req, res) => {
  res.status(200).send('Bot de saludos activo 🚀');
});

app.get('/version', (req, res) => {
  res.status(200).send(`Bot de saludos ${VERSION}`);
});

app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT} (${VERSION})`));
