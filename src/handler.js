import { processMessage, transcribeAudio } from './ai.js';
import { getMonthSummary, getRecentTransactions, createEntrada, createDespesa, createInvestimento, markAsPaid, getUserConfig, resolveContaByName, resolveCartaoByName } from './supabase.js';
import { sendTextMessage, sendTyping } from './whatsapp.js';

const INV_TIPOS = { reserva:'Reserva de Emergência', caixinha:'Caixinha/Poupança', renda_fixa:'Renda Fixa', renda_variavel:'Renda Variável', cripto:'Cripto', previdencia:'Previdência', outro:'Outro' };
const INV_OPS   = { aporte:'Aporte', saque:'Saque', rendimento:'Rendimento', saldo:'Atualiz. Saldo' };

function fmt(v) { return `R$${Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}`; }
function fmtMonth(ym) {
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const [y,m] = ym.split('-');
  return `${months[parseInt(m)-1]} ${y}`;
}

// ── Pending sessions (awaiting conta/cartão choice) ────────────────────────
const pending = {};

export async function handleMessage({ phone, messageType, text, audioBuffer, messageKey, senderName, userId }) {
  try {
    await sendTyping(phone, 1000);
    let userText = text;

    // Handle audio
    if (audioBuffer || messageType === 'audioMessage') {
      if (audioBuffer) {
        const transcribed = await transcribeAudio(audioBuffer);
        if (transcribed) {
          userText = transcribed;
          await sendTextMessage(phone, `🎙️ _Entendi: "${transcribed}"_`);
        } else {
          await sendTextMessage(phone, '🎙️ Não consigo transcrever áudio. Envie em texto.');
          return;
        }
      }
    }
    if (!userText) return;

    // Check pending selection
    if (pending[phone]) {
      await handlePending(phone, userId, senderName, userText);
      return;
    }

    // Load config + summary in parallel
    const [config, summary] = await Promise.all([
      getUserConfig(userId).catch(() => ({ categorias:{entrada:[],despesa:[]}, contas:[], cartoes:[] })),
      getMonthSummary(userId).catch(() => null),
    ]);

    const result = await processMessage(userText, senderName, summary, config);
    await executeAction(result, phone, userId, senderName, config, summary);

  } catch(err) {
    console.error('Handler error:', err);
    await sendTextMessage(phone, '❌ Erro ao processar. Tente novamente.').catch(()=>{});
  }
}

async function handlePending(phone, userId, senderName, text) {
  const sess = pending[phone];
  const { type, action, config } = sess;
  const input = text.trim().toLowerCase();

  if (input === 'cancelar' || input === 'nao' || input === 'não') {
    delete pending[phone];
    await executeActionDirect(action, phone, userId, senderName, config);
    return;
  }

  if (type === 'conta') {
    const num = parseInt(text);
    const conta = resolveContaByName(text, config.contas) || (!isNaN(num) ? config.contas[num-1] : null);
    if (!conta) { await sendTextMessage(phone, 'Conta não encontrada. Tente o nome ou número da lista, ou *cancelar*.'); return; }
    action.data.conta_id = conta.id;
  } else if (type === 'cartao') {
    const num = parseInt(text);
    const cartao = resolveCartaoByName(text, config.cartoes) || (!isNaN(num) ? config.cartoes[num-1] : null);
    if (!cartao) { await sendTextMessage(phone, 'Cartão não encontrado. Tente o nome ou número da lista, ou *cancelar*.'); return; }
    action.data.cartao_id = cartao.id;
  }

  delete pending[phone];
  await executeActionDirect(action, phone, userId, senderName, config);
}

