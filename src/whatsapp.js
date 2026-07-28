import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';

// ── Supabase client ────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Supabase Auth State (replaces useMultiFileAuthState) ──────────────────
async function useSupabaseAuthState(sessionId = 'default') {
  const getItem = async (key) => {
    const { data } = await supabase
      .from('baileys_sessions')
      .select('data')
      .eq('id', `${sessionId}:${key}`)
      .maybeSingle();
    return data?.data ?? null;
  };

  const setItem = async (key, value) => {
    await supabase.from('baileys_sessions').upsert({
      id: `${sessionId}:${key}`,
      data: value,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  };

  const removeItem = async (key) => {
    await supabase.from('baileys_sessions').delete().eq('id', `${sessionId}:${key}`);
  };

  // Load creds
  let creds = await getItem('creds');
  if (!creds) {
    creds = initAuthCreds();
    await setItem('creds', creds);
  }

  const keys = {
    get: async (type, ids) => {
      const data = {};
      await Promise.all(ids.map(async (id) => {
        let value = await getItem(`${type}-${id}`);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        data[id] = value;
      }));
      return data;
    },
    set: async (data) => {
      const tasks = [];
      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];
          const key = `${category}-${id}`;
          if (value) tasks.push(setItem(key, value));
          else tasks.push(removeItem(key));
        }
      }
      await Promise.all(tasks);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await setItem('creds', creds);
    },
  };
}

// ── State ──────────────────────────────────────────────────────────────────
let sock = null;
let isConnected = false;
let messageHandler = null;
let currentQR = null;

// ── Initialize ────────────────────────────────────────────────────────────
export async function initWhatsApp(onMessage) {
  messageHandler = onMessage;
  await connect();
}

async function connect() {
  try {
    const { state, saveCreds } = await useSupabaseAuthState('financaspro');
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: ['FinançasPro', 'Chrome', '1.0.0'],
      getMessage: async () => ({ conversation: '' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        currentQR = qr;
        console.log('📱 QR code gerado! Acesse /qr para escanear.');
        try {
          const qrTerminal = await import('qrcode-terminal');
          qrTerminal.default.generate(qr, { small: true });
        } catch(e) {}
      }

      if (connection === 'open') {
        isConnected = true;
        currentQR = null;
        console.log('✅ WhatsApp conectado via Baileys + Supabase!');
      }

      if (connection === 'close') {
        isConnected = false;
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log(`⚠️ Conexão fechada (código ${code}). Reconectando: ${shouldReconnect}`);
        if (shouldReconnect) {
          setTimeout(connect, 5000);
        } else {
          // Logged out — clear session from Supabase
          console.log('🔴 Sessão encerrada. Limpando e reconectando...');
          await supabase.from('baileys_sessions').delete().like('id', 'financaspro:%');
          setTimeout(connect, 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '').replace('@g.us', '');
        if (!phone) continue;
        if (msg.key.remoteJid?.includes('@g.us')) continue;

        const messageType = Object.keys(msg.message)[0];
        let text = null;
        let audioBuffer = null;

        if (messageType === 'conversation') {
          text = msg.message.conversation;
        } else if (messageType === 'extendedTextMessage') {
          text = msg.message.extendedTextMessage?.text;
        } else if (messageType === 'audioMessage' || messageType === 'pttMessage') {
          try {
            const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
            audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
          } catch(e) {
            console.error('Audio download error:', e.message);
          }
        } else {
          continue;
        }

        console.log(`📨 Mensagem de ${phone}: ${text || '[audio]'}`);

        if (messageHandler) {
          messageHandler({ phone, text, audioBuffer, messageType, raw: msg })
            .catch(err => console.error('Message handler error:', err));
        }
      }
    });

  } catch(err) {
    console.error('Connect error:', err.message);
    setTimeout(connect, 10000);
  }
}

// ── Send ───────────────────────────────────────────────────────────────────
export async function sendTextMessage(phone, text) {
  if (!sock || !isConnected) {
    console.error('WhatsApp not connected — cannot send message');
    return;
  }
  const normalized = phone.replace(/\D/g, '');
  const number = normalized.startsWith('55') ? normalized : `55${normalized}`;
  const jid = `${number}@s.whatsapp.net`;
  console.log(`📤 Enviando para ${jid}: ${text.slice(0, 50)}...`);
  await sock.sendMessage(jid, { text });
}

export async function sendTyping(phone, duration = 1500) {
  if (!sock || !isConnected) return;
  try {
    const normalized = phone.replace(/\D/g, '');
    const number = normalized.startsWith('55') ? normalized : `55${normalized}`;
    const jid = `${number}@s.whatsapp.net`;
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, duration));
    await sock.sendPresenceUpdate('paused', jid);
  } catch(e) {}
}

export function getConnectionStatus() { return isConnected; }

export async function getQRCode() {
  if (!currentQR) return null;
  return await QRCode.toDataURL(currentQR);
}
