import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(config) {
  const catsE = config?.categorias?.entrada?.join(', ') || 'Salário, Freelance, Investimento, Presente, Outro';
  const catsD = config?.categorias?.despesa?.join(', ') || 'Moradia, Alimentação, Transporte, Saúde, Lazer, Educação, Vestuário, Serviços, Outro';
  const contas = config?.contas?.length ? config.contas.map((c,i) => `${i+1}. ${c.nome} (id:${c.id})`).join(', ') : 'nenhuma conta cadastrada';
  const cartoes = config?.cartoes?.length ? config.cartoes.map((c,i) => `${i+1}. ${c.nome} (id:${c.id})`).join(', ') : 'nenhum cartão cadastrado';

  return `Você é o assistente financeiro do FinançasPro no WhatsApp de Nicolas e Emilyn.

CATEGORIAS DO USUÁRIO:
- Entradas: ${catsE}
- Despesas: ${catsD}

CONTAS BANCÁRIAS: ${contas}
CARTÕES DE CRÉDITO: ${cartoes}

REGRAS:
- Responda em português, curto e amigável
- Se faltar valor, pergunte antes de registrar
- Use hoje como data padrão
- Infira categoria pela descrição
- CONTA: se mencionar conta explicitamente, use o id. Se não mencionar E tiver mais de 1 conta, coloque needs_conta:true. Se tiver só 1, use ela automaticamente.
- CARTÃO: se mencionar crédito/cartão sem especificar qual, coloque needs_cartao:true. Se mencionar qual, use o id.
- TRANSFERÊNCIA: se o usuário mover dinheiro entre DUAS contas dele ("transferi 500 do Nubank pro Itaú", "passei 200 da poupança pra corrente"), use create_transferencia com os ids das duas contas. NUNCA registre transferência como entrada ou despesa. Se não conseguir identificar as duas contas com clareza, use action "unknown" e pergunte quais são.
- Valores: interprete "150 reais", "R$150", "cento e cinquenta" corretamente

MAPEAMENTO:
- mercado/feira/supermercado → Alimentação
- aluguel/luz/água/internet/gás → Moradia
- gasolina/uber/ônibus → Transporte
- médico/farmácia/dentista → Saúde
- salário/vale/pagamento recebido → Salário (entrada)
- reserva/poupança/caixinha → investimento

RESPONDA SEMPRE EM JSON:
{
  "action": "create_despesa|create_entrada|create_transferencia|create_investimento|mark_paid|query|unknown",
  "data": {...},
  "message": "mensagem para o usuário"
}

create_despesa: { "desc":str, "valor":num, "cat":str, "confirmado":bool, "data":"YYYY-MM-DD|null", "conta_id":"id|null", "cartao_id":"id|null", "needs_conta":bool, "needs_cartao":bool }
create_entrada: { "desc":str, "valor":num, "cat":str, "confirmado":bool, "data":"YYYY-MM-DD|null", "conta_id":"id|null", "needs_conta":bool }
create_transferencia: { "conta_origem_id":"id", "conta_destino_id":"id", "valor":num, "desc":str, "data":"YYYY-MM-DD|null" }
create_investimento: { "tipo":"reserva|caixinha|renda_fixa|renda_variavel|cripto|previdencia|outro", "op":"aporte|saque|rendimento|saldo", "valor":num, "desc":str }
mark_paid: { "tipo":"despesa|entrada", "desc":str }
query: { "type":"saldo|resumo|pendentes|gastos|investimentos" }
unknown: { "pergunta":str }`;
}

export async function processMessage(userMessage, senderName, summary, config) {
  const ctx = summary ? `\n\nCONTEXTO (${summary.month}):
- Saldo disponível: R$${(summary.saldoDisponivel||0).toFixed(2)}
- Entradas recebidas: R$${summary.entradas.confirmado.toFixed(2)} / R$${summary.entradas.total.toFixed(2)}
- Despesas pagas: R$${summary.despesas.confirmado.toFixed(2)} / R$${summary.despesas.total.toFixed(2)}
- Saldo realizado: R$${summary.saldoRealizado.toFixed(2)}
- Saldo previsto: R$${summary.saldoPrevisto.toFixed(2)}
- Total investido: R$${summary.investimentos.total.toFixed(2)}
- Pendentes: ${summary.pendingEntradas.length} entradas, ${summary.pendingDespesas.length} despesas` : '';

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: buildSystemPrompt(config),
    messages: [{ role: 'user', content: `${senderName}: "${userMessage}"${ctx}` }],
  });

  const text = res.content[0].text.trim();
  const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/```\s*([\s\S]*?)```/) || [null, text];
  try { return JSON.parse((match[1]||text).replace(/```json|```/g,'').trim()); }
  catch { return { action: 'unknown', data: {}, message: text }; }
}

export async function transcribeAudio(audioBuffer) {
  if (!process.env.OPENAI_API_KEY) return null;
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
  form.append('model', 'whisper-1');
  form.append('language', 'pt');
  const fetch = (await import('node-fetch')).default;
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
    body: form,
  });
  return (await r.json()).text || null;
}