async function executeAction(result, phone, userId, senderName, config, summary) {
  const { action, data } = result;

  // needs_conta: ask if more than 1 conta
  if ((action === 'create_entrada' || action === 'create_despesa') && data.needs_conta && config.contas.length > 1) {
    const list = config.contas.map((c,i) => `${i+1}. ${c.nome}`).join('\n');
    pending[phone] = { type: 'conta', action: result, config };
    setTimeout(() => { delete pending[phone]; }, 5 * 60 * 1000);
    await sendTextMessage(phone, `${result.message}\n\nEm qual conta?\n${list}\n\n_Nome, número ou *cancelar*_`);
    return;
  }
  // Auto-select if only 1 conta
  if ((action === 'create_entrada' || action === 'create_despesa') && data.needs_conta && config.contas.length === 1) {
    data.conta_id = config.contas[0].id;
  }

  // needs_cartao: always ask
  if (action === 'create_despesa' && data.needs_cartao && config.cartoes.length > 0) {
    const list = config.cartoes.map((c,i) => `${i+1}. ${c.nome}${c.bandeira?' ('+c.bandeira+')':''}`).join('\n');
    pending[phone] = { type: 'cartao', action: result, config };
    setTimeout(() => { delete pending[phone]; }, 5 * 60 * 1000);
    await sendTextMessage(phone, `${result.message}\n\nEm qual cartão?\n${list}\n\n_Nome, número ou *cancelar*_`);
    return;
  }

  await executeActionDirect(result, phone, userId, senderName, config, summary);
}

async function executeActionDirect(result, phone, userId, senderName, config, summary) {
  const { action, data, message } = result;

  switch(action) {
    case 'create_despesa': {
      const item = await createDespesa({ userId, desc:data.desc, valor:data.valor, cat:data.cat||'Outro', data:data.data||null, confirmado:data.confirmado??true, conta_id:data.conta_id||null, cartao_id:data.cartao_id||null });
      const contaNome = data.conta_id ? config?.contas?.find(c=>c.id===data.conta_id)?.nome : null;
      const cartaoNome = data.cartao_id ? config?.cartoes?.find(c=>c.id===data.cartao_id)?.nome : null;
      await sendTextMessage(phone,
        `${message}\n\n💸 *${item.descricao}*\nValor: ${fmt(item.valor)}\nCategoria: ${item.cat}` +
        (contaNome ? `\nConta: ${contaNome}` : '') +
        (cartaoNome ? `\nCartão: ${cartaoNome}` : '') +
        `\nStatus: ${item.confirmado ? '✅ pago' : '⏳ pendente'}`
      );
      break;
    }
    case 'create_entrada': {
      const item = await createEntrada({ userId, desc:data.desc, valor:data.valor, cat:data.cat||'Outro', data:data.data||null, confirmado:data.confirmado??true, conta_id:data.conta_id||null });
      const contaNome = data.conta_id ? config?.contas?.find(c=>c.id===data.conta_id)?.nome : null;
      await sendTextMessage(phone,
        `${message}\n\n💰 *${item.descricao}*\nValor: ${fmt(item.valor)}\nCategoria: ${item.cat}` +
        (contaNome ? `\nConta: ${contaNome}` : '') +
        `\nStatus: ${item.confirmado ? '✅ recebido' : '⏳ pendente'}`
      );
      break;
    }
    case 'create_investimento': {
      const item = await createInvestimento({ userId, tipo:data.tipo||'outro', op:data.op||'aporte', valor:data.valor, desc:data.desc||'' });
      await sendTextMessage(phone, `${message}\n\n📈 *${INV_OPS[item.op]||item.op} — ${INV_TIPOS[item.tipo]||item.tipo}*\nValor: ${fmt(item.valor)}\nMês: ${item.mes}`);
      break;
    }
    case 'mark_paid': {
      const item = await markAsPaid({ userId, tipo:data.tipo||'despesa', descSearch:data.desc });
      if (item) await sendTextMessage(phone, `${message}\n\n✅ *${item.descricao}* marcada como ${data.tipo==='entrada'?'recebida':'paga'}!\nValor: ${fmt(item.valor)}`);
      else await sendTextMessage(phone, 'Não encontrei esse lançamento. Verifique no app.');
      break;
    }
    case 'query': {
      const sum = summary || await getMonthSummary(userId).catch(()=>null);
      await handleQuery(data.type, userId, phone, message, sum, config);
      break;
    }
    default:
      await sendTextMessage(phone, message || 'Não entendi. Pode reformular?');
  }
}

