import 'dotenv/config';
import express from 'express';
import { getUserByPhoneDB, getSession, setSession, clearSession, generateCode, verifyCode, sendVerificationEmail } from './auth.js';
import { handleMessage } from './handler.js';
import { sendTextMessage, sendTyping, initWhatsApp, getConnectionStatus } from './whatsapp.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'FinançasPro WhatsApp Bot (Baileys)',
    whatsapp: getConnectionStatus() ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// ── Core message router ────────────────────────────────────────────────────
async function processIncoming({ phone, text, audioBuffer, messageType, raw }) {
  const session = getSession(phone);

  // ── LINKING FLOW ──────────────────────────────────────────────────────────
  if (session.state === 'awaiting_code') {
    const input = text?.trim();
    if (!input) return;
    if (input.toLowerCase() === 'cancelar') {
      clearSession(phone);
      await sendTextMessage(phone, 'Vinculação cancelada. Me manda qualquer mensagem quando quiser tentar de novo.');
      return;
    }
    const result = await verifyCode(phone, input);
    if (result.ok) {
      clearSession(phone);
      await sendTextMessage(phone,
        `✅ *WhatsApp vinculado com sucesso!*\n\nOlá, ${result.name}! Agora você pode usar o assistente financeiro.\n\n` +
        `Experimente:\n• "Qual meu saldo?"\n• "Gastei 50 no mercado"\n• "Resumo do mês"`
      );
    } else {
      await sendTextMessage(phone, `❌ ${result.reason}\n\nTente novamente ou envie *cancelar* para recomeçar.`);
    }
    return;
  }

  if (session.state === 'awaiting_email') {
    const input = text?.trim().toLowerCase();
    if (!input) return;
    if (input === 'cancelar') {
      clearSession(phone);
      await sendTextMessage(phone, 'Tudo bem! Me manda uma mensagem quando quiser tentar de novo.');
      return;
    }
    if (!input.includes('@') || !input.includes('.')) {
      await sendTextMessage(phone, 'Não parece um e-mail válido. Tente novamente ou envie *cancelar*.');
      return;
    }
    try {
      const code = await generateCode(phone, input);
      await sendVerificationEmail(input, code, 'usuário');
      setSession(phone, { state: 'awaiting_code', email: input });
      await sendTextMessage(phone,
        `📧 Código enviado para *${input}*!\n\nVerifique seu e-mail e me mande os 6 dígitos.\n_Válido por 10 minutos. Envie *cancelar* para recomeçar._`
      );
    } catch (err) {
      if (!process.env.RESEND_API_KEY) {
        const code = await generateCode(phone, input);
        setSession(phone, { state: 'awaiting_code', email: input });
        await sendTextMessage(phone, `🔧 *Modo teste* — seu código é: *${code}*`);
      } else {
        await sendTextMessage(phone, '❌ Erro ao enviar o e-mail. Verifique o endereço e tente novamente.');
      }
    }
    return;
  }

  // ── CHECK IF LINKED ───────────────────────────────────────────────────────
  const user = await getUserByPhoneDB(phone).catch(() => null);

  if (!user) {
    setSession(phone, { state: 'awaiting_email' });
    await sendTextMessage(phone,
      `👋 Olá! Bem-vindo ao *FinançasPro*.\n\n` +
      `Para usar o assistente, preciso vincular este número à sua conta.\n\n` +
      `1️⃣ Crie sua conta em:\n*https://financaspro-nl.netlify.app*\n\n` +
      `2️⃣ Me manda o *e-mail* que você usou para cadastrar.`
    );
    return;
  }

  // ── LINKED — process normally ─────────────────────────────────────────────
  console.log(`[${new Date().toISOString()}] ${user.name} (${phone}): ${text || '[audio]'}`);

  handleMessage({
    phone,
    messageType: audioBuffer ? 'audioMessage' : messageType,
    text,
    audioBuffer,
    messageKey: null,
    senderName: user.name,
    userId: user.userId,
  }).catch(err => console.error('Message handling error:', err));
}

// ── Test endpoint ──────────────────────────────────────────────────────────
app.post('/test', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  const user = await getUserByPhoneDB(phone).catch(() => null);
  if (!user) return res.status(404).json({ error: 'Phone not linked' });
  try {
    await handleMessage({
      phone, messageType: 'conversation', text: message,
      messageKey: null, senderName: user.name, userId: user.userId,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ FinançasPro Bot running on port ${PORT}`);
  console.log(`🔁 Initializing WhatsApp (Baileys)...`);
  await initWhatsApp(processIncoming);
});
