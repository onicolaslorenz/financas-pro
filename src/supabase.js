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
    // Transferências entre contas não são receita nem gasto real.
    // Dupla checagem: pelo vínculo e pela categoria (protege lançamentos
    // antigos que possam ter ficado sem transferencia_id gravado).
    if (item.transferencia_id || item.cat === 'Transferência') return false;
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
// Saldo de UMA conta — espelha calcSaldoConta() do app:
// saldo_inicial + entradas confirmadas - despesas confirmadas vinculadas à conta
// (transferências ENTRAM aqui: é exatamente elas que movem dinheiro entre contas)
function calcSaldoConta(contaId, saldoInicial, entradas, despesas) {
  const ini = parseFloat(saldoInicial) || 0;

  // Espelha calcSaldoConta() do app: não-recorrente conta uma vez se
  // .confirmado; recorrente conta CADA mês marcado em status_map.
  // Percorremos as chaves do status_map em vez de iterar até "hoje", para
  // que meses futuros já marcados (ex: parcela de agosto) também contem.
  const somaConfirmado = (item) => {
    if (!item.recorrente) return item.confirmado ? parseFloat(item.valor) : 0;
    if (!item.status_map) return 0;
    let total = 0;
    for (const ym in item.status_map) {
      if (item.status_map[ym]) total += parseFloat(item.valor);
    }
    return total;
  };

  const somaE = (entradas || []).filter(x => x.conta_id === contaId).reduce((s, x) => s + somaConfirmado(x), 0);
  const somaD = (despesas || []).filter(x => x.conta_id === contaId).reduce((s, x) => s + somaConfirmado(x), 0);
  return ini + somaE - somaD;
}

