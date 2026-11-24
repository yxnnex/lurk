const express = require('express');
const tmi = require('tmi.js');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');

// ==========================================
// CONFIGURACIÓN (todo lo sensible va por variables de entorno)
// ==========================================
const USERNAME = (process.env.TWITCH_USERNAME || '').trim().toLowerCase(); // usuario del bot (la cuenta nueva)
const OAUTH_TOKEN = (process.env.TWITCH_OAUTH || '').trim();                // ej: oauth:xxxxxxxx
const CLIENT_ID = (process.env.TWITCH_CLIENT_ID || '').trim();
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;     // recomendado: guarda la lista de canales y a quién ya saludó
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim(); // contraseña del panel web (index.html)

// Canal donde se agradecen los follows y desde donde se manejan los comandos (!lurk ...)
const CANAL_FOLLOWS = 's2yone';
const MAX_CANALES = 50;

const limpiarCanal = (s) => String(s || '').trim().toLowerCase().replace(/^[@#]+/, '');
const canalValido = (c) => /^[a-z0-9_]{3,25}$/.test(c);

// Lista inicial de canales (solo se usa la primera vez, o si no hay Upstash).
// Se puede cambiar con la variable de entorno CANALES_ONLINE (separados por coma).
const BASE_ONLINE = (process.env.CANALES_ONLINE || 'm0t0maia,vladsuo,hella_tv,candeli_nn,bizarr0n,hunniuwu')
  .split(',')
  .map(limpiarCanal)
  .filter(canalValido);

if (!USERNAME || !OAUTH_TOKEN || !CLIENT_ID) {
  console.error('❌ Faltan variables de entorno: TWITCH_USERNAME, TWITCH_OAUTH y TWITCH_CLIENT_ID son obligatorias');
  process.exit(1);
}
if (!REDIS_URL || !REDIS_TOKEN) {
  console.warn('⚠️ Sin Upstash: los cambios de canales con !lurk y los follows saludados se pierden al reiniciar.');
}

// ==========================================
// UTILIDADES
// ==========================================
let client = null;

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
// LISTA DE CANALES A LURKEAR (editable con !lurk, guardada en Upstash)
// ==========================================
const CLAVE_CANALES = 'lurk:canales';
let canalesOnline = [];

async function cargarCanales() {
  if (usaRedis) {
    try {
      const guardados = await redisCmd('SMEMBERS', CLAVE_CANALES);
      if (Array.isArray(guardados) && guardados.length) {
        return guardados.map(limpiarCanal).filter(canalValido);
      }
      // Primera vez: se guarda la lista inicial
      if (BASE_ONLINE.length) await redisCmd('SADD', CLAVE_CANALES, ...BASE_ONLINE);
    } catch (e) {
      console.error('[CANALES] Error leyendo Upstash, uso la lista inicial:', e.message);
    }
  }
  return [...BASE_ONLINE];
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
  if (!canalesOnline.length) return;
  try {
    const lista = [...canalesOnline];
    const params = lista.map((c) => `user_login=${encodeURIComponent(c)}`).join('&');
    const data = await helix(`/streams?${params}&first=100`);
    const vivos = new Map(
      (data.data || []).filter((s) => s.type === 'live').map((s) => [s.user_login.toLowerCase(), s])
    );

    for (const canal of lista) {
      const ahora = vivos.has(canal);
      const antes = enVivoAntes.get(canal);
      enVivoAntes.set(canal, ahora);

      // antes === undefined: primera revisión (o reinicio, o canal recién agregado), no saluda
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

// ==========================================
// AGREGAR / QUITAR CANALES (lo usan los comandos del chat y el panel web)
// ==========================================
async function agregarCanal(canal) {
  if (!canalValido(canal)) return { ok: false, msg: 'Nombre de canal inválido' };
  if (canal === CANAL_FOLLOWS) return { ok: false, msg: `Ya estoy siempre en #${CANAL_FOLLOWS}` };
  if (canalesOnline.includes(canal)) return { ok: false, msg: `Ya estoy lurkeando en ${canal}` };
  if (canalesOnline.length >= MAX_CANALES) return { ok: false, msg: `Llegué al máximo de ${MAX_CANALES} canales` };
  try {
    await idDeUsuario(canal); // verifica que el canal exista (evita errores de tipeo)
  } catch (e) {
    return { ok: false, msg: `No encontré el canal ${canal} en Twitch` };
  }
  canalesOnline.push(canal);
  if (usaRedis) await redisCmd('SADD', CLAVE_CANALES, canal).catch((e) => console.error('[CANALES] Redis:', e.message));
  await client.join(`#${canal}`).catch((e) => console.error(`[CANALES] No pude entrar a ${canal}:`, e.message || e));
  console.log(`[CANALES] Agregado ${canal}`);
  return { ok: true, msg: `Ahora lurkeo en ${canal}` + (usaRedis ? '' : ' (sin Upstash se pierde al reiniciar)') };
}

async function quitarCanal(canal) {
  if (!canalesOnline.includes(canal)) return { ok: false, msg: `No estoy lurkeando en ${canal}` };
  canalesOnline = canalesOnline.filter((c) => c !== canal);
  enVivoAntes.delete(canal);
  ultimaBienvenida.delete(canal);
  if (usaRedis) await redisCmd('SREM', CLAVE_CANALES, canal).catch((e) => console.error('[CANALES] Redis:', e.message));
  await client.part(`#${canal}`).catch((e) => console.error(`[CANALES] No pude salir de ${canal}:`, e.message || e));
  console.log(`[CANALES] Quitado ${canal}`);
  return { ok: true, msg: `Ya no lurkeo en ${canal}` + (usaRedis ? '' : ' (sin Upstash se pierde al reiniciar)') };
}

// ==========================================
// COMANDOS PARA EDITAR LOS CANALES (solo s2yone, escribiendo en su chat)
//   !lurk add canal     -> empieza a lurkear ese canal
//   !lurk del canal     -> deja de lurkearlo
//   !lurk lista         -> muestra los canales actuales
// ==========================================
async function manejarMensaje(target, context, message, self) {
  try {
    if (self) return;
    if (target.toLowerCase() !== `#${CANAL_FOLLOWS}`) return;
    if (context.username.toLowerCase() !== CANAL_FOLLOWS) return;

    const m = message.trim().toLowerCase().match(/^!lurk\s+(add|del|lista)(?:\s+(\S+))?$/);
    if (!m) return;
    const accion = m[1];

    if (accion === 'lista') {
      const texto = canalesOnline.length ? `Lurkeo en: ${canalesOnline.join(', ')}` : 'No estoy lurkeando en ningún canal';
      await decir(target, texto.slice(0, 450));
      return;
    }

    const canal = limpiarCanal(m[2]);
    if (!canalValido(canal)) {
      await decir(target, 'Uso: !lurk add canal | !lurk del canal | !lurk lista');
      return;
    }
    const r = accion === 'add' ? await agregarCanal(canal) : await quitarCanal(canal);
    await decir(target, r.ok ? `✅ ${r.msg}` : r.msg);
  } catch (e) {
    console.error('[CANALES] Error en el comando:', e);
  }
}

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

// ==========================================
// ARRANQUE
// ==========================================
async function iniciar() {
  canalesOnline = await cargarCanales();
  const canales = [...new Set([CANAL_FOLLOWS, ...canalesOnline])];

  client = new tmi.Client({
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    identity: {
      username: USERNAME,
      password: OAUTH_TOKEN.startsWith('oauth:') ? OAUTH_TOKEN : `oauth:${OAUTH_TOKEN}`
    },
    channels: canales
  });

  client.on('connected', () => console.log('[BOT] Conectado y lurkeando en:', canales.join(', ')));
  client.on('notice', (canal, id, msg) => console.warn(`[NOTICE] ${canal} (${id}): ${msg}`));
  client.on('message', manejarMensaje);

  await client.connect().catch(console.error);

  revisarOnline();
  setInterval(revisarOnline, INTERVALO_ONLINE);
  conectarFollows();
}

iniciar();

// ==========================================
// SERVIDOR HTTP (para que Render lo mantenga activo)
// ==========================================
const app = express();
const VERSION = 'v3-2026-11-24';
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));

// Página principal: el panel (index.html). Si el archivo falta, igual responde 200 para los pings.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err && !res.headersSent) res.status(200).send('Bot de saludos activo 🚀');
  });
});

