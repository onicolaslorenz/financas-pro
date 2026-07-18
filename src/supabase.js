import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Helpers ────────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function activeMonth() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

// ── READ ───────────────────────────────────────────────────────────────────

// ── Saldo acumulado (replicates frontend getSaldoAcumulado) ────────────────
// Soma todas entradas confirmadas - despesas confirmadas - parcelas vencidas
// desde sempre até o mês atual, independente do mês selecionado
function calcSaldoAcumulado(entradas, despesas, cartao) {
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth() + 1;
  const curIdx = anoAtual * 12 + mesAtual - 1;

  let totalE = 0;
  (entradas || []).forEach(e => {
    if (e.recorrente) {
      const origemYM = (e.data_lancamento || '').slice(0, 7);
      if (!origemYM) return;
      const [oy, om] = origemYM.split('-').map(Number);
      const startIdx = oy * 12 + om - 1;
      for (let idx = startIdx; idx <= curIdx; idx++) {
        const y = Math.floor(idx / 12);
        const m = (idx % 12) + 1;
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        if (e.status_map && e.status_map[ym]) totalE += parseFloat(e.valor);
      }
    } else {
      if (e.confirmado) totalE += parseFloat(e.valor);
    }
  });

  let totalD = 0;
  (despesas || []).forEach(e => {
    if (e.recorrente) {
      const origemYM = (e.data_lancamento || '').slice(0, 7);
      if (!origemYM) return;
      const [oy, om] = origemYM.split('-').map(Number);
      const startIdx = oy * 12 + om - 1;
      for (let idx = startIdx; idx <= curIdx; idx++) {
        const y = Math.floor(idx / 12);
        const m = (idx % 12) + 1;
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        if (e.status_map && e.status_map[ym]) totalD += parseFloat(e.valor);
      }
    } else {
      if (e.confirmado) totalD += parseFloat(e.valor);
    }
  });

  let totalP = 0;
  (cartao || []).forEach(c => {
    const [oy, om] = c.inicio.split('-').map(Number);
    const startIdx = oy * 12 + om - 1;
    const endIdx = startIdx + parseInt(c.parcelas) - 1;
    const lastIdx = Math.min(curIdx, endIdx);
    const qtd = Math.max(0, lastIdx - startIdx + 1);
    totalP += qtd * (c.total / c.parcelas);
  });

  return totalE - totalD - totalP;
}

export async function getMonthSummary(userId, month = null) {
  const ym = month || activeMonth();
  const [y, m] = ym.split('-').map(Number);

  // Fetch all entries (we filter recorrente in memory, same logic as frontend)
  const [{ data: entradas }, { data: despesas }, { data: cartao }, { data: investimentos }] = await Promise.all([
    supabase.from('entradas').select('*').eq('user_id', userId),
    supabase.from('despesas').select('*').eq('user_id', userId),
    supabase.from('cartao').select('*').eq('user_id', userId),
    supabase.from('investimentos').select('*').eq('user_id', userId),
  ]);

  // Filter entradas for the month (same recorrente logic as frontend)
  const monthEntradas = filterItemsForMonth(entradas || [], ym);
  const monthDespesas = filterItemsForMonth(despesas || [], ym);

  // Filter cartao parcelas for month
  const monthParcelas = (cartao || []).filter(c => {
    const [cy, cm] = c.inicio.split('-').map(Number);
    const startIdx = cy * 12 + cm - 1;
    const curIdx = y * 12 + m - 1;
    return curIdx >= startIdx && curIdx < startIdx + parseInt(c.parcelas);
  }).map(c => ({ ...c, _val: c.total / c.parcelas }));

  const totalE = monthEntradas.reduce((s, e) => s + parseFloat(e.valor), 0);
  const totalD = monthDespesas.reduce((s, e) => s + parseFloat(e.valor), 0);
  const totalP = monthParcelas.reduce((s, e) => s + e._val, 0);

  const confirmedE = monthEntradas.filter(e => isConfirmed(e, ym)).reduce((s, e) => s + parseFloat(e.valor), 0);
  const confirmedD = monthDespesas.filter(e => isConfirmed(e, ym)).reduce((s, e) => s + parseFloat(e.valor), 0);

  const pendingEntradas = monthEntradas.filter(e => !isConfirmed(e, ym));
  const pendingDespesas = monthDespesas.filter(e => !isConfirmed(e, ym));

  // Investment summary
  const invTotal = calcInvTotal(investimentos || []);

  // Saldo acumulado (disponível em conta — independente do mês selecionado)
  const saldoDisponivel = calcSaldoAcumulado(entradas, despesas, cartao);

  return {
    month: ym,
    entradas: { total: totalE, confirmado: confirmedE, count: monthEntradas.length, confirmedCount: monthEntradas.filter(e => isConfirmed(e, ym)).length },
    despesas: { total: totalD, confirmado: confirmedD, count: monthDespesas.length, confirmedCount: monthDespesas.filter(e => isConfirmed(e, ym)).length },
    cartao: { total: totalP, count: monthParcelas.length },
    saldoRealizado: confirmedE - confirmedD - totalP,
    saldoPrevisto: totalE - totalD - totalP,
    saldoDisponivel,
    pendingEntradas: pendingEntradas.map(e => ({ desc: e.descricao, valor: e.valor, data: e.data_lancamento })),
    pendingDespesas: pendingDespesas.map(e => ({ desc: e.descricao, valor: e.valor, data: e.data_lancamento })),
    investimentos: invTotal,
    patrimonioLiquido: saldoDisponivel + invTotal.total,
  };
}

