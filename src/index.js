import 'dotenv/config';
import express from 'express';
import { getUserByPhoneDB, getSession, setSession, clearSession, generateCode, verifyCode, sendVerificationEmail, normalizePhone } from './auth.js';
import { handleMessage } from './handler.js';
import { sendTextMessage, sendTyping } from './whatsapp.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FinançasPro WhatsApp Bot', timestamp: new Date().toISOString() });
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
      if (!phone) continue;
      if (msg.key?.remoteJid?.includes('@g.us')) continue;

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

      // Handle async without blocking
      processIncoming({ phone, messageType, text, messageKey })
        .catch(err => console.error('Processing error:', err));
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// ── Core message router ────────────────────────────────────────────────────
async function processIncoming({ phone, messageType, text, messageKey }) {
  const session = getSession(phone);

  // ── LINKING FLOW ──────────────────────────────────────────────────────────

  // State: awaiting_code — user should send the 6-digit code
  if (session.state === 'awaiting_code') {
    const input = text?.trim();
    if (!input) return;

    // Allow cancel
    if (input.toLowerCase() === 'cancelar') {
      clearSession(phone);
      await sendTextMessage(phone, 'Vinculação cancelada. Me manda qualquer mensagem quando quiser tentar de novo.');
      return;
    }

    await sendTyping(phone, 1000);
    const result = await verifyCode(phone, input);

    if (result.ok) {
      clearSession(phone);
      await sendTextMessage(phone,
        `✅ *WhatsApp vinculado com sucesso!*\n\n` +
        `Olá, ${result.name}! Agora você pode usar o assistente financeiro aqui pelo WhatsApp.\n\n` +
        `Experimente:\n` +
        `• "Qual meu saldo?"\n` +
        `• "Gastei 50 no mercado"\n` +
        `• "Resumo do mês"`
      );
    } else {
      await sendTextMessage(phone,
        `❌ ${result.reason}\n\nTente novamente ou envie *cancelar* para recomeçar.`
      );
    }
    return;
  }

  // State: awaiting_email — user should send their email
  if (session.state === 'awaiting_email') {
    const input = text?.trim().toLowerCase();
    if (!input) return;

    if (input === 'cancelar') {
      clearSession(phone);
      await sendTextMessage(phone, 'Tudo bem! Me manda uma mensagem quando quiser tentar de novo.');
      return;
    }

    // Basic email validation
    if (!input.includes('@') || !input.includes('.')) {
      await sendTextMessage(phone, 'Não parece um e-mail válido. Tente novamente ou envie *cancelar*.');
      return;
    }

    await sendTyping(phone, 1500);

    try {
      const code = await generateCode(phone, input);
      await sendVerificationEmail(input, code, 'usuário');
      setSession(phone, { state: 'awaiting_code', email: input });
      await sendTextMessage(phone,
        `📧 Código enviado para *${input}*!\n\n` +
        `Verifique seu e-mail e me mande os 6 dígitos aqui.\n` +
        `_Válido por 10 minutos. Envie *cancelar* para recomeçar._`
      );
    } catch (err) {
      console.error('Email error:', err);
      // If no email service, show code directly (dev mode)
      if (!process.env.RESEND_API_KEY) {
        const code = await generateCode(phone, input);
        setSession(phone, { state: 'awaiting_code', email: input });
        await sendTextMessage(phone,
          `🔧 *Modo teste* — seu código é: *${code}*\n_(Em produção, isso chegaria por e-mail)_`
        );
      } else {
        await sendTextMessage(phone, '❌ Erro ao enviar o e-mail. Verifique o endereço e tente novamente.');
      }
    }
    return;
  }

  // ── CHECK IF LINKED ───────────────────────────────────────────────────────
  const user = await getUserByPhoneDB(phone).catch(() => null);

  if (!user) {
    // Unknown number — start linking flow
    console.log(`New number: ${phone} — starting link flow`);
    setSession(phone, { state: 'awaiting_email' });
    await sendTextMessage(phone,
      `👋 Olá! Bem-vindo ao *FinançasPro*.\n\n` +
      `Para usar o assistente, preciso vincular este número à sua conta.\n\n` +
      `1️⃣ Primeiro, crie sua conta em:\n*https://financaspro-nl.netlify.app*\n\n` +
      `2️⃣ Depois, me manda o *e-mail* que você usou para cadastrar.`
    );
    return;
  }

  // ── LINKED — process normally ─────────────────────────────────────────────
  console.log(`[${new Date().toISOString()}] ${user.name} (${phone}): ${text || '[audio]'}`);

  handleMessage({
    phone,
    messageType,
    text,
    messageKey,
    senderName: user.name,
    userId: user.userId,
  }).catch(err => console.error('Message handling error:', err));
}

// ── Test endpoint ──────────────────────────────────────────────────────────
app.post('/test', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

  const user = await getUserByPhoneDB(phone).catch(() => null);
  if (!user) return res.status(404).json({ error: 'Phone not linked. Send a message to the bot first.' });

  try {
    await handleMessage({
      phone,
      messageType: 'conversation',
      text: message,
      messageKey: null,
      senderName: user.name,
      userId: user.userId,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ FinançasPro Bot running on port ${PORT}`);
  console.log(`📡 Webhook: POST /webhook`);
  console.log(`🧪 Test: POST /test`);
});