// ---------- API DEL PANEL (protegida con ADMIN_PASSWORD) ----------
if (!ADMIN_PASSWORD) console.warn('⚠️ Falta ADMIN_PASSWORD: el panel web no puede editar canales.');
const fallosPanel = new Map();

function validarPanel(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Falta ADMIN_PASSWORD en Render' });

  const reg = fallosPanel.get(req.ip);
  if (reg && reg.n >= 10 && Date.now() < reg.hasta) {
    return res.status(429).json({ error: 'Demasiados intentos, esperá 15 minutos' });
  }

  const dada = Buffer.from(String(req.get('x-admin-key') || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  if (dada.length !== real.length || !crypto.timingSafeEqual(dada, real)) {
    const vigente = reg && Date.now() < reg.hasta ? reg.n : 0;
    fallosPanel.set(req.ip, { n: vigente + 1, hasta: Date.now() + 15 * 60 * 1000 });
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  fallosPanel.delete(req.ip);
  next();
}

const responder = (fn) => async (req, res) => {
  try {
    const r = await fn(req);
    res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, msg: r.msg } : { error: r.msg });
  } catch (e) {
    console.error('[PANEL] Error:', e.message);
    res.status(500).json({ error: 'No se pudo completar la acción' });
  }
};

app.get('/api/canales', validarPanel, (req, res) => {
  res.json({
    canales: canalesOnline.map((c) => ({ nombre: c, enVivo: enVivoAntes.has(c) ? enVivoAntes.get(c) : null })),
    persistente: usaRedis,
    canalFollows: CANAL_FOLLOWS
  });
});

app.post('/api/canales', validarPanel, responder((req) => agregarCanal(limpiarCanal(req.body && req.body.canal))));
app.delete('/api/canales/:canal', validarPanel, responder((req) => quitarCanal(limpiarCanal(req.params.canal))));

app.get('/version', (req, res) => {
  res.status(200).send(`Bot de saludos ${VERSION}`);
});

app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT} (${VERSION})`));
