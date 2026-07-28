import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayStr() { return new Date().toISOString().split('T')[0]; }
function activeMonth() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

// ── User config ────────────────────────────────────────────────────────────
export async function getUserConfig(userId) {
  const [catRes, contaRes, cartaoRes] = await Promise.all([
    supabase.from('categorias').select('*').eq('user_id', userId).order('ordem'),
    supabase.from('contas').select('*').eq('user_id', userId).eq('ativa', true).order('ordem'),
    supabase.from('cartoes').select('*').eq('user_id', userId).eq('ativo', true).order('ordem'),
  ]);
  return {
    categorias: {
      entrada: (catRes.data || []).filter(c => c.tipo === 'entrada').map(c => c.nome),
      despesa: (catRes.data || []).filter(c => c.tipo === 'despesa').map(c => c.nome),
    },
    contas: (contaRes.data || []).map(c => ({ id: c.id, nome: c.nome })),
    cartoes: (cartaoRes.data || []).map(c => ({ id: c.id, nome: c.nome, bandeira: c.bandeira, dia_fechamento: c.dia_fechamento, dia_vencimento: c.dia_vencimento })),
  };
}

export function resolveContaByName(mention, contas) {
  if (!mention || !contas.length) return null;
  const m = mention.toLowerCase();
  return contas.find(c => c.nome.toLowerCase().includes(m) || m.includes(c.nome.toLowerCase())) || null;
}

export function resolveCartaoByName(mention, cartoes) {
  if (!mention || !cartoes.length) return null;
  const m = mention.toLowerCase();
  return cartoes.find(c => c.nome.toLowerCase().includes(m) || m.includes(c.nome.toLowerCase())) || null;
}

// ── Month summary ──────────────────────────────────────────────────────────
function filterItemsForMonth(list, ym) {
  return list.filter(item => {
    const d = item.data_lancamento || '';
    if (item.recorrente) return d.slice(0, 7) <= ym;
    return d.startsWith(ym);
  });
}
function isConfirmed(item, ym) {
  if (item.recorrente) return !!(item.status_map && item.status_map[ym]);
  return !!item.confirmado;
}
function calcInvTotal(invs) {
  const tipos = ['reserva','caixinha','renda_fixa','renda_variavel','cripto','previdencia','outro'];
  const por = {};
  tipos.forEach(t => { por[t] = 0; });
  tipos.forEach(tipo => {
    const movs = invs.filter(i => i.tipo === tipo).sort((a,b) => a.mes > b.mes ? 1 : -1);
    let base = 0, baseDate = '';
    movs.forEach(m => { if (m.op === 'saldo') { base = parseFloat(m.valor); baseDate = m.mes; } });
    movs.forEach(m => {
      if (m.op === 'saldo') return;
      if (m.mes < baseDate) return;
      if (m.op === 'aporte' || m.op === 'rendimento') base += parseFloat(m.valor);
      if (m.op === 'saque') base -= parseFloat(m.valor);
    });
    por[tipo] = Math.max(0, base);
  });
  return { total: Object.values(por).reduce((s,v) => s+v, 0), porTipo: por };
}
function calcSaldoAcumulado(entradas, despesas, cartao) {
  const hoje = new Date();
  const ano = hoje.getFullYear(), mes = hoje.getMonth() + 1;
  const curIdx = ano * 12 + mes - 1;
  let totalE = 0;
  (entradas||[]).forEach(e => {
    if (e.recorrente) {
      const [oy,om] = (e.data_lancamento||'').slice(0,7).split('-').map(Number);
      if (!oy) return;
      for (let idx = oy*12+om-1; idx <= curIdx; idx++) {
        if (e.repeticoes && (idx-(oy*12+om-1)) >= parseInt(e.repeticoes)) break;
        const ym = `${Math.floor(idx/12)}-${String((idx%12)+1).padStart(2,'0')}`;
        if (e.status_map?.[ym]) totalE += parseFloat(e.valor);
      }
    } else { if (e.confirmado) totalE += parseFloat(e.valor); }
  });
  let totalD = 0;
  (despesas||[]).forEach(e => {
    if (e.recorrente) {
      const [oy,om] = (e.data_lancamento||'').slice(0,7).split('-').map(Number);
      if (!oy) return;
      for (let idx = oy*12+om-1; idx <= curIdx; idx++) {
        if (e.repeticoes && (idx-(oy*12+om-1)) >= parseInt(e.repeticoes)) break;
        const ym = `${Math.floor(idx/12)}-${String((idx%12)+1).padStart(2,'0')}`;
        if (e.status_map?.[ym]) totalD += parseFloat(e.valor);
      }
    } else { if (e.confirmado) totalD += parseFloat(e.valor); }
  });
  let totalP = 0;
  (cartao||[]).forEach(c => {
    const [oy,om] = c.inicio.split('-').map(Number);
    const startIdx = oy*12+om-1;
    const qtd = Math.max(0, Math.min(curIdx, startIdx+parseInt(c.parcelas)-1) - startIdx + 1);
    totalP += qtd * (c.total/c.parcelas);
  });
  return totalE - totalD - totalP;
}

