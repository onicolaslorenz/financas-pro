// Run once to migrate existing hardcoded numbers to the DB
// node migrate-numbers.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const USERS = process.env.WHATSAPP_USERS || '';

async function migrate() {
  const entries = USERS.split(',').filter(Boolean);
  for (const entry of entries) {
    const [phone, userId, name] = entry.trim().split(':');
    if (!phone || !userId) continue;
    let p = phone.replace(/\D/g, '');
    if (!p.startsWith('55')) p = '55' + p;

    const { error } = await supabase.from('whatsapp_links').upsert({
      phone: p, user_id: userId, verified: true,
    }, { onConflict: 'phone' });

    if (error) console.error(`Error migrating ${p}:`, error.message);
    else console.log(`✅ Migrated ${name} (${p})`);
  }
  console.log('Done.');
}

migrate();
