const axios = require('axios');

const ZAPI_INSTANCE = '3F3B33A2992E1162E39B6627BE24201D';
const ZAPI_TOKEN = 'C8C9AEE300AE3E2B586CF1B3';
const ZAPI_BASE = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`;

async function getStatus() {
  try {
    const { data } = await axios.get(`${ZAPI_BASE}/status`);
    return { ok: true, status: data.connected ? 'open' : 'desconectado' };
  } catch (e) { return { ok: false, status: 'desconectado' }; }
}

async function getQRCode() {
  try {
    const { data } = await axios.get(`${ZAPI_BASE}/qr-code`);
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
      phone: num,
      message: mensagem
    });
    return { ok: true, data };
  } catch (e) { return { ok: false, erro: e.message }; }
}

async function desconectar() {
  try {
    await axios.get(`${ZAPI_BASE}/disconnect`);
    return { ok: true };
  } catch (e) { return { ok: false, erro: e.message }; }
}

module.exports = { criarInstancia, getQRCode, getStatus, enviarMensagem, desconectar };