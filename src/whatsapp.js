import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Evolution API client ───────────────────────────────────────────────────
function evo() {
  return axios.create({
    baseURL: process.env.EVOLUTION_API_URL,
    headers: {
      'apikey': process.env.EVOLUTION_API_KEY,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

const INSTANCE = () => process.env.EVOLUTION_INSTANCE || 'financaspro';

// ── Send message ───────────────────────────────────────────────────────────
export async function sendTextMessage(phone, text) {
  const normalized = phone.replace(/\D/g, '');
  const number = normalized.startsWith('55') ? normalized : `55${normalized}`;
  try {
    await evo().post(`/message/sendText/${INSTANCE()}`, {
      number: `${number}@s.whatsapp.net`,
      text,
    });
    console.log(`📤 Sent to ${number}`);
  } catch(e) {
    console.error('sendTextMessage error:', e.response?.data || e.message);
  }
}

export async function sendTyping(phone, duration = 1500) {
  const normalized = phone.replace(/\D/g, '');
  const number = normalized.startsWith('55') ? normalized : `55${normalized}`;
  try {
    await evo().post(`/chat/sendPresence/${INSTANCE()}`, {
      number: `${number}@s.whatsapp.net`,
      options: { presence: 'composing', delay: duration },
    });
  } catch(e) { /* non-critical */ }
}

export async function downloadMedia(messageKey) {
  try {
    const res = await evo().post(`/chat/getBase64FromMediaMessage/${INSTANCE()}`, {
      message: messageKey,
      convertToMp4: false,
    });
    return res.data?.base64 ? Buffer.from(res.data.base64, 'base64') : null;
  } catch(e) {
    console.error('downloadMedia error:', e.message);
    return null;
  }
}

// ── Session persistence in Supabase ───────────────────────────────────────
export async function saveSession(instanceName, data) {
  await supabase.from('evolution_sessions').upsert({
    instance: instanceName,
    data,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'instance' });
}

export async function getSession(instanceName) {
  const { data } = await supabase
    .from('evolution_sessions')
    .select('data')
    .eq('instance', instanceName)
    .maybeSingle();
  return data?.data || null;
}

// ── Webhook setup ──────────────────────────────────────────────────────────
export async function setupWebhook(webhookUrl) {
  try {
    await evo().post(`/webhook/set/${INSTANCE()}`, {
      webhook: {
        enabled: true,
        url: webhookUrl,
        webhook_by_events: false,
        webhook_base64: false,
        events: ['MESSAGES_UPSERT'],
      },
    });
    console.log(`✅ Webhook configured: ${webhookUrl}`);
  } catch(e) {
    console.error('setupWebhook error:', e.response?.data || e.message);
  }
}

// ── Instance status ────────────────────────────────────────────────────────
export async function getInstanceStatus() {
  try {
    const res = await evo().get('/instance/fetchInstances');
    const instances = res.data;
    const inst = Array.isArray(instances)
      ? instances.find(i => i.name === INSTANCE() || i.instance?.instanceName === INSTANCE())
      : null;
    return inst?.connectionStatus || inst?.instance?.state || 'unknown';
  } catch(e) {
    return 'error';
  }
}
