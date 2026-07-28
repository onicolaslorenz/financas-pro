import axios from 'axios';

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM || 'whatsapp:+14155238886';

// ── Send message ───────────────────────────────────────────────────────────
export async function sendTextMessage(phone, text) {
  const normalized = phone.replace(/\D/g, '');
  const number = normalized.startsWith('55') ? normalized : `55${normalized}`;
  const to = `whatsapp:+${number}`;

  try {
    const res = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({ To: to, From: FROM_NUMBER, Body: text }),
      {
        auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );
    console.log(`📤 Sent to ${to} — SID: ${res.data.sid}`);
  } catch(e) {
    console.error('sendTextMessage error:', e.response?.data || e.message);
  }
}

export async function sendTyping(phone, duration = 1000) {
  // Twilio doesn't support typing indicators — just wait briefly
  await new Promise(r => setTimeout(r, Math.min(duration, 1000)));
}

export async function downloadMedia(mediaUrl) {
  try {
    const res = await axios.get(mediaUrl, {
      auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
      responseType: 'arraybuffer',
      timeout: 15000,
    });
    return Buffer.from(res.data);
  } catch(e) {
    console.error('downloadMedia error:', e.message);
    return null;
  }
}