function filterItemsForMonth(list, ym) {
  return list.filter(item => {
    const itemDate = item.data_lancamento || '';
    if (item.recorrente) {
      return itemDate.slice(0, 7) <= ym;
    }
    return itemDate.startsWith(ym);
  });
}

function isConfirmed(item, ym) {
  if (item.recorrente) {
    return !!(item.status_map && item.status_map[ym]);
  }
  return !!item.confirmado;
}

function calcInvTotal(investimentos) {
  const tipos = ['reserva', 'caixinha', 'renda_fixa', 'renda_variavel', 'cripto', 'previdencia', 'outro'];
  const porTipo = {};
  tipos.forEach(t => { porTipo[t] = 0; });

  // For each tipo, find last saldo update + flow movements after it
  tipos.forEach(tipo => {
    const movs = investimentos.filter(i => i.tipo === tipo).sort((a, b) => a.mes > b.mes ? 1 : -1);
    let base = 0, baseDate = '';
    movs.forEach(m => {
      if (m.op === 'saldo') { base = parseFloat(m.valor); baseDate = m.mes; }
    });
    movs.forEach(m => {
      if (m.op === 'saldo') return;
      if (m.mes < baseDate) return;
      if (m.op === 'aporte' || m.op === 'rendimento') base += parseFloat(m.valor);
      if (m.op === 'saque') base -= parseFloat(m.valor);
    });
    porTipo[tipo] = Math.max(0, base);
  });

  const total = Object.values(porTipo).reduce((s, v) => s + v, 0);
  return { total, porTipo };
}

export async function getRecentTransactions(userId, limit = 10) {
  const ym = activeMonth();
  const [{ data: entradas }, { data: despesas }] = await Promise.all([
    supabase.from('entradas').select('*').eq('user_id', userId).gte('data_lancamento', `${ym}-01`).order('data_lancamento', { ascending: false }).limit(limit),
    supabase.from('despesas').select('*').eq('user_id', userId).gte('data_lancamento', `${ym}-01`).order('data_lancamento', { ascending: false }).limit(limit),
  ]);
  return {
    entradas: (entradas || []).map(e => ({ desc: e.descricao, valor: e.valor, cat: e.cat, data: e.data_lancamento, confirmado: e.confirmado })),
    despesas: (despesas || []).map(e => ({ desc: e.descricao, valor: e.valor, cat: e.cat, data: e.data_lancamento, confirmado: e.confirmado })),
  };
}

// ── WRITE ──────────────────────────────────────────────────────────────────

export async function createEntrada({ userId, desc, valor, cat = 'Outro', data = null, recorrente = false, confirmado = false }) {
  const row = {
    id: genId(),
    user_id: userId,
    descricao: desc,
    valor: parseFloat(valor),
    data_lancamento: data || todayStr(),
    cat,
    recorrente,
    confirmado,
    status_map: {},
  };
  const { error } = await supabase.from('entradas').insert(row);
  if (error) throw error;
  return row;
}

export async function createDespesa({ userId, desc, valor, cat = 'Outro', data = null, recorrente = false, confirmado = false }) {
  const row = {
    id: genId(),
    user_id: userId,
    descricao: desc,
    valor: parseFloat(valor),
    data_lancamento: data || todayStr(),
    cat,
    recorrente,
    confirmado,
    status_map: {},
  };
  const { error } = await supabase.from('despesas').insert(row);
  if (error) throw error;
  return row;
}

export async function createInvestimento({ userId, tipo, op, valor, desc = '', mes = null }) {
  const row = {
    id: genId(),
    user_id: userId,
    tipo,
    op,
    valor: parseFloat(valor),
    data_lancamento: todayStr(),
    descricao: desc,
    mes: mes || activeMonth(),
    linked_id: null,
  };
  const { error } = await supabase.from('investimentos').insert(row);
  if (error) throw error;
  return row;
}

export async function markAsPaid({ userId, tipo, descSearch }) {
  // Find the most recent matching item and mark as confirmed
  const table = tipo === 'entrada' ? 'entradas' : 'despesas';
  const ym = activeMonth();

  const { data } = await supabase
    .from(table)
    .select('*')
    .eq('user_id', userId)
    .ilike('descricao', `%${descSearch}%`)
    .order('data_lancamento', { ascending: false })
    .limit(5);

  if (!data || !data.length) return null;

  // Find best match in current month or most recent
  const item = data.find(i => (i.data_lancamento || '').startsWith(ym)) || data[0];

  const updateData = item.recorrente
    ? { status_map: { ...(item.status_map || {}), [ym]: true } }
    : { confirmado: true };

  const { error } = await supabase.from(table).update(updateData).eq('id', item.id);
  if (error) throw error;
  return { ...item, ...updateData };
}
