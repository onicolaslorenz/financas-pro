import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Você é o assistente financeiro do FinançasPro, integrado ao WhatsApp de Nicolas e Emilyn.
Você ajuda a registrar e consultar finanças pessoais do casal de forma simples e rápida.

CATEGORIAS DISPONÍVEIS:
- Entradas: Salário, Freelance, Investimento, Presente, Outro
- Despesas: Moradia, Alimentação, Transporte, Saúde, Lazer, Educação, Vestuário, Serviços, Outro
- Investimentos (tipo): reserva, caixinha, renda_fixa, renda_variavel, cripto, previdencia, outro
- Investimentos (operação): aporte, saque, rendimento, saldo

SUAS CAPACIDADES:
1. Registrar entradas (salários, recebimentos, etc.)
2. Registrar despesas (gastos, contas, etc.)
3. Registrar movimentações de investimentos
4. Marcar itens como pagos/recebidos
5. Consultar saldo, gastos e resumo do mês
6. Responder perguntas sobre os dados financeiros

REGRAS:
- Sempre responda em português brasileiro, de forma curta e amigável
- Use emojis com moderação para tornar as respostas mais claras
- Quando registrar algo, confirme com os detalhes do que foi registrado
- Se faltar informação essencial (valor principalmente), pergunte antes de registrar
- Ao receber "paguei X" ou "recebi X" sem valor, pergunte o valor
- Para datas, use hoje como padrão se não especificado
- Infira a categoria mais provável com base na descrição
- "mercado", "feira", "supermercado" → Alimentação
- "aluguel", "condomínio", "água", "luz", "gás", "internet" → Moradia
- "gasolina", "uber", "ônibus", "posto" → Transporte
- "médico", "farmácia", "dentista", "hospital" → Saúde
- "salário", "vale", "pagamento" → Salário (entrada)
- "reserva", "poupança", "caixinha" → investimento tipo reserva/caixinha
- Valores: interprete "150 reais", "R$150", "150,00", "cento e cinquenta" corretamente

FORMATO DE RESPOSTA:
Você DEVE sempre responder com um JSON válido no seguinte formato:
{
  "action": "create_despesa" | "create_entrada" | "create_investimento" | "mark_paid" | "query" | "unknown",
  "data": { ... dados da ação ... },
  "message": "mensagem amigável para o usuário"
}

Ações e seus dados:

create_despesa:
{ "desc": "string", "valor": number, "cat": "categoria", "confirmado": boolean, "data": "YYYY-MM-DD ou null" }

create_entrada:
{ "desc": "string", "valor": number, "cat": "categoria", "confirmado": boolean, "data": "YYYY-MM-DD ou null" }

create_investimento:
{ "tipo": "reserva|caixinha|renda_fixa|renda_variavel|cripto|previdencia|outro", "op": "aporte|saque|rendimento|saldo", "valor": number, "desc": "string" }

mark_paid:
{ "tipo": "despesa|entrada", "desc": "termo de busca para encontrar o item" }

query:
{ "type": "saldo|resumo|pendentes|gastos|investimentos" }

unknown:
{ "pergunta": "o que você não entendeu ou precisa de mais info" }

EXEMPLOS:
"Gastei 200 no mercado" → create_despesa, confirmado: true, cat: Alimentação
"Preciso pagar o aluguel 3334" → create_despesa, confirmado: false
"Recebi meu salário 3500" → create_entrada, confirmado: true, cat: Salário
"Aportei 500 na reserva" → create_investimento, tipo: reserva, op: aporte
"Paguei o aluguel" → mark_paid, tipo: despesa, desc: aluguel
"Qual meu saldo?" → query, type: saldo
"Quanto gastei esse mês?" → query, type: resumo`;

export async function processMessage(userMessage, senderName, summary) {
  const contextMessage = summary
    ? `\n\nCONTEXTO FINANCEIRO ATUAL (${summary.month}):
- Entradas recebidas: R$${summary.entradas.confirmado.toFixed(2)} de R$${summary.entradas.total.toFixed(2)} previsto
- Despesas pagas: R$${summary.despesas.confirmado.toFixed(2)} de R$${summary.despesas.total.toFixed(2)} previsto
- Cartão/parcelas: R$${summary.cartao.total.toFixed(2)}
- Saldo realizado: R$${summary.saldoRealizado.toFixed(2)}
- Saldo previsto: R$${summary.saldoPrevisto.toFixed(2)}
- Total investido: R$${summary.investimentos.total.toFixed(2)}
- Pendente receber: ${summary.pendingEntradas.length} item(s)
- Pendente pagar: ${summary.pendingDespesas.length} item(s)`
    : '';

  const userContent = `Mensagem de ${senderName}: "${userMessage}"${contextMessage}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content[0].text.trim();

  // Extract JSON from response (handle markdown code blocks if present)
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ||
                    text.match(/```\s*([\s\S]*?)```/) ||
                    [null, text];
  const jsonStr = jsonMatch[1] || text;

  try {
    return JSON.parse(jsonStr);
  } catch {
    // If JSON parse fails, return as unknown
    return {
      action: 'unknown',
      data: {},
      message: text.replace(/```json|```/g, '').trim(),
    };
  }
}

export async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  // Use OpenAI Whisper via fetch (cheaper than full OpenAI SDK for just transcription)
  // If you don't have OpenAI key, we return a fallback message
  if (!process.env.OPENAI_API_KEY) {
    return null; // Signal that we can't transcribe
  }

  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: mimeType });
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  const data = await res.json();
  return data.text || null;
}
