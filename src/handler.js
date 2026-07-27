import { processMessage, transcribeAudio } from './ai.js';
import {
  getMonthSummary, getRecentTransactions,
  createEntrada, createDespesa, createInvestimento, markAsPaid,
  getUserConfig, resolveContaByName, resolveCartaoByName,
} from './supabase.js';
import { sendTextMessage, downloadMedia, sendTyping } from './whatsapp.js';

// ── Per-user pending sessions (awaiting conta/cartão selection) ────────────
const pendingSessions = {};

function fmt(v) {
  return `R$${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatMonth(ym) {
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const [y, m] = ym.split('-');
  return `${months[parseInt(m) - 1]} ${y}`;
}

const INV_TIPO_LABELS = {
  reserva: 'Reserva de Emergência', caixinha: 'Caixinha / Poupança',
  renda_fixa: 'Renda Fixa', renda_variavel: 'Renda Variável',
  cripto: 'Cripto', previdencia: 'Previdência', outro: 'Outro',
};
const INV_OP_LABELS = {
  aporte: 'Aporte', saque: 'Saque', rendimento: 'Rendimento', saldo: 'Atualiz. Saldo',
};

// ── Main handler ───────────────────────────────────────────────────────────
export async function handleMessage({ phone, messageType, text, messageKey, senderName, userId }) {
  try {
    await sendTyping(phone, 1500);
    let userText = text;

    // Handle audio
    if (messageType === 'audioMessage' || messageType === 'pttMessage') {
      const audioBuffer = await downloadMedia(messageKey);
      if (audioBuffer) {
        const transcribed = await transcribeAudio(audioBuffer);
        if (transcribed) {
          userText = transcribed;
          await sendTextMessage(phone, `🎙️ _Entendi: "${transcribed}"_`);
          await sendTyping(phone, 1000);
        } else {
          await sendTextMessage(phone, '🎙️ Não consigo transcrever áudio sem a chave do Whisper. Envie em texto por favor.');
          return;
        }
      } else {
        await sendTextMessage(phone, 'Não consegui baixar o áudio. Tente em texto.');
        return;
      }
    }

    if (!userText) return;

    // ── Check if user is responding to a pending conta/cartão question ────
    const pending = pendingSessions[phone];
    if (pending) {
      await handlePendingSelection(phone, userId, senderName, userText, pending);
      return;
    }

    // Load config and summary in parallel
    const [config, summary] = await Promise.all([
      getUserConfig(userId).catch(() => ({ categorias: { entrada: [], despesa: [] }, contas: [], cartoes: [] })),
      getMonthSummary(userId).catch(() => null),
    ]);

    const result = await processMessage(userText, senderName, summary, config);
    await executeAction(result, phone, userId, senderName, config, summary);

  } catch (err) {
    console.error('Handler error:', err);
    await sendTextMessage(phone, '❌ Tive um problema ao processar. Tente novamente em instantes.').catch(() => {});
  }
}

// ── Handle pending conta/cartão selection ──────────────────────────────────
async function handlePendingSelection(phone, userId, senderName, text, pending) {
  const { type, action, config } = pending;
  const input = text.trim().toLowerCase();

  // Allow cancel
  if (input === 'cancelar' || input === 'não' || input === 'nao') {
    delete pendingSessions[phone];
    // Execute without the optional field
    await executeActionDirect(action, phone, userId, senderName, config);
    return;
  }

  if (type === 'conta') {
    const conta = resolveContaByName(text, config.contas);
    if (!conta) {
      // Try by number selection
      const num = parseInt(text);
      const byNum = !isNaN(num) ? config.contas[num - 1] : null;
      if (!byNum) {
        await sendTextMessage(phone, 'Não encontrei essa conta. Tente novamente com o nome ou envie *cancelar* para pular.');
        return;
      }
      action.data.conta_id = byNum.id;
    } else {
      action.data.conta_id = conta.id;
    }
    delete pendingSessions[phone];
    await executeActionDirect(action, phone, userId, senderName, config);

  } else if (type === 'cartao') {
    const cartao = resolveCartaoByName(text, config.cartoes);
    if (!cartao) {
      const num = parseInt(text);
      const byNum = !isNaN(num) ? config.cartoes[num - 1] : null;
      if (!byNum) {
        await sendTextMessage(phone, 'Não encontrei esse cartão. Tente novamente ou envie *cancelar* para salvar sem cartão.');
        return;
      }
      action.data.cartao_id = byNum.id;
    } else {
      action.data.cartao_id = cartao.id;
    }
    delete pendingSessions[phone];
    await executeActionDirect(action, phone, userId, senderName, config);
  }
}

// ── Execute action from Claude ─────────────────────────────────────────────
async function executeAction(result, phone, userId, senderName, config, summary) {
  const { action, data, message } = result;

  // Handle needs_conta flow
  if ((action === 'create_despesa' || action === 'create_entrada') && data.needs_conta && config.contas.length > 1) {
    const contaList = config.contas.map((c, i) => `${i + 1}. ${c.nome}`).join('\n');
    pendingSessions[phone] = { type: 'conta', action: result, config };
    setTimeout(() => { delete pendingSessions[phone]; }, 5 * 60 * 1000);
    await sendTextMessage(phone,
      `${message}\n\nEm qual conta devo registrar?\n${contaList}\n\n_Responda com o nome ou número, ou *cancelar* para pular_`
    );
    return;
  }

  // Handle needs_cartao flow
  if ((action === 'create_despesa') && data.needs_cartao && config.cartoes.length > 0) {
    const cartaoList = config.cartoes.map((c, i) => `${i + 1}. ${c.nome}${c.bandeira ? ' (' + c.bandeira + ')' : ''}`).join('\n');
    pendingSessions[phone] = { type: 'cartao', action: result, config };
    setTimeout(() => { delete pendingSessions[phone]; }, 5 * 60 * 1000);
    await sendTextMessage(phone,
      `${message}\n\nEm qual cartão devo lançar?\n${cartaoList}\n\n_Responda com o nome ou número, ou *cancelar* para salvar sem cartão_`
    );
    return;
  }

  // If only 1 conta and needs_conta, use it automatically
  if ((action === 'create_despesa' || action === 'create_entrada') && data.needs_conta && config.contas.length === 1) {
    data.conta_id = config.contas[0].id;
  }

  await executeActionDirect(result, phone, userId, senderName, config, summary);
}

async function executeActionDirect(result, phone, userId, senderName, config, summary) {
  const { action, data, message } = result;

  switch (action) {

    case 'create_despesa': {
      const item = await createDespesa({
        userId, desc: data.desc, valor: data.valor,
        cat: data.cat || 'Outro', data: data.data || null,
        confirmado: data.confirmado ?? true,
        conta_id: data.conta_id || null,
        cartao_id: data.cartao_id || null,
      });
      const contaNome = data.conta_id ? config.contas.find(c => c.id === data.conta_id)?.nome : null;
      const cartaoNome = data.cartao_id ? config.cartoes.find(c => c.id === data.cartao_id)?.nome : null;
      const status = item.confirmado ? '✅ marcada como paga' : '⏳ pendente';
      await sendTextMessage(phone,
        `${message}\n\n` +
        `💸 *${item.descricao}*\n` +
        `Valor: ${fmt(item.valor)}\n` +
        `Categoria: ${item.cat}\n` +
        (contaNome ? `Conta: ${contaNome}\n` : '') +
        (cartaoNome ? `Cartão: ${cartaoNome}\n` : '') +
        `Data: ${item.data_lancamento}\n` +
        `Status: ${status}`
      );
      break;
    }

    case 'create_entrada': {
      const item = await createEntrada({
        userId, desc: data.desc, valor: data.valor,
        cat: data.cat || 'Outro', data: data.data || null,
        confirmado: data.confirmado ?? true,
        conta_id: data.conta_id || null,
      });
      const contaNome = data.conta_id ? config.contas.find(c => c.id === data.conta_id)?.nome : null;
      const status = item.confirmado ? '✅ marcada como recebida' : '⏳ pendente';
      await sendTextMessage(phone,
        `${message}\n\n` +
        `💰 *${item.descricao}*\n` +
        `Valor: ${fmt(item.valor)}\n` +
        `Categoria: ${item.cat}\n` +
        (contaNome ? `Conta: ${contaNome}\n` : '') +
        `Data: ${item.data_lancamento}\n` +
        `Status: ${status}`
      );
      break;
    }

    case 'create_investimento': {
      const item = await createInvestimento({ userId, tipo: data.tipo || 'outro', op: data.op || 'aporte', valor: data.valor, desc: data.desc || '' });
      await sendTextMessage(phone,
        `${message}\n\n` +
        `📈 *${INV_OP_LABELS[item.op] || item.op} — ${INV_TIPO_LABELS[item.tipo] || item.tipo}*\n` +
        `Valor: ${fmt(item.valor)}\n` +
        `Mês: ${item.mes}`
      );
      break;
    }

    case 'mark_paid': {
      const item = await markAsPaid({ userId, tipo: data.tipo || 'despesa', descSearch: data.desc });
      if (item) {
        const verb = data.tipo === 'entrada' ? 'recebida' : 'paga';
        await sendTextMessage(phone, `${message}\n\n✅ *${item.descricao}* marcada como ${verb}!\nValor: ${fmt(item.valor)}`);
      } else {
        await sendTextMessage(phone, `Não encontrei esse lançamento. Verifique no app ou adicione um novo.`);
      }
      break;
    }

    case 'query': {
      if (!summary) {
        const sum = await getMonthSummary(userId).catch(() => null);
        await handleQuery(data.type, userId, phone, message, senderName, sum, config);
      } else {
        await handleQuery(data.type, userId, phone, message, senderName, summary, config);
      }
      break;
    }

    default:
      await sendTextMessage(phone, message || 'Não entendi. Pode reformular?');
  }
}

async function handleQuery(type, userId, phone, aiMessage, senderName, summary, config) {
  if (!summary) summary = await getMonthSummary(userId);

  switch (type) {
    case 'saldo': {
      const contasInfo = config?.contas?.length
        ? '\n\n💳 *Saldo por conta:*\n' + config.contas.map(c => {
            const saldo = calcSaldoConta(c.id, c.saldo_inicial, summary);
            return `  • ${c.nome}: ${fmt(saldo)}`;
          }).join('\n')
        : '';
      await sendTextMessage(phone,
        `💰 *Saldo disponível em conta*\n*${fmt(summary.saldoDisponivel)}*\n_(acumulado desde o início)_\n\n` +
        `━━━━━━━━━━━━━━\n📅 *${formatMonth(summary.month)}*\n` +
        `✅ Realizado: ${fmt(summary.saldoRealizado)}\n` +
        `📊 Previsto: ${fmt(summary.saldoPrevisto)}\n\n` +
        `📈 Entradas recebidas: ${fmt(summary.entradas.confirmado)}\n` +
        `📉 Despesas pagas: ${fmt(summary.despesas.confirmado)}\n` +
        `💳 Parcelas: ${fmt(summary.cartao.total)}\n\n` +
        `🏦 Total investido: ${fmt(summary.investimentos.total)}\n` +
        `💎 Patrimônio líquido: ${fmt(summary.patrimonioLiquido)}` +
        contasInfo
      );
      break;
    }
    case 'resumo': {
      const pendE = summary.pendingEntradas.length;
      const pendD = summary.pendingDespesas.length;
      await sendTextMessage(phone,
        `📊 *Resumo de ${formatMonth(summary.month)}*\n\n` +
        `💚 Entradas: ${fmt(summary.entradas.confirmado)} recebido de ${fmt(summary.entradas.total)} previsto\n` +
        `❤️ Despesas: ${fmt(summary.despesas.confirmado)} pago de ${fmt(summary.despesas.total)} previsto\n` +
        `💳 Cartão: ${fmt(summary.cartao.total)}\n\n` +
        `✅ Saldo realizado: *${fmt(summary.saldoRealizado)}*\n` +
        `📈 Saldo previsto: ${fmt(summary.saldoPrevisto)}\n` +
        (pendE > 0 ? `\n⏳ ${pendE} entrada(s) a receber` : '') +
        (pendD > 0 ? `\n⏳ ${pendD} despesa(s) a pagar` : '')
      );
      break;
    }
    case 'pendentes': {
      const lines = [];
      if (summary.pendingEntradas.length) {
        lines.push('💚 *A receber:*');
        summary.pendingEntradas.slice(0, 8).forEach(e => lines.push(`  • ${e.desc} — ${fmt(e.valor)}`));
      }
      if (summary.pendingDespesas.length) {
        lines.push('\n❤️ *A pagar:*');
        summary.pendingDespesas.slice(0, 8).forEach(e => lines.push(`  • ${e.desc} — ${fmt(e.valor)}`));
      }
      await sendTextMessage(phone, lines.length
        ? `⏳ *Pendentes de ${formatMonth(summary.month)}*\n\n${lines.join('\n')}`
        : '🎉 Nenhum pendente este mês!'
      );
      break;
    }
    case 'gastos': {
      const recent = await getRecentTransactions(userId, 8);
      if (!recent.despesas.length) { await sendTextMessage(phone, 'Nenhum gasto registrado este mês.'); break; }
      const lines = recent.despesas.map(d => `  ${d.confirmado ? '✅' : '⏳'} ${d.desc} — ${fmt(d.valor)}`);
      await sendTextMessage(phone, `📉 *Últimos gastos*\n\n${lines.join('\n')}\n\nTotal pago: ${fmt(summary.despesas.confirmado)}`);
      break;
    }
    case 'investimentos': {
      const inv = summary.investimentos;
      const lines = Object.entries(inv.porTipo).filter(([, v]) => v > 0).map(([tipo, v]) => `  • ${INV_TIPO_LABELS[tipo]}: ${fmt(v)}`);
      await sendTextMessage(phone, lines.length
        ? `📈 *Investimentos*\n\n${lines.join('\n')}\n\n*Total: ${fmt(inv.total)}*`
        : 'Nenhum investimento registrado ainda.'
      );
      break;
    }
    default:
      await sendTextMessage(phone, aiMessage || 'Posso ajudar com saldo, resumo, pendentes, gastos e investimentos!');
  }
}

// Simple saldo por conta helper for bot
function calcSaldoConta(contaId, saldoInicial) {
  return parseFloat(saldoInicial) || 0; // simplified — full calc needs all transactions
}
