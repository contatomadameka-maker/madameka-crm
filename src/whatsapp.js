const axios = require('axios');

const ZAPI_INSTANCE = '3F3B33A2992E1162E39B6627BE24201D';
const ZAPI_TOKEN = 'C8C9AEE300AE3E2B586CF1B3';
const ZAPI_CLIENT_TOKEN = 'F8d6cdf1bbebe419abdb464fbf2c74bb2S';
const ZAPI_BASE = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;
const HEADERS = { 'Client-Token': ZAPI_CLIENT_TOKEN };

async function getStatus() {
  try {
    const { data } = await axios.get(`${ZAPI_BASE}/status`, { headers: HEADERS });
    return { ok: true, status: data.connected ? 'open' : 'desconectado' };
  } catch (e) { return { ok: false, status: 'desconectado' }; }
}

async function getQRCode() {
  try {
    const { data } = await axios.get(`${ZAPI_BASE}/qr-code`, { headers: HEADERS });
    return { ok: true, qr: data.value };
  } catch (e) { return { ok: false, erro: e.message }; }
}

async function criarInstancia() {
  return { ok: true, msg: 'Use o painel Z-API para conectar' };
}

async function enviarMensagem(telefone, mensagem) {
  try {
    let num = telefone.replace(/\D/g, '');
    if (!num.startsWith('55')) num = '55' + num;
    const { data } = await axios.post(`${ZAPI_BASE}/send-text`, {
      phone: num, message: mensagem
    }, { headers: HEADERS });
    return { ok: true, data };
  } catch (e) { return { ok: false, erro: e.message }; }
}

async function enviarImagem(telefone, imageUrl, legenda) {
  try {
    let num = telefone.replace(/\D/g, '');
    if (!num.startsWith('55')) num = '55' + num;
    const { data } = await axios.post(`${ZAPI_BASE}/send-image`, {
      phone: num,
      image: imageUrl,
      caption: legenda || ''
    }, { headers: HEADERS });
    return { ok: true, data };
  } catch (e) { return { ok: false, erro: e.message }; }
}

async function enviarVideo(telefone, videoUrl, legenda) {
  try {
    let num = telefone.replace(/\D/g, '');
    if (!num.startsWith('55')) num = '55' + num;
    const { data } = await axios.post(`${ZAPI_BASE}/send-video`, {
      phone: num,
      video: videoUrl,
      caption: legenda || ''
    }, { headers: HEADERS });
    return { ok: true, data };
  } catch (e) { return { ok: false, erro: e.message }; }
}

async function enviarMidia(telefone, tipo, url, legenda) {
  if (tipo === 'imagem') return enviarImagem(telefone, url, legenda);
  if (tipo === 'video') return enviarVideo(telefone, url, legenda);
  return enviarMensagem(telefone, legenda || url);
}

async function desconectar() {
  try {
    await axios.get(`${ZAPI_BASE}/disconnect`, { headers: HEADERS });
    return { ok: true };
  } catch (e) { return { ok: false, erro: e.message }; }
}
async function enviarMensagemInstancia(inst, telefone, mensagem) {
  try {
    let num = telefone.replace(/\D/g, '');
    if (!num.startsWith('55')) num = '55' + num;
    const { data } = await axios.post(
      `https://api.z-api.io/instances/${inst.instance_id}/token/${inst.token}/send-text`,
      { phone: num, message: mensagem },
      { headers: { 'Client-Token': inst.client_token } }
    );
    return { ok: true, data };
  } catch(e) { return { ok: false, erro: e.message }; }
}

async function enviarMidiaInstancia(inst, telefone, tipo, url, legenda) {
  try {
    let num = telefone.replace(/\D/g, '');
    if (!num.startsWith('55')) num = '55' + num;
    const endpoint = tipo === 'video' ? 'send-video' : 'send-image';
    const body = tipo === 'video'
      ? { phone: num, video: url, caption: legenda||'' }
      : { phone: num, image: url, caption: legenda||'' };
    const { data } = await axios.post(
      `https://api.z-api.io/instances/${inst.instance_id}/token/${inst.token}/${endpoint}`,
      body,
      { headers: { 'Client-Token': inst.client_token } }
    );
    return { ok: true, data };
  } catch(e) { return { ok: false, erro: e.message }; }
}

module.exports = { criarInstancia, getQRCode, getStatus, enviarMensagem, enviarImagem, enviarVideo, enviarMidia, enviarMensagemInstancia, enviarMidiaInstancia, desconectar };