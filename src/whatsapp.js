let sock = null;
let qrCode = null;
let status = 'desconectado';

async function conectar() {
  const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = await import('@whiskeysockets/baileys');
  const path = await import('path');
  const { default: fs } = await import('fs');

  const SESSION_DIR = path.join(process.cwd(), 'sessions');
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['Madame Ka CRM', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCode = qr;
      status = 'aguardando_qr';
      console.log('QR Code gerado!');
    }
    if (connection === 'close') {
      status = 'desconectado';
      qrCode = null;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(conectar, 5000);
    }
    if (connection === 'open') {
      status = 'conectado';
      qrCode = null;
      console.log('WhatsApp conectado!');
    }
  });
}

async function criarInstancia() {
  try { await conectar(); return { ok: true }; }
  catch (e) { return { ok: false, erro: e.message }; }
}

async function getQRCode() {
  if (qrCode) return { ok: true, qr: qrCode };
  return { ok: false, erro: 'QR Code nao disponivel ainda' };
}

async function getStatus() {
  return { ok: true, status: status === 'conectado' ? 'open' : status };
}

async function enviarMensagem(telefone, mensagem) {
  if (!sock || status !== 'conectado') return { ok: false, erro: 'WhatsApp nao conectado' };
  try {
    let num = telefone.replace(/\D/g, '');
    if (!num.startsWith('55')) num = '55' + num;
    await sock.sendMessage(num + '@s.whatsapp.net', { text: mensagem });
    return { ok: true };
  } catch (e) { return { ok: false, erro: e.message }; }
}

async function desconectar() {
  try {
    if (sock) await sock.logout();
    status = 'desconectado';
    qrCode = null;
    return { ok: true };
  } catch (e) { return { ok: false, erro: e.message }; }
}

conectar().catch(console.error);

module.exports = { criarInstancia, getQRCode, getStatus, enviarMensagem, desconectar };