export async function getMonthSummary(userId, month = null) {
  const ym = month || activeMonth();
  const [y, m] = ym.split('-').map(Number);
  const [{ data: entradas }, { data: despesas }, { data: cartao }, { data: invs }] = await Promise.all([
    supabase.from('entradas').select('*').eq('user_id', userId),
    supabase.from('despesas').select('*').eq('user_id', userId),
    supabase.from('cartao').select('*').eq('user_id', userId),
    supabase.from('investimentos').select('*').eq('user_id', userId),
  ]);
  const me = filterItemsForMonth(entradas||[], ym);
  const md = filterItemsForMonth(despesas||[], ym);
  const mp = (cartao||[]).filter(c => {
    const [cy,cm] = c.inicio.split('-').map(Number);
    const s = cy*12+cm-1, cur = y*12+m-1;
    return cur >= s && cur < s+parseInt(c.parcelas);
  }).map(c => ({...c, _val: c.total/c.parcelas}));
  const totalE = me.reduce((s,e)=>s+parseFloat(e.valor),0);
  const totalD = md.reduce((s,e)=>s+parseFloat(e.valor),0);
  const totalP = mp.reduce((s,e)=>s+e._val,0);
  const confE = me.filter(e=>isConfirmed(e,ym)).reduce((s,e)=>s+parseFloat(e.valor),0);
  const confD = md.filter(e=>isConfirmed(e,ym)).reduce((s,e)=>s+parseFloat(e.valor),0);
  const inv = calcInvTotal(invs||[]);
  const saldoDisponivel = calcSaldoAcumulado(entradas, despesas, cartao);
  return {
    month: ym,
    entradas: { total: totalE, confirmado: confE, count: me.length, confirmedCount: me.filter(e=>isConfirmed(e,ym)).length },
    despesas: { total: totalD, confirmado: confD, count: md.length, confirmedCount: md.filter(e=>isConfirmed(e,ym)).length },
    cartao: { total: totalP, count: mp.length },
    saldoRealizado: confE - confD - totalP,
    saldoPrevisto: totalE - totalD - totalP,
    saldoDisponivel,
    pendingEntradas: me.filter(e=>!isConfirmed(e,ym)).map(e=>({desc:e.descricao,valor:e.valor})),
    pendingDespesas: md.filter(e=>!isConfirmed(e,ym)).map(e=>({desc:e.descricao,valor:e.valor})),
    investimentos: inv,
    patrimonioLiquido: saldoDisponivel + inv.total,
  };
}

export async function getRecentTransactions(userId, limit = 8) {
  const ym = activeMonth();
  const [{ data: e }, { data: d }] = await Promise.all([
    supabase.from('entradas').select('*').eq('user_id', userId).gte('data_lancamento', `${ym}-01`).order('data_lancamento', { ascending: false }).limit(limit),
    supabase.from('despesas').select('*').eq('user_id', userId).gte('data_lancamento', `${ym}-01`).order('data_lancamento', { ascending: false }).limit(limit),
  ]);
  return {
    entradas: (e||[]).map(x=>({ desc: x.descricao, valor: x.valor, cat: x.cat, data: x.data_lancamento, confirmado: x.confirmado })),
    despesas: (d||[]).map(x=>({ desc: x.descricao, valor: x.valor, cat: x.cat, data: x.data_lancamento, confirmado: x.confirmado })),
  };
}

// ── Write ──────────────────────────────────────────────────────────────────
export async function createEntrada({ userId, desc, valor, cat='Outro', data=null, recorrente=false, confirmado=false, conta_id=null }) {
  const row = { id: genId(), user_id: userId, descricao: desc, valor: parseFloat(valor), data_lancamento: data||todayStr(), cat, recorrente, confirmado, status_map: {}, conta_id: conta_id||null };
  const { error } = await supabase.from('entradas').insert(row);
  if (error) throw error;
  return row;
}

export async function createDespesa({ userId, desc, valor, cat='Outro', data=null, recorrente=false, confirmado=false, conta_id=null, cartao_id=null }) {
  const row = { id: genId(), user_id: userId, descricao: desc, valor: parseFloat(valor), data_lancamento: data||todayStr(), cat, recorrente, confirmado, status_map: {}, conta_id: conta_id||null, cartao_id: cartao_id||null };
  const { error } = await supabase.from('despesas').insert(row);
  if (error) throw error;
  return row;
}

export async function createInvestimento({ userId, tipo, op, valor, desc='', mes=null }) {
  const row = { id: genId(), user_id: userId, tipo, op, valor: parseFloat(valor), data_lancamento: todayStr(), descricao: desc, mes: mes||activeMonth(), linked_id: null };
  const { error } = await supabase.from('investimentos').insert(row);
  if (error) throw error;
  return row;
}

export async function markAsPaid({ userId, tipo, descSearch }) {
  const table = tipo === 'entrada' ? 'entradas' : 'despesas';
  const ym = activeMonth();
  const { data } = await supabase.from(table).select('*').eq('user_id', userId).ilike('descricao', `%${descSearch}%`).order('data_lancamento', { ascending: false }).limit(5);
  if (!data?.length) return null;
  const item = data.find(i => (i.data_lancamento||'').startsWith(ym)) || data[0];
  const update = item.recorrente ? { status_map: { ...(item.status_map||{}), [ym]: true } } : { confirmado: true };
  await supabase.from(table).update(update).eq('id', item.id);
  return { ...item, ...update };
}
