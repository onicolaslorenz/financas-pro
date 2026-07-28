import { processMessage, transcribeAudio } from './ai.js';
import {
  getMonthSummary, getRecentTransactions,
  createEntrada, createDespesa, createInvestimento, markAsPaid,
} from './supabase.js';
import { sendTextMessage, sendTyping } from './whatsapp.js';

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

export async function handleMessage({ phone, messageType, text, audioBuffer, messageKey, senderName, userId }) {
  try {
    await sendTyping(phone, 1500);
    let userText = text;

    if (audioBuffer || messageType === 'audioMessage' || messageType === 'pttMessage') {
      const buffer = audioBuffer;
      if (buffer) {
        const transcribed = await transcribeAudio(buffer);
        if (transcribed) {
          userText = transcribed;
          await sendTextMessage(phone, `🎙️ _Entendi: "${transcribed}"_`);
          await sendTyping(phone, 1000);
        } else {
          await sendTextMessage(phone, '🎙️ Não consigo transcrever áudio. Envie em texto por favor.');
          return;
        }
      } else {
        await sendTextMessage(phone, 'Não consegui processar o áudio. Tente em texto.');
        return;
      }
    }

    if (!userText) return;

    const summary = await getMonthSummary(userId).catch(() => null);
    const result = await processMessage(userText, senderName, summary);
    await executeAction(result, phone, userId, senderName, summary);

  } catch (err) {
    console.error('Handler error:', err);
    await sendTextMessage(phone, '❌ Tive um problema ao processar. Tente novamente.').catch(() => {});
  }
}

async function executeAction(result, phone, userId, senderName, summary) {
  const { action, data, message } = result;

  switch (action) {
    case 'create_despesa': {
      const item = await createDespesa({
        userId, desc: data.desc, valor: data.valor,
        cat: data.cat || 'Outro', data: data.data || null,
        confirmado: data.confirmado ?? true,
      });
      const status = item.confirmado ? '✅ marcada como paga' : '⏳ pendente';
      await sendTextMessage(phone,
        `${message}\n\n💸 *${item.descricao}*\nValor: ${fmt(item.valor)}\nCategoria: ${item.cat}\nData: ${item.data_lancamento}\nStatus: ${status}`
      );
      break;
    }
    case 'create_entrada': {
      const item = await createEntrada({
        userId, desc: data.desc, valor: data.valor,
        cat: data.cat || 'Outro', data: data.data || null,
        confirmado: data.confirmado ?? true,
      });
      const status = item.confirmado ? '✅ marcada como recebida' : '⏳ pendente';
      await sendTextMessage(phone,
        `${message}\n\n💰 *${item.descricao}*\nValor: ${fmt(item.valor)}\nCategoria: ${item.cat}\nData: ${item.data_lancamento}\nStatus: ${status}`
      );
      break;
    }
    case 'create_investimento': {
      const item = await createInvestimento({
        userId, tipo: data.tipo || 'outro', op: data.op || 'aporte',
        valor: data.valor, desc: data.desc || '',
      });
      await sendTextMessage(phone,
        `${message}\n\n📈 *${INV_OP_LABELS[item.op] || item.op} — ${INV_TIPO_LABELS[item.tipo] || item.tipo}*\nValor: ${fmt(item.valor)}\nMês: ${item.mes}`
      );
      break;
    }
    case 'mark_paid': {
      const item = await markAsPaid({ userId, tipo: data.tipo || 'despesa', descSearch: data.desc });
      if (item) {
        const verb = data.tipo === 'entrada' ? 'recebida' : 'paga';
        await sendTextMessage(phone, `${message}\n\n✅ *${item.descricao}* marcada como ${verb}!\nValor: ${fmt(item.valor)}`);
      } else {
        await sendTextMessage(phone, `Não encontrei esse lançamento. Verifique no app.`);
      }
      break;
    }
    case 'query': {
      if (!summary) {
        const sum = await getMonthSummary(userId).catch(() => null);
        await handleQuery(data.type, userId, phone, message, senderName, sum);
      } else {
        await handleQuery(data.type, userId, phone, message, senderName, summary);
      }
      break;
    }
    default:
      await sendTextMessage(phone, message || 'Não entendi. Pode reformular?');
  }
}

async function handleQuery(type, userId, phone, aiMessage, senderName, summary) {
  if (!summary) summary = await getMonthSummary(userId);

  switch (type) {
    case 'saldo': {
      await sendTextMessage(phone,
        `💰 *Saldo disponível em conta*\n*${fmt(summary.saldoDisponivel)}*\n_(acumulado desde o início)_\n\n` +
        `━━━━━━━━━━━━━━\n📅 *${formatMonth(summary.month)}*\n` +
        `✅ Realizado: ${fmt(summary.saldoRealizado)}\n` +
        `📊 Previsto: ${fmt(summary.saldoPrevisto)}\n\n` +
        `📈 Entradas recebidas: ${fmt(summary.entradas.confirmado)}\n` +
        `📉 Despesas pagas: ${fmt(summary.despesas.confirmado)}\n` +
        `💳 Parcelas: ${fmt(summary.cartao.total)}\n\n` +
        `🏦 Total investido: ${fmt(summary.investimentos.total)}\n` +
        `💎 Patrimônio líquido: ${fmt(summary.patrimonioLiquido)}`
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
