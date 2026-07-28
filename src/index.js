import 'dotenv/config';
import express from 'express';
import { getUserByPhoneDB, getSession, setSession, clearSession, generateCode, verifyCode, sendVerificationEmail } from './auth.js';
import { handleMessage } from './handler.js';
import { sendTextMessage, sendTyping, downloadMedia } from './whatsapp.js';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true })); // Twilio sends form-encoded webhooks

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FinançasPro Bot (Twilio)', timestamp: new Date().toISOString() });
});

// ── Twilio WhatsApp Webhook ────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Twilio expects TwiML response (can be empty)
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  try {
    const body = req.body;
    // Twilio sends: From, Body, MediaUrl0, MediaContentType0
    const from = body.From; // e.g. "whatsapp:+554796145244"
    const text = body.Body || '';
    const mediaUrl = body.MediaUrl0 || null;
    const mediaType = body.MediaContentType0 || '';

    if (!from) return;

    // Extract phone number
    const phone = from.replace('whatsapp:+', '').replace('+', '');
    console.log(`📨 ${phone}: ${text || '[media]'}`);

    // Determine message type
    let messageType = 'conversation';
    let audioBuffer = null;

    if (mediaUrl && mediaType.startsWith('audio/')) {
      messageType = 'audioMessage';
      audioBuffer = await downloadMedia(mediaUrl);
    }

    processIncoming({ phone, messageType, text, audioBuffer }).catch(console.error);
  } catch(e) {
    console.error('Webhook error:', e.message);
  }
});

// ── Message router ─────────────────────────────────────────────────────────
async function processIncoming({ phone, messageType, text, audioBuffer }) {
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

  handleMessage({ phone, messageType, text, audioBuffer, messageKey: null, senderName: user.name, userId: user.userId })
    .catch(console.error);
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ FinançasPro Bot (Twilio) running on port ${PORT}`);
});
