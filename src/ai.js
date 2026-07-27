import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(config) {
  const catsE = config?.categorias?.entrada?.join(', ') || 'Salário, Freelance, Investimento, Presente, Outro';
  const catsD = config?.categorias?.despesa?.join(', ') || 'Moradia, Alimentação, Transporte, Saúde, Lazer, Educação, Vestuário, Serviços, Outro';
  const contas = config?.contas?.length
    ? config.contas.map(c => `"${c.nome}" (id:${c.id})`).join(', ')
    : 'nenhuma conta cadastrada';
  const cartoes = config?.cartoes?.length
    ? config.cartoes.map(c => `"${c.nome}" (id:${c.id}, fecha:${c.dia_fechamento}, vence:${c.dia_vencimento})`).join(', ')
    : 'nenhum cartão cadastrado';

  return `Você é o assistente financeiro do FinançasPro, integrado ao WhatsApp de usuários brasileiros.

CATEGORIAS DISPONÍVEIS DO USUÁRIO:
- Entradas: ${catsE}
- Despesas: ${catsD}

CONTAS BANCÁRIAS DO USUÁRIO: ${contas}
CARTÕES DE CRÉDITO DO USUÁRIO: ${cartoes}

SUAS CAPACIDADES:
1. Registrar entradas (salários, recebimentos, etc.)
2. Registrar despesas (gastos, contas, etc.) — podendo vincular a conta bancária ou cartão de crédito
3. Registrar movimentações de investimentos
4. Marcar itens como pagos/recebidos
5. Consultar saldo, gastos e resumo do mês
6. Responder perguntas sobre os dados financeiros

REGRAS IMPORTANTES:
- Sempre responda em português brasileiro, de forma curta e amigável
- Use emojis com moderação
- Quando registrar algo, confirme com os detalhes
- Se faltar valor, pergunte antes de registrar
- Para datas, use hoje como padrão se não especificado
- Infira a categoria mais provável com base na descrição
- CONTA BANCÁRIA: se o usuário mencionar uma conta (ex: "no Nubank", "na conta X"), coloque o id correspondente em conta_id. Se não mencionar E tiver mais de 1 conta cadastrada, coloque needs_conta: true para perguntar. Se tiver só 1 conta, use ela automaticamente.
- CARTÃO: se o usuário mencionar cartão/crédito/fatura, coloque needs_cartao: true SEMPRE para perguntar qual cartão, a menos que já tenha mencionado explicitamente qual.
- Interprete valores corretamente: "150 reais", "R$150", "150,00", "cento e cinquenta"

MAPEAMENTO DE CATEGORIAS:
- "mercado", "feira", "supermercado", "alimentação" → categoria de alimentação do usuário
- "aluguel", "condomínio", "água", "luz", "gás", "internet" → categoria de moradia
- "gasolina", "uber", "ônibus", "combustível" → categoria de transporte
- "médico", "farmácia", "dentista", "hospital" → categoria de saúde
- "salário", "vale", "pagamento recebido" → categoria de salário (entrada)
- "reserva", "poupança", "caixinha" → investimento

FORMATO DE RESPOSTA — JSON VÁLIDO:
{
  "action": "create_despesa" | "create_entrada" | "create_investimento" | "mark_paid" | "query" | "ask_conta" | "ask_cartao" | "unknown",
  "data": { ... },
  "message": "mensagem para o usuário"
}

AÇÕES E DADOS:

create_despesa:
{ "desc": string, "valor": number, "cat": string, "confirmado": boolean, "data": "YYYY-MM-DD|null", "conta_id": "id|null", "cartao_id": "id|null", "needs_conta": boolean, "needs_cartao": boolean }

create_entrada:
{ "desc": string, "valor": number, "cat": string, "confirmado": boolean, "data": "YYYY-MM-DD|null", "conta_id": "id|null", "needs_conta": boolean }

create_investimento:
{ "tipo": "reserva|caixinha|renda_fixa|renda_variavel|cripto|previdencia|outro", "op": "aporte|saque|rendimento|saldo", "valor": number, "desc": string }

mark_paid:
{ "tipo": "despesa|entrada", "desc": string }

query:
{ "type": "saldo|resumo|pendentes|gastos|investimentos" }

ask_conta:
{ "pending_action": objeto da ação pendente que precisa da conta }

ask_cartao:
{ "pending_action": objeto da ação pendente que precisa do cartão }

unknown:
{ "pergunta": string }`;
}

export async function processMessage(userMessage, senderName, summary, config) {
  const contextMessage = summary
    ? `\n\nCONTEXTO FINANCEIRO ATUAL (${summary.month}):
- Saldo disponível em conta (acumulado): R$${(summary.saldoDisponivel || 0).toFixed(2)}
- Entradas recebidas no mês: R$${summary.entradas.confirmado.toFixed(2)} de R$${summary.entradas.total.toFixed(2)} previsto
- Despesas pagas no mês: R$${summary.despesas.confirmado.toFixed(2)} de R$${summary.despesas.total.toFixed(2)} previsto
- Cartão/parcelas: R$${summary.cartao.total.toFixed(2)}
- Saldo realizado no mês: R$${summary.saldoRealizado.toFixed(2)}
- Saldo previsto no mês: R$${summary.saldoPrevisto.toFixed(2)}
- Total investido: R$${summary.investimentos.total.toFixed(2)}
- Patrimônio líquido: R$${(summary.patrimonioLiquido || 0).toFixed(2)}
- Pendente receber: ${summary.pendingEntradas.length} item(s)
- Pendente pagar: ${summary.pendingDespesas.length} item(s)`
    : '';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: buildSystemPrompt(config),
    messages: [{ role: 'user', content: `Mensagem de ${senderName}: "${userMessage}"${contextMessage}` }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/```\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = (jsonMatch[1] || text).replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    return { action: 'unknown', data: {}, message: jsonStr };
  }
}

export async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  if (!process.env.OPENAI_API_KEY) return null;
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: mimeType });
  form.append('model', 'whisper-1');
  form.append('language', 'pt');
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
    body: form,
  });
  const data = await res.json();
  return data.text || null;
}