function calcSaldoAcumulado(entradas, despesas, cartao) {
  const hoje = new Date();
  const ano = hoje.getFullYear(), mes = hoje.getMonth() + 1;
  const curIdx = ano * 12 + mes - 1;
  let totalE = 0;
  (entradas||[]).forEach(e => {
    if (e.recorrente) {
      if (!e.status_map) return;
      for (const ym in e.status_map) {
        if (e.status_map[ym]) totalE += parseFloat(e.valor);
      }
    } else { if (e.confirmado) totalE += parseFloat(e.valor); }
  });
  let totalD = 0;
  (despesas||[]).forEach(e => {
    if (e.recorrente) {
      if (!e.status_map) return;
      for (const ym in e.status_map) {
        if (e.status_map[ym]) totalD += parseFloat(e.valor);
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
  const [{ data: entradas }, { data: despesas }, { data: cartao }, { data: invs }, { data: contas }] = await Promise.all([
    supabase.from('entradas').select('*').eq('user_id', userId),
    supabase.from('despesas').select('*').eq('user_id', userId),
    supabase.from('cartao').select('*').eq('user_id', userId),
    supabase.from('investimentos').select('*').eq('user_id', userId),
    supabase.from('contas').select('*').eq('user_id', userId).eq('ativa', true).order('ordem'),
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
  // Saldo por conta + saldo disponível — mesma regra do app:
  // com contas cadastradas, o disponível é a SOMA dos saldos das contas
  // (inclui saldo_inicial). Sem contas, cai no cálculo acumulado histórico.
  const contasSaldo = (contas || []).map(ct => ({
    id: ct.id,
    nome: ct.nome,
    saldo: calcSaldoConta(ct.id, ct.saldo_inicial, entradas, despesas),
  }));
  const saldoDisponivel = contasSaldo.length
    ? contasSaldo.reduce((s, ct) => s + ct.saldo, 0)
    : calcSaldoAcumulado(entradas, despesas, cartao);
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
    contasSaldo,
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

// ── Transferência entre contas ─────────────────────────────────────────────
export async function createTransferencia({ userId, contaOrigemId, contaDestinoId, valor, desc, data = null, contas = [] }) {
  const trId = genId();
  const dataFinal = data || todayStr();
  const nomeOri = contas.find(c => c.id === contaOrigemId)?.nome || 'origem';
  const nomeDes = contas.find(c => c.id === contaDestinoId)?.nome || 'destino';
  const descBase = desc || 'Transferência entre contas';
  const descCompleta = `${descBase} (${nomeOri} → ${nomeDes})`;

  const { error: errTr } = await supabase.from('transferencias').insert({
    id: trId, user_id: userId,
    conta_origem_id: contaOrigemId, conta_destino_id: contaDestinoId,
    valor: parseFloat(valor), descricao: descBase, data_lancamento: dataFinal,
  });
  if (errTr) throw errTr;

  const base = {
    descricao: descCompleta, valor: parseFloat(valor), data_lancamento: dataFinal,
    cat: 'Transferência', recorrente: false, confirmado: true,
    status_map: {}, transferencia_id: trId, user_id: userId,
  };

  await supabase.from('despesas').insert({ ...base, id: genId(), conta_id: contaOrigemId });
  await supabase.from('entradas').insert({ ...base, id: genId(), conta_id: contaDestinoId });

  return { id: trId, valor: parseFloat(valor), desc: descBase, data: dataFinal, nomeOri, nomeDes };
}

// ── Busca e remoção ────────────────────────────────────────────────────────

// Procura lançamentos que combinem com o que o usuário descreveu.
// Retorna vários candidatos para o bot poder perguntar qual é o certo.
export async function searchLancamentos({ userId, termo = '', valor = null, tipo = null, limit = 8 }) {
  const alvos = tipo ? [tipo] : ['despesa', 'entrada', 'investimento', 'cartao'];
  const achados = [];

  if (alvos.includes('despesa') || alvos.includes('entrada')) {
    for (const t of ['despesa', 'entrada']) {
      if (!alvos.includes(t)) continue;
      const table = t === 'entrada' ? 'entradas' : 'despesas';
      let q = supabase.from(table).select('*').eq('user_id', userId);
      if (termo) q = q.ilike('descricao', `%${termo}%`);
      if (valor != null) q = q.eq('valor', valor);
      const { data } = await q.order('data_lancamento', { ascending: false }).limit(limit);
      (data || []).forEach(r => achados.push({
        tipo: t, id: r.id, desc: r.descricao, valor: r.valor,
        data: r.data_lancamento, cat: r.cat, conta_id: r.conta_id,
      }));
    }
  }

  if (alvos.includes('cartao')) {
    let q = supabase.from('cartao').select('*').eq('user_id', userId);
    if (termo) q = q.ilike('descricao', `%${termo}%`);
    const { data } = await q.order('created_at', { ascending: false }).limit(limit);
    (data || []).forEach(r => {
      if (valor != null && parseFloat(r.total) !== parseFloat(valor)) return;
      achados.push({
        tipo: 'cartao', id: r.id, desc: r.descricao, valor: r.total,
        data: r.inicio, parcelas: r.parcelas,
      });
    });
  }

  if (alvos.includes('investimento')) {
    let q = supabase.from('investimentos').select('*').eq('user_id', userId);
    if (termo) q = q.ilike('descricao', `%${termo}%`);
    if (valor != null) q = q.eq('valor', valor);
    const { data } = await q.order('data_lancamento', { ascending: false }).limit(limit);
    (data || []).forEach(r => achados.push({
      tipo: 'investimento', id: r.id, desc: r.descricao || `${r.op} ${r.tipo}`,
      valor: r.valor, data: r.data_lancamento, op: r.op, invTipo: r.tipo,
    }));
  }

  return achados.slice(0, limit);
}

// Remove um item. Transferência e parcelamento removem o conjunto inteiro.
export async function deleteLancamento({ userId, tipo, id }) {
  const tabelas = { entrada: 'entradas', despesa: 'despesas', cartao: 'cartao', investimento: 'investimentos' };
  const table = tabelas[tipo];
  if (!table) throw new Error('Tipo inválido: ' + tipo);

  // Se for parte de uma transferência, apaga os dois lados + o registro
  if (tipo === 'entrada' || tipo === 'despesa') {
    const { data: row } = await supabase.from(table).select('*').eq('id', id).eq('user_id', userId).maybeSingle();
    if (!row) return { ok: false, reason: 'Lançamento não encontrado.' };

    if (row.transferencia_id) {
      const trId = row.transferencia_id;
      await supabase.from('entradas').delete().eq('transferencia_id', trId).eq('user_id', userId);
      await supabase.from('despesas').delete().eq('transferencia_id', trId).eq('user_id', userId);
      await supabase.from('transferencias').delete().eq('id', trId).eq('user_id', userId);
      return { ok: true, removido: row.descricao, eraTransferencia: true };
    }

    // Investimento vinculado: remove o movimento junto
    const { data: inv } = await supabase.from('investimentos').select('id').eq('linked_id', id).eq('user_id', userId);
    if (inv && inv.length) {
      for (const i of inv) await supabase.from('investimentos').delete().eq('id', i.id).eq('user_id', userId);
    }

    const { error } = await supabase.from(table).delete().eq('id', id).eq('user_id', userId);
    if (error) throw error;
    return { ok: true, removido: row.descricao };
  }

  const { data: row } = await supabase.from(table).select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (!row) return { ok: false, reason: 'Item não encontrado.' };

  // Investimento com lançamento vinculado: remove o lançamento junto
  if (tipo === 'investimento' && row.linked_id) {
    await supabase.from('despesas').delete().eq('id', row.linked_id).eq('user_id', userId);
    await supabase.from('entradas').delete().eq('id', row.linked_id).eq('user_id', userId);
  }

  const { error } = await supabase.from(table).delete().eq('id', id).eq('user_id', userId);
  if (error) throw error;
  return { ok: true, removido: row.descricao || row.desc || 'item', parcelas: row.parcelas };
}
