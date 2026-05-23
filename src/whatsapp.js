const axios = require('axios');
const BASE_URL = process.env.EVOLUTION_API_URL;
const API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'madameka';
const api = axios.create({ baseURL: BASE_URL, headers: { 'apikey': API_KEY, 'Content-Type': 'application/json' } });

async function criarInstancia() {
  try { const { data } = await api.post('/instance/create', { instanceName: INSTANCE, qrcode: true, integration: 'WHATSAPP-BAILEYS' }); return { ok: true, data }; }
  catch (e) { return { ok: false, erro: e.message }; }
}
async function getQRCode() {
  try { const { data } = await api.get(`/instance/connect/${INSTANCE}`); return { ok: true, qr: data.base64 || data.qrcode?.base64 }; }
  catch (e) { return { ok: false, erro: e.message }; }
}
async function getStatus() {
  try { const { data } = await api.get(`/instance/connectionState/${INSTANCE}`); return { ok: true, status: data.instance?.state || 'desconectado' }; }
  catch (e) { return { ok: false, status: 'desconectado' }; }
}
async function enviarMensagem(telefone, mensagem) {
  try {
    let num = telefone.replace(/\D/g, '');
    if (!num.startsWith('55')) num = '55' + num;
    const { data } = await api.post(`/message/sendText/${INSTANCE}`, { number: num + '@s.whatsapp.net', text: mensagem });
    return { ok: true, id: data.key?.id };
  } catch (e) { return { ok: false, erro: e.response?.data?.message || e.message }; }
}
async function desconectar() {
  try { await api.delete(`/instance/logout/${INSTANCE}`); return { ok: true }; }
  catch (e) { return { ok: false, erro: e.message }; }
}
module.exports = { criarInstancia, getQRCode, getStatus, enviarMensagem, desconectar };