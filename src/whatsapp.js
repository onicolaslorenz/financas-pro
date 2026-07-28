import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { mkdir } from 'fs/promises';
import QRCode from 'qrcode';

// ── State ──────────────────────────────────────────────────────────────────
let sock = null;
let isConnected = false;
let messageHandler = null;
let currentQR = null;
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
    printQRInTerminal: false,
    browser: ['FinançasPro', 'Chrome', '1.0.0'],
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      console.log('📱 QR code gerado! Acesse /qr no browser para escanear.');
      // Also print as text
      const { default: qrTerminal } = await import('qrcode-terminal');
      qrTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
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
        currentQR = null;
        console.log('🔴 Sessão encerrada. Acesse /qr para reconectar.');
        setTimeout(connect, 5000);
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
    console.error('WhatsApp not connected — message not sent');
    return;
  }
  const normalized = phone.replace(/\D/g, '');
  const number = normalized.startsWith('55') ? normalized : `55${normalized}`;
  const jid = `${number}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}

export async function sendTyping(phone, duration = 2000) {
  if (!sock || !isConnected) return;
  try {
    const normalized = phone.replace(/\D/g, '');
    const number = normalized.startsWith('55') ? normalized : `55${normalized}`;
    const jid = `${number}@s.whatsapp.net`;
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, duration));
    await sock.sendPresenceUpdate('paused', jid);
  } catch(e) { /* non-critical */ }
}

export function getConnectionStatus() {
  return isConnected;
}

// ── QR endpoint helper ─────────────────────────────────────────────────────
export async function getQRCode() {
  if (!currentQR) return null;
  return await QRCode.toDataURL(currentQR);
}
