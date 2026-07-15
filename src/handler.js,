import { processMessage, transcribeAudio } from './ai.js';
import {
  getMonthSummary, getRecentTransactions,
  createEntrada, createDespesa, createInvestimento, markAsPaid
} from './supabase.js';
import { sendTextMessage, downloadMedia, sendTyping } from './whatsapp.js';

const INV_TIPO_LABELS = {
  reserva: 'Reserva de Emergência',
  caixinha: 'Caixinha / Poupança',
  renda_fixa: 'Renda Fixa',
  renda_variavel: 'Renda Variável',
  cripto: 'Cripto',
  previdencia: 'Previdência',
  outro: 'Outro',
};

const INV_OP_LABELS = {
  aporte: 'Aporte',
  saque: 'Saque',
  rendimento: 'Rendimento',
  saldo: 'Atualização de saldo',
};

function fmt(v) {
  return `R$${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function handleMessage({ phone, messageType, text, messageKey, senderName, userId }) {
  try {
    // Show typing indicator
    await sendTyping(phone, 1500);

    let userText = text;

    // Handle audio messages
    if (messageType === 'audioMessage' || messageType === 'pttMessage') {
      const audioBuffer = await downloadMedia(messageKey);
      if (audioBuffer) {
        const transcribed = await transcribeAudio(audioBuffer);
        if (transcribed) {
          userText = transcribed;
          await sendTextMessage(phone, `🎙️ _Entendi: "${transcribed}"_`);
          await sendTyping(phone, 1000);
        } else {
          await sendTextMessage(phone,
            '🎙️ Recebi seu áudio, mas não consigo transcrever sem a chave do Whisper.\n' +
            'Por favor, envie sua mensagem em texto por enquanto.'
          );
          return;
        }
      } else {
        await sendTextMessage(phone, 'Não consegui baixar o áudio. Tente enviar em texto.');
        return;
      }
    }

    if (!userText) return;

    // Load financial context for Claude
    const summary = await getMonthSummary(userId).catch(() => null);

    // Process with Claude
    const result = await processMessage(userText, senderName, summary);

    // Execute action
    await executeAction(result, phone, userId, senderName);

  } catch (err) {
    console.error('Handler error:', err);
    await sendTextMessage(phone,
      '❌ Ops, tive um problema ao processar sua mensagem. Tente novamente em instantes.'
    ).catch(() => {});
  }
}

async function executeAction(result, phone, userId, senderName) {
  const { action, data, message } = result;

  switch (action) {

    case 'create_despesa': {
      const item = await createDespesa({
        userId,
        desc: data.desc,
        valor: data.valor,
        cat: data.cat || 'Outro',
        data: data.data || null,
        confirmado: data.confirmado ?? true,
      });
      const status = item.confirmado ? '✅ marcada como paga' : '⏳ marcada como pendente';
      await sendTextMessage(phone,
        `${message}\n\n` +
        `💸 *${item.descricao}*\n` +
        `Valor: ${fmt(item.valor)}\n` +
        `Categoria: ${item.cat}\n` +
        `Data: ${item.data_lancamento}\n` +
        `Status: ${status}`
      );
      break;
    }

    case 'create_entrada': {
      const item = await createEntrada({
        userId,
        desc: data.desc,
        valor: data.valor,
        cat: data.cat || 'Outro',
        data: data.data || null,
        confirmado: data.confirmado ?? true,
      });
      const status = item.confirmado ? '✅ marcada como recebida' : '⏳ marcada como pendente';
      await sendTextMessage(phone,
        `${message}\n\n` +
        `💰 *${item.descricao}*\n` +
        `Valor: ${fmt(item.valor)}\n` +
        `Categoria: ${item.cat}\n` +
        `Data: ${item.data_lancamento}\n` +
        `Status: ${status}`
      );
      break;
    }

    case 'create_investimento': {
      const item = await createInvestimento({
        userId,
        tipo: data.tipo || 'outro',
        op: data.op || 'aporte',
        valor: data.valor,
        desc: data.desc || '',
      });
      const tipoLabel = INV_TIPO_LABELS[item.tipo] || item.tipo;
      const opLabel = INV_OP_LABELS[item.op] || item.op;
      await sendTextMessage(phone,
        `${message}\n\n` +
        `📈 *${opLabel} — ${tipoLabel}*\n` +
        `Valor: ${fmt(item.valor)}\n` +
        `Mês: ${item.mes}`
      );
      break;
    }

    case 'mark_paid': {
      const item = await markAsPaid({
        userId,
        tipo: data.tipo || 'despesa',
        descSearch: data.desc,
      });
      if (item) {
        const verb = data.tipo === 'entrada' ? 'recebida' : 'paga';
        await sendTextMessage(phone,
          `${message}\n\n` +
          `✅ *${item.descricao}* marcada como ${verb}!\n` +
          `Valor: ${fmt(item.valor)}`
        );
      } else {
        await sendTextMessage(phone,
          `Não encontrei nenhum lançamento com esse nome. Verifique no app ou adicione um novo.`
        );
      }
      break;
    }

    case 'query': {
      await handleQuery(data.type, userId, phone, message, senderName);
      break;
    }

    default: {
      // Claude returned a conversational message or asked for more info
      await sendTextMessage(phone, message || 'Não entendi. Pode reformular?');
    }
  }
}

async function handleQuery(type, userId, phone, aiMessage, senderName) {
  const summary = await getMonthSummary(userId);

  switch (type) {

    case 'saldo': {
      await sendTextMessage(phone,
        `💰 *Saldo de ${formatMonth(summary.month)}*\n\n` +
        `✅ Saldo realizado: *${fmt(summary.saldoRealizado)}*\n` +
        `📊 Saldo previsto: ${fmt(summary.saldoPrevisto)}\n\n` +
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
        `💚 Entradas: ${fmt(summary.entradas.confirmado)} recebido de ${fmt(summary.entradas.total)} previsto (${summary.entradas.confirmedCount}/${summary.entradas.count})\n` +
        `❤️ Despesas: ${fmt(summary.despesas.confirmado)} pago de ${fmt(summary.despesas.total)} previsto (${summary.despesas.confirmedCount}/${summary.despesas.count})\n` +
        `💳 Cartão: ${fmt(summary.cartao.total)}\n\n` +
        `✅ Saldo realizado: *${fmt(summary.saldoRealizado)}*\n` +
        `📈 Saldo previsto: ${fmt(summary.saldoPrevisto)}\n\n` +
        (pendE > 0 ? `⏳ ${pendE} entrada(s) a receber\n` : '') +
        (pendD > 0 ? `⏳ ${pendD} despesa(s) a pagar\n` : '')
      );
      break;
    }

    case 'pendentes': {
      const lines = [];
      if (summary.pendingEntradas.length) {
        lines.push('💚 *A receber:*');
        summary.pendingEntradas.slice(0, 8).forEach(e => {
          lines.push(`  • ${e.desc} — ${fmt(e.valor)}`);
        });
      }
      if (summary.pendingDespesas.length) {
        lines.push('\n❤️ *A pagar:*');
        summary.pendingDespesas.slice(0, 8).forEach(e => {
          lines.push(`  • ${e.desc} — ${fmt(e.valor)}`);
        });
      }
      if (!lines.length) {
        await sendTextMessage(phone, '🎉 Tudo pago e recebido! Nenhum pendente este mês.');
      } else {
        await sendTextMessage(phone, `⏳ *Pendentes de ${formatMonth(summary.month)}*\n\n${lines.join('\n')}`);
      }
      break;
    }

    case 'gastos': {
      const recent = await getRecentTransactions(userId, 8);
      if (!recent.despesas.length) {
        await sendTextMessage(phone, 'Nenhum gasto registrado este mês ainda.');
      } else {
        const lines = recent.despesas.map(d =>
          `  ${d.confirmado ? '✅' : '⏳'} ${d.desc} — ${fmt(d.valor)}`
        );
        await sendTextMessage(phone,
          `📉 *Últimos gastos (${formatMonth(summary.month)})*\n\n${lines.join('\n')}\n\n` +
          `Total pago: ${fmt(summary.despesas.confirmado)}`
        );
      }
      break;
    }

    case 'investimentos': {
      const inv = summary.investimentos;
      const lines = Object.entries(inv.porTipo)
        .filter(([, v]) => v > 0)
        .map(([tipo, v]) => `  • ${INV_TIPO_LABELS[tipo]}: ${fmt(v)}`);
      if (!lines.length) {
        await sendTextMessage(phone, 'Nenhum investimento registrado ainda.');
      } else {
        await sendTextMessage(phone,
          `📈 *Investimentos*\n\n${lines.join('\n')}\n\n` +
          `*Total: ${fmt(inv.total)}*`
        );
      }
      break;
    }

    default:
      await sendTextMessage(phone, aiMessage || 'Posso te ajudar com saldo, resumo, pendentes, gastos e investimentos!');
  }
}

function formatMonth(ym) {
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const [y, m] = ym.split('-');
  return `${months[parseInt(m) - 1]} ${y}`;
}
