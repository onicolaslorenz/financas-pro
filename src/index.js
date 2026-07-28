import 'dotenv/config';
import express from 'express';
import { getUserByPhoneDB, getSession, setSession, clearSession, generateCode, verifyCode, sendVerificationEmail } from './auth.js';
import { handleMessage } from './handler.js';
import { sendTextMessage, sendTyping, setupWebhook, getInstanceStatus } from './whatsapp.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  const status = await getInstanceStatus();
  res.json({
    status: 'ok',
    service: 'FinançasPro Bot',
    whatsapp: status,
    timestamp: new Date().toISOString(),
  });
});

// ── Webhook from Evolution API ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    const event = body.event || body.type;
    if (event !== 'messages.upsert' && event !== 'message') return;

    const messageData = body.data || body;
    const messages = messageData.messages || (messageData.key ? [messageData] : []);

    for (const msg of messages) {
      if (msg.key?.fromMe) continue;
      const phone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '').replace('@g.us', '');
      if (!phone || msg.key?.remoteJid?.includes('@g.us')) continue;

      const messageType = msg.message ? Object.keys(msg.message)[0] : null;
      let text = null;
      let messageKey = null;

      if (messageType === 'conversation') {
        text = msg.message.conversation;
      } else if (messageType === 'extendedTextMessage') {
        text = msg.message.extendedTextMessage?.text;
      } else if (messageType === 'audioMessage' || messageType === 'pttMessage') {
        messageKey = { key: msg.key, message: msg.message };
      } else {
        continue;
      }

      console.log(`📨 ${phone}: ${text || '[audio]'}`);
      processIncoming({ phone, messageType, text, messageKey }).catch(console.error);
    }
  } catch(e) {
    console.error('Webhook error:', e.message);
  }
});

// ── Message router ────────────────────────────────────────────────────────
async function processIncoming({ phone, messageType, text, messageKey }) {
  const session = getSession(phone);

  if (session.state === 'awaiting_code') {
    const input = text?.trim();
    if (!input) return;
    if (input.toLowerCase() === 'cancelar') {
      clearSession(phone);
      await sendTextMessage(phone, 'Vinculação cancelada.');
      return;
    }
    const result = await verifyCode(phone, input);
    if (result.ok) {
      clearSession(phone);
      await sendTextMessage(phone,
        `✅ *Vinculado com sucesso!*\n\nOlá, ${result.name}!\n\nExperimente:\n• "Qual meu saldo?"\n• "Gastei 50 no mercado"\n• "Resumo do mês"`
      );
    } else {
      await sendTextMessage(phone, `❌ ${result.reason}\n\nTente novamente ou envie *cancelar*.`);
    }
    return;
  }

  if (session.state === 'awaiting_email') {
    const input = text?.trim().toLowerCase();
    if (!input) return;
    if (input === 'cancelar') { clearSession(phone); await sendTextMessage(phone, 'Cancelado.'); return; }
    if (!input.includes('@') || !input.includes('.')) {
      await sendTextMessage(phone, 'E-mail inválido. Tente novamente ou envie *cancelar*.');
      return;
    }
    try {
      const code = await generateCode(phone, input);
      await sendVerificationEmail(input, code, 'usuário');
      setSession(phone, { state: 'awaiting_code', email: input });
      await sendTextMessage(phone, `📧 Código enviado para *${input}*!\n\nMe mande os 6 dígitos.\n_Válido por 10 minutos._`);
    } catch(e) {
      if (!process.env.RESEND_API_KEY) {
        const code = await generateCode(phone, input);
        setSession(phone, { state: 'awaiting_code', email: input });
        await sendTextMessage(phone, `🔧 Modo teste — código: *${code}*`);
      } else {
        await sendTextMessage(phone, '❌ Erro ao enviar e-mail. Tente novamente.');
      }
    }
    return;
  }

  const user = await getUserByPhoneDB(phone).catch(() => null);
  if (!user) {
    setSession(phone, { state: 'awaiting_email' });
    await sendTextMessage(phone,
      `👋 Bem-vindo ao *FinançasPro*!\n\n` +
      `Para usar o assistente:\n\n` +
      `1️⃣ Crie sua conta em:\n*https://financaspro-nl.netlify.app*\n\n` +
      `2️⃣ Me mande o *e-mail* cadastrado.`
    );
    return;
  }

  handleMessage({ phone, messageType, text, messageKey, senderName: user.name, userId: user.userId })
    .catch(console.error);
}

// ── Keep-alive ─────────────────────────────────────────────────────────────
function startKeepAlive() {
  const SELF = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;

  const ping = async () => {
    const status = await getInstanceStatus();
    if (status === 'open') {
      console.log(`✅ Keep-alive: WhatsApp connected (${new Date().toLocaleTimeString('pt-BR')})`);
    } else {
      console.log(`⚠️ Keep-alive: status = "${status}"`);
      // Auto-reconfigure webhook if connected but webhook may have dropped
      if (status === 'open' && SELF) {
        await setupWebhook(`${SELF}/webhook`).catch(() => {});
      }
    }
    if (SELF) fetch(`${SELF}/`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
  };

  setTimeout(() => { ping(); setInterval(ping, 4 * 60 * 1000); }, 30000);
  console.log('🔁 Keep-alive started');
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ FinançasPro Bot running on port ${PORT}`);

  // Auto-configure webhook on startup
  const SELF = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
  if (SELF) {
    setTimeout(async () => {
      await setupWebhook(`${SELF}/webhook`);
    }, 5000);
  }

  startKeepAlive();
});
