const axios = require('axios');

const PHONE_ID = process.env.META_PHONE_ID || '1207148405807761';
const TOKEN = process.env.META_TOKEN;
const BASE = `https://graph.facebook.com/v19.0/${PHONE_ID}`;
const HEADERS = () => ({ 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });

function formatarNumero(telefone) {
  let num = telefone.replace(/\D/g, '');
  if (!num.startsWith('55')) num = '55' + num;
  return num;
}

async function getStatus() {
  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/v19.0/${PHONE_ID}`,
      { headers: HEADERS() }
    );
    return { ok: true, status: data.verified_name ? 'conectado' : 'desconectado' };
  } catch(e) { return { ok: false, status: 'desconectado' }; }
}

async function getQRCode() {
  return { ok: false, qr: null, msg: 'API Oficial não usa QR Code' };
}

async function criarInstancia() {
  return { ok: true, msg: 'API Oficial Meta — sem necessidade de instância' };
}

async function desconectar() {
  return { ok: true, msg: 'API Oficial Meta — sempre conectado' };
}

async function enviarMensagem(telefone, mensagem) {
  try {
    const num = formatarNumero(telefone);
    const { data } = await axios.post(`${BASE}/messages`, {
      messaging_product: 'whatsapp',
      to: num,
      type: 'text',
      text: { body: mensagem }
    }, { headers: HEADERS() });
    if (data.error) {
      console.error('Meta enviarMensagem erro silencioso:', data.error);
      return { ok: false, erro: data.error.message };
    }
    if (!data.messages || !data.messages[0]?.id) {
      console.error('Meta enviarMensagem sem confirmacao:', JSON.stringify(data));
      return { ok: false, erro: 'Meta não confirmou o envio' };
    }
    console.log(`Meta mensagem OK -> ${num} | msg_id: ${data.messages[0].id}`);
    return { ok: true, data };
  } catch(e) {
    console.error('Meta enviarMensagem erro:', e.response?.data || e.message);
    return { ok: false, erro: e.response?.data?.error?.message || e.message };
  }
}

async function enviarImagem(telefone, imageUrl, legenda) {
  try {
    const num = formatarNumero(telefone);
    const { data } = await axios.post(`${BASE}/messages`, {
      messaging_product: 'whatsapp',
      to: num,
      type: 'image',
      image: { link: imageUrl, caption: legenda || '' }
    }, { headers: HEADERS() });
    return { ok: true, data };
  } catch(e) {
    console.error('Meta enviarImagem erro:', e.response?.data || e.message);
    return { ok: false, erro: e.response?.data?.error?.message || e.message };
  }
}

async function enviarVideo(telefone, videoUrl, legenda) {
  try {
    const num = formatarNumero(telefone);
    const { data } = await axios.post(`${BASE}/messages`, {
      messaging_product: 'whatsapp',
      to: num,
      type: 'video',
      video: { link: videoUrl, caption: legenda || '' }
    }, { headers: HEADERS() });
    return { ok: true, data };
  } catch(e) {
    console.error('Meta enviarVideo erro:', e.response?.data || e.message);
    return { ok: false, erro: e.response?.data?.error?.message || e.message };
  }
}

async function enviarMidia(telefone, tipo, url, legenda) {
  if (tipo === 'imagem') return enviarImagem(telefone, url, legenda);
  if (tipo === 'video') return enviarVideo(telefone, url, legenda);
  return enviarMensagem(telefone, legenda || url);
}

async function enviarTemplate(telefone, templateName, languageCode, components) {
  try {
    const num = formatarNumero(telefone);
    const { data } = await axios.post(`${BASE}/messages`, {
      messaging_product: 'whatsapp',
      to: num,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode || 'pt_BR' },
        components: components || []
      }
    }, { headers: HEADERS() });

    // Verifica se a Meta retornou erro mesmo com HTTP 200
    if (data.error) {
      console.error('Meta enviarTemplate erro silencioso:', data.error);
      return { ok: false, erro: data.error.message };
    }
    // Verifica se retornou message_id — confirmação real de aceite
    if (!data.messages || !data.messages[0]?.id) {
      console.error('Meta enviarTemplate sem confirmacao:', JSON.stringify(data));
      return { ok: false, erro: 'Meta não confirmou o envio' };
    }
    console.log(`Meta template OK: ${templateName} -> ${num} | msg_id: ${data.messages[0].id}`);
    return { ok: true, data };
  } catch(e) {
    console.error('Meta enviarTemplate erro:', e.response?.data || e.message);
    return { ok: false, erro: e.response?.data?.error?.message || e.message };
  }
}

async function enviarMensagemInstancia(inst, telefone, mensagem) {
  // Com API oficial usa o token principal
  return enviarMensagem(telefone, mensagem);
}

async function enviarMidiaInstancia(inst, telefone, tipo, url, legenda) {
  return enviarMidia(telefone, tipo, url, legenda);
}

module.exports = {
  criarInstancia, getQRCode, getStatus, desconectar,
  enviarMensagem, enviarImagem, enviarVideo, enviarMidia,
  enviarTemplate, enviarMensagemInstancia, enviarMidiaInstancia
};