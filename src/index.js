import 'dotenv/config';
import express from 'express';
import { getUserByPhone } from './whatsapp.js';
import { handleMessage } from './handler.js';
import { sendTextMessage } from './whatsapp.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FinançasPro WhatsApp Bot', timestamp: new Date().toISOString() });
});

// ── Webhook from Evolution API ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Respond immediately so Evolution API doesn't retry
  res.sendStatus(200);

  try {
    const body = req.body;

    // Evolution API webhook format
    const event = body.event || body.type;

    // Only process incoming messages
    if (event !== 'messages.upsert' && event !== 'message') return;

    const messageData = body.data || body;
    const messages = messageData.messages || (messageData.key ? [messageData] : []);

    for (const msg of messages) {
      // Skip outgoing messages (sent by the bot itself)
      if (msg.key?.fromMe) continue;

      const phone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '').replace('@g.us', '');
      if (!phone) continue;

      // Skip group messages
      if (msg.key?.remoteJid?.includes('@g.us')) continue;

      // Get message content
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
        // Unsupported message type (image, video, sticker, etc.)
        continue;
      }

      // Look up user by phone
      const user = getUserByPhone(phone);
      if (!user) {
        console.log(`Unknown number: ${phone}`);
        // Optionally send a message to unknown numbers
        // await sendTextMessage(phone, 'Número não cadastrado no FinançasPro.');
        continue;
      }

      console.log(`[${new Date().toISOString()}] ${user.name} (${phone}): ${text || '[audio]'}`);

      // Process message asynchronously
      handleMessage({
        phone,
        messageType,
        text,
        messageKey,
        senderName: user.name,
        userId: user.userId,
      }).catch(err => console.error('Message handling error:', err));
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// ── Commands endpoint (for testing without WhatsApp) ───────────────────────
app.post('/test', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

  const user = getUserByPhone(phone);
  if (!user) return res.status(404).json({ error: 'User not found' });

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