async function handleQuery(type, userId, phone, aiMessage, summary, config) {
  if (!summary) summary = await getMonthSummary(userId);

  switch(type) {
    case 'saldo': {
      const contasInfo = config?.contas?.length
        ? '\n\n💳 *Por conta:*\n' + config.contas.map(c => `  • ${c.nome}: ${fmt(getContaSaldo(c.id, config, summary))}`).join('\n')
        : '';
      await sendTextMessage(phone,
        `💰 *Saldo disponível*\n*${fmt(summary.saldoDisponivel)}*\n_(acumulado)_\n\n` +
        `📅 *${fmtMonth(summary.month)}*\n` +
        `✅ Realizado: ${fmt(summary.saldoRealizado)}\n` +
        `📊 Previsto: ${fmt(summary.saldoPrevisto)}\n\n` +
        `📈 Recebido: ${fmt(summary.entradas.confirmado)}\n` +
        `📉 Pago: ${fmt(summary.despesas.confirmado)}\n` +
        `💳 Parcelas: ${fmt(summary.cartao.total)}\n\n` +
        `🏦 Investido: ${fmt(summary.investimentos.total)}\n` +
        `💎 Patrimônio: ${fmt(summary.patrimonioLiquido)}` +
        contasInfo
      );
      break;
    }
    case 'resumo': {
      await sendTextMessage(phone,
        `📊 *Resumo ${fmtMonth(summary.month)}*\n\n` +
        `💚 Entradas: ${fmt(summary.entradas.confirmado)} de ${fmt(summary.entradas.total)}\n` +
        `❤️ Despesas: ${fmt(summary.despesas.confirmado)} de ${fmt(summary.despesas.total)}\n` +
        `💳 Cartão: ${fmt(summary.cartao.total)}\n\n` +
        `✅ Saldo realizado: *${fmt(summary.saldoRealizado)}*\n` +
        `📈 Saldo previsto: ${fmt(summary.saldoPrevisto)}` +
        (summary.pendingEntradas.length ? `\n\n⏳ ${summary.pendingEntradas.length} entrada(s) a receber` : '') +
        (summary.pendingDespesas.length ? `\n⏳ ${summary.pendingDespesas.length} despesa(s) a pagar` : '')
      );
      break;
    }
    case 'pendentes': {
      const lines = [];
      if (summary.pendingEntradas.length) { lines.push('💚 *A receber:*'); summary.pendingEntradas.slice(0,8).forEach(e=>lines.push(`  • ${e.desc} — ${fmt(e.valor)}`)); }
      if (summary.pendingDespesas.length) { lines.push('\n❤️ *A pagar:*'); summary.pendingDespesas.slice(0,8).forEach(e=>lines.push(`  • ${e.desc} — ${fmt(e.valor)}`)); }
      await sendTextMessage(phone, lines.length ? `⏳ *Pendentes ${fmtMonth(summary.month)}*\n\n${lines.join('\n')}` : '🎉 Nenhum pendente este mês!');
      break;
    }
    case 'gastos': {
      const recent = await getRecentTransactions(userId, 8);
      if (!recent.despesas.length) { await sendTextMessage(phone, 'Nenhum gasto registrado este mês.'); break; }
      const lines = recent.despesas.map(d=>`  ${d.confirmado?'✅':'⏳'} ${d.desc} — ${fmt(d.valor)}`);
      await sendTextMessage(phone, `📉 *Últimos gastos*\n\n${lines.join('\n')}\n\nTotal pago: ${fmt(summary.despesas.confirmado)}`);
      break;
    }
    case 'investimentos': {
      const inv = summary.investimentos;
      const lines = Object.entries(inv.porTipo).filter(([,v])=>v>0).map(([tipo,v])=>`  • ${INV_TIPOS[tipo]}: ${fmt(v)}`);
      await sendTextMessage(phone, lines.length ? `📈 *Investimentos*\n\n${lines.join('\n')}\n\n*Total: ${fmt(inv.total)}*` : 'Nenhum investimento registrado.');
      break;
    }
    default:
      await sendTextMessage(phone, aiMessage || 'Posso ajudar com saldo, resumo, pendentes, gastos e investimentos!');
  }
}

function getContaSaldo(contaId, config, summary) {
  // Simplified — returns 0 as we don't have per-conta breakdown in summary
  return 0;
}
