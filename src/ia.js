const axios = require('axios');

async function responderIA(historico, mensagem) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const { data } = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `Voce e a assistente virtual da Madame Ka, loja de moda feminina brasileira. Seja simpatica e use linguagem informal mas elegante. Responda sobre: tamanhos (PP=36, P=38, M=40, G=42, GG=44, G1=46), prazo de entrega (7 a 15 dias uteis), trocas (ate 7 dias), cupons: ESPECIAL (10% primeira compra), MADAME8 (8% em 2+ pecas acima R$299), MADAME12 (12% em 3+ pecas acima R$399). Seja BREVE - maximo 3 linhas.`,
      messages: [
        ...historico.slice(-6).map(h => ({
          role: h.de === 'cliente' ? 'user' : 'assistant',
          content: h.mensagem
        })),
        { role: 'user', content: mensagem }
      ]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });
    return data.content[0]?.text || null;
  } catch (e) {
    return null;
  }
}

module.exports = { responderIA };