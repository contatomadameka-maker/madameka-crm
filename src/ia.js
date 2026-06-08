const axios = require('axios');

async function responderIA(historico, mensagem) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `Voce e a assistente virtual da Madame Ka, loja de moda feminina brasileira. Seja simpatica e use linguagem informal mas elegante. Responda sobre: tamanhos (PP=36, P=38, M=40, G=42, GG=44, G1=46), prazo de entrega (7 a 15 dias uteis), trocas (ate 7 dias), cupons: ESPECIAL (10% primeira compra), MADAME8 (8% em 2+ pecas acima R$299), MADAME12 (12% em 3+ pecas acima R$399). Seja BREVE - maximo 3 linhas.`
        },
        ...historico.slice(-6).map(h => ({
          role: h.de === 'cliente' ? 'user' : 'assistant',
          content: h.mensagem
        })),
        { role: 'user', content: mensagem }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    return data.choices[0]?.message?.content || null;
  } catch (e) {
    console.error('OpenAI erro:', e.response?.data || e.message);
    return null;
  }
}

module.exports = { responderIA };