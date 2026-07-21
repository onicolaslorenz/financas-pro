import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Normalize phone ────────────────────────────────────────────────────────
export function normalizePhone(phone) {
  let p = phone.replace(/\D/g, '');
  if (!p.startsWith('55')) p = '55' + p;
  return p;
}

// ── Get linked user by phone ───────────────────────────────────────────────
export async function getUserByPhoneDB(phone) {
  const p = normalizePhone(phone);
  const { data } = await supabase
    .from('whatsapp_links')
    .select('user_id, profiles(nome, email)')
    .eq('phone', p)
    .eq('verified', true)
    .maybeSingle();
  if (!data) return null;
  return {
    userId: data.user_id,
    name: data.profiles?.nome || data.profiles?.email?.split('@')[0] || 'Usuário',
    email: data.profiles?.email,
  };
}

// ── Link states (per phone, in-memory session) ────────────────────────────
// States: idle → awaiting_email → awaiting_code
const sessions = {};

export function getSession(phone) {
  return sessions[phone] || { state: 'idle' };
}
export function setSession(phone, data) {
  sessions[phone] = data;
  // Auto-clear after 10 minutes
  setTimeout(() => { delete sessions[phone]; }, 10 * 60 * 1000);
}
export function clearSession(phone) {
  delete sessions[phone];
}

// ── Generate and store code ────────────────────────────────────────────────
export async function generateCode(phone, email) {
  const p = normalizePhone(phone);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  // Delete any existing codes for this phone
  await supabase.from('whatsapp_codes').delete().eq('phone', p);

  // Insert new code
  await supabase.from('whatsapp_codes').insert({
    phone: p, email, code, expires_at: expiresAt,
  });

  return code;
}

// ── Verify code and link phone to account ─────────────────────────────────
export async function verifyCode(phone, inputCode) {
  const p = normalizePhone(phone);

  const { data: row } = await supabase
    .from('whatsapp_codes')
    .select('*')
    .eq('phone', p)
    .eq('code', inputCode)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!row) return { ok: false, reason: 'Código inválido ou expirado.' };

  // Find user by email in profiles
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, nome, email')
    .eq('email', row.email)
    .maybeSingle();

  if (!profile) return { ok: false, reason: 'E-mail não encontrado. Crie sua conta no app primeiro.' };

  // Check if phone already linked to another account
  const { data: existing } = await supabase
    .from('whatsapp_links')
    .select('user_id')
    .eq('phone', p)
    .maybeSingle();

  if (existing) {
    // Update existing link
    await supabase.from('whatsapp_links').update({
      user_id: profile.id, verified: true,
    }).eq('phone', p);
  } else {
    // Create new link
    await supabase.from('whatsapp_links').insert({
      phone: p, user_id: profile.id, verified: true,
    });
  }

  // Clean up the code
  await supabase.from('whatsapp_codes').delete().eq('phone', p);

  return { ok: true, userId: profile.id, name: profile.nome || profile.email.split('@')[0] };
}

// ── Send verification email via Supabase ──────────────────────────────────
// We use a simple fetch to send via Resend or just log if no email configured
export async function sendVerificationEmail(email, code, name) {
  // If RESEND_API_KEY is set, send via Resend (free tier: 3000 emails/month)
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'FinançasPro <noreply@financaspro.app>',
        to: [email],
        subject: '🔐 Seu código de verificação — FinançasPro',
        html: `
          <div style="font-family:sans-serif;max-width:400px;margin:0 auto">
            <h2 style="color:#1a1a18">Olá, ${name}!</h2>
            <p>Seu código para vincular o WhatsApp ao FinançasPro:</p>
            <div style="background:#f5f4f0;border-radius:12px;padding:24px;text-align:center;margin:20px 0">
              <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1a1a18">${code}</span>
            </div>
            <p style="color:#6b6b65;font-size:14px">Válido por 10 minutos. Não compartilhe com ninguém.</p>
          </div>
        `,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error:', err);
      throw new Error('Falha ao enviar e-mail');
    }
    return;
  }

  // Fallback: just log (for development)
  console.log(`[EMAIL] Para: ${email} | Código: ${code}`);
}
