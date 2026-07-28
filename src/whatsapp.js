import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';

// ── State ──────────────────────────────────────────────────────────────────
let sock = null;
let isConnected = false;
let messageHandler = null;
const AUTH_DIR = './auth_info_baileys';

// ── Initialize Baileys ─────────────────────────────────────────────────────
export async function initWhatsApp(onMessage) {
  messageHandler = onMessage;
  await mkdir(AUTH_DIR, { recursive: true });
  await connect();
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: true,
    browser: ['FinançasPro', 'Chrome', '1.0.0'],
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 ESCANEIE O QR CODE ACIMA COM O WHATSAPP DO NÚMERO 6534\n');
    }

    if (connection === 'open') {
      isConnected = true;
      console.log('✅ WhatsApp conectado via Baileys!');
    }

    if (connection === 'close') {
      isConnected = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`⚠️ Conexão fechada (código ${code}). Reconectando: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connect, 3000);
      } else {
        console.log('🔴 Sessão encerrada. Apague a pasta auth_info_baileys e reinicie.');
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

      if (messageHandler) {
        messageHandler({ phone, text, audioBuffer, messageType, raw: msg })
          .catch(err => console.error('Message handler error:', err));
      }
    }
  });
}

// ── Send message ───────────────────────────────────────────────────────────
export async function sendTextMessage(phone, text) {
  if (!sock || !isConnected) {
    console.error('WhatsApp not connected');
    return;
  }
  const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}

export async function sendTyping(phone, duration = 2000) {
  if (!sock || !isConnected) return;
  try {
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, duration));
    await sock.sendPresenceUpdate('paused', jid);
  } catch(e) { /* non-critical */ }
}

export function getConnectionStatus() {
  return isConnected;
}
