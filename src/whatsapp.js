import axios from 'axios';

// ── User mapping ───────────────────────────────────────────────────────────
// Parse WHATSAPP_USERS env: "phone:userId:name,phone:userId:name"
function parseUsers() {
  const raw = process.env.WHATSAPP_USERS || '';
  const map = {};
  raw.split(',').forEach(entry => {
    const [phone, userId, name] = entry.trim().split(':');
    if (phone && userId) {
      // Normalize: remove +, spaces, dashes
      const normalized = phone.replace(/\D/g, '');
      map[normalized] = { userId, name: name || 'Usuário' };
    }
  });
  return map;
}

let userMap = null;
export function getUserByPhone(phone) {
  if (!userMap) userMap = parseUsers();
  const normalized = phone.replace(/\D/g, '').replace(/^0/, '');
  // Try with and without country code
  return userMap[normalized] ||
         userMap[`55${normalized}`] ||
         userMap[normalized.replace(/^55/, '')] ||
         null;
}

// ── Evolution API client ───────────────────────────────────────────────────
function evolutionClient() {
  return axios.create({
    baseURL: process.env.EVOLUTION_API_URL,
    headers: {
      'apikey': process.env.EVOLUTION_API_KEY,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
}

export async function sendTextMessage(phone, text) {
  const instance = process.env.EVOLUTION_INSTANCE || 'financaspro';
  const client = evolutionClient();

  // Normalize phone for Evolution API
  const normalized = phone.replace(/\D/g, '');
  const number = normalized.startsWith('55') ? normalized : `55${normalized}`;

  await client.post(`/message/sendText/${instance}`, {
    number: `${number}@s.whatsapp.net`,
    text,
  });
}

export async function downloadMedia(messageKey, instance) {
  const client = evolutionClient();
  const inst = instance || process.env.EVOLUTION_INSTANCE || 'financaspro';
  const res = await client.post(`/chat/getBase64FromMediaMessage/${inst}`, {
    message: messageKey,
    convertToMp4: false,
  });
  return res.data?.base64 ? Buffer.from(res.data.base64, 'base64') : null;
}

export async function sendTyping(phone, duration = 2000) {
  try {
    const instance = process.env.EVOLUTION_INSTANCE || 'financaspro';
    const client = evolutionClient();
    const normalized = phone.replace(/\D/g, '');
    const number = normalized.startsWith('55') ? normalized : `55${normalized}`;
    await client.post(`/chat/sendPresence/${instance}`, {
      number: `${number}@s.whatsapp.net`,
      options: { presence: 'composing', delay: duration },
    });
  } catch { /* non-critical */ }
}
