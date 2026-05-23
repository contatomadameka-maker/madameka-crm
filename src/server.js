require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');

const { pool } = require('./database');
const db = pool;
const wpp = require('./whatsapp');
const { responderIA } = require('./ia');

const app = express();
const PORT = process.env.PORT || 3000;
const PASS = process.env.ADMIN_PASSWORD || 'madameka2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
const upload = multer({ dest: '/tmp/uploads/' });

app.post('/api/login', (req, res) => {
  const { senha } = req.body;
  if (senha === PASS) return res.json({ ok: true });
  res.status(401).json({ ok: false, erro: 'Senha incorreta' });
});

app.get('/api/wpp/status', async (req, res) => res.json(await wpp.getStatus()));
app.get('/api/wpp/qr', async (req, res) => res.json(await wpp.getQRCode()));
app.post('/api/wpp/criar', async (req, res) => res.json(await wpp.criarInstancia()));
app.post('/api/wpp/desconectar', async (req, res) => res.json(await wpp.desconectar()));

app.post('/webhook/wpp', async (req, res) => {
  res.json({ ok: true });
  const body = req.body;
  if (!body?.data?.message) return;
  const from = body.data.key?.remoteJid?.replace('@s.whatsapp.net', '');
  const text = body.data.message.conversation || body.data.message.extendedTextMessage?.text || '';
  if (!text || !from) return;
  const contato = db.prepare('SELECT * FROM contatos WHERE telefone LIKE ?').get('%' + from.slice(-9));
  const nome = contato?.nome || 'Cliente';
  db.prepare('INSERT INTO conversas (telefone, nome, mensagem, de) VALUES (?,?,?,?)').run(from, nome, text, 'cliente');
  const historico = db.prepare('SELECT * FROM conversas WHERE telefone=? ORDER BY criado_em DESC LIMIT 10').all(from).reverse();
  const resposta = await responderIA(historico, text);
  if (resposta) {
    await new Promise(r => setTimeout(r, 2000));
    const enviou = await wpp.enviarMensagem(from, resposta);
    if (enviou.ok) db.prepare('INSERT INTO conversas (telefone, nome, mensagem, de, respondida_ia) VALUES (?,?,?,?,?)').run(from, 'Madame Ka', resposta, 'bot', 1);
  }
});

app.get('/api/contatos', (req, res) => {
  const { segmento, busca, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT * FROM contatos WHERE 1=1';
  const params = [];
  if (segmento && segmento !== 'todos') { sql += ' AND segmento=?'; params.push(segmento); }
  if (busca) { sql += ' AND (nome LIKE ? OR telefone LIKE ? OR email LIKE ?)'; params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`); }
  sql += ' ORDER BY criado_em DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  const rows = db.prepare(sql).all(...params);
  const countSql = 'SELECT COUNT(*) as c FROM contatos' + (segmento && segmento !== 'todos' ? ' WHERE segmento=?' : '');
  const total = db.prepare(countSql).get(...(segmento && segmento !== 'todos' ? [segmento] : [])).c;
  res.json({ ok: true, contatos: rows, total });
});

app.get('/api/contatos/stats', (req, res) => {
  res.json({
    ok: true,
    total: db.prepare('SELECT COUNT(*) as c FROM contatos').get().c,
    vip: db.prepare("SELECT COUNT(*) as c FROM contatos WHERE segmento='VIP'").get().c,
    ativas: db.prepare("SELECT COUNT(*) as c FROM contatos WHERE segmento='Compradora Ativa'").get().c,
    inativas: db.prepare("SELECT COUNT(*) as c FROM contatos WHERE segmento='Compradora Inativa'").get().c,
    leads: db.prepare("SELECT COUNT(*) as c FROM contatos WHERE segmento='Lead'").get().c,
    disparos: db.prepare("SELECT COUNT(*) as c FROM disparos WHERE status='enviado'").get().c,
  });
});

app.post('/api/contatos/importar', upload.single('arquivo'), (req, res) => {
  try {
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const rows = parse(content, { columns: true, skip_empty_lines: true });
    const insert = db.prepare(`INSERT OR IGNORE INTO contatos (nome,telefone,email,segmento,valor_ultimo_pedido,data_ultimo_pedido,cidade,estado,origem,data_cadastro,nascimento) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    let importados = 0;
    const importar = db.transaction(() => {
      for (const r of rows) {
        const tel = (r['WhatsApp'] || r['telefone'] || r['telefone_com_ddd'] || '').replace(/\D/g, '');
        if (!tel) continue;
        insert.run(r['Nome']||r['nome']||'', tel, r['Email']||r['email']||'', r['Segmento']||r['segmento']||'Lead', r['Valor Último Pedido']||r['valor_ultimo_pedido']||'', r['Data Último Pedido']||r['data_ultimo_pedido']||'', r['Cidade']||r['cidade']||'', r['Estado']||r['estado']||'', r['Origem']||r['utm_source']||'', r['Data Cadastro']||r['criado_em']||'', r['Nascimento']||r['data_nascimento']||'');
        importados++;
      }
    });
    importar();
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, importados });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

app.get('/api/campanhas', (req, res) => res.json({ ok: true, campanhas: db.prepare('SELECT * FROM campanhas ORDER BY criado_em DESC').all() }));

app.post('/api/campanhas', (req, res) => {
  const { nome, mensagem, segmento, intervalo_segundos } = req.body;
  const r = db.prepare('INSERT INTO campanhas (nome,mensagem,segmento,intervalo_segundos) VALUES (?,?,?,?)').run(nome, mensagem, segmento||'todos', intervalo_segundos||45);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.post('/api/campanhas/:id/disparar', async (req, res) => {
  const campanha = db.prepare('SELECT * FROM campanhas WHERE id=?').get(req.params.id);
  if (!campanha) return res.json({ ok: false, erro: 'Nao encontrada' });
  let sql = 'SELECT * FROM contatos WHERE 1=1';
  const params = [];
  if (campanha.segmento !== 'todos') { sql += ' AND segmento=?'; params.push(campanha.segmento); }
  const contatos = db.prepare(sql).all(...params);
  db.prepare('UPDATE campanhas SET status=?,disparado_em=CURRENT_TIMESTAMP WHERE id=?').run('disparando', campanha.id);
  res.json({ ok: true, total: contatos.length, mensagem: `Disparando para ${contatos.length} contatos` });
  let i = 0;
  const intervalo = (campanha.intervalo_segundos || 45) * 1000;
  async function enviarProximo() {
    if (i >= contatos.length) { db.prepare('UPDATE campanhas SET status=? WHERE id=?').run('concluido', campanha.id); return; }
    const c = contatos[i++];
    const msg = campanha.mensagem.replace(/{nome}/g, c.nome.split(' ')[0]).replace(/{email}/g, c.email||'').replace(/{cidade}/g, c.cidade||'');
    const resultado = await wpp.enviarMensagem(c.telefone, msg);
    const status = resultado.ok ? 'enviado' : 'erro';
    db.prepare('INSERT INTO disparos (campanha_id,contato_id,telefone,mensagem,status,erro,enviado_em) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)').run(campanha.id, c.id, c.telefone, msg, status, resultado.erro||null);
    db.prepare('UPDATE campanhas SET total_envios=total_envios+?,total_erros=total_erros+? WHERE id=?').run(resultado.ok?1:0, resultado.ok?0:1, campanha.id);
    db.prepare('UPDATE contatos SET ultimo_disparo=CURRENT_TIMESTAMP,total_mensagens=total_mensagens+1 WHERE id=?').run(c.id);
    setTimeout(enviarProximo, intervalo);
  }
  enviarProximo();
});

app.get('/api/fluxos', (req, res) => res.json({ ok: true, fluxos: db.prepare('SELECT * FROM fluxos ORDER BY id').all() }));

app.put('/api/fluxos/:id', (req, res) => {
  const { nome, mensagem, ativo, delay_horas } = req.body;
  db.prepare('UPDATE fluxos SET nome=?,mensagem=?,ativo=?,delay_horas=? WHERE id=?').run(nome, mensagem, ativo?1:0, delay_horas, req.params.id);
  res.json({ ok: true });
});

app.get('/api/conversas', (req, res) => res.json({ ok: true, conversas: db.prepare('SELECT DISTINCT telefone,nome,MAX(criado_em) as ultima,COUNT(*) as total FROM conversas GROUP BY telefone ORDER BY ultima DESC LIMIT 50').all() }));
app.get('/api/conversas/:telefone', (req, res) => res.json({ ok: true, mensagens: db.prepare('SELECT * FROM conversas WHERE telefone=? ORDER BY criado_em ASC').all(req.params.telefone) }));

app.post('/webhook/yampi', async (req, res) => {
  res.json({ ok: true });
  const { event, data } = req.body;
  if (!data) return;
  const telefone = (data.customer?.phone || '').replace(/\D/g, '');
  const nome = data.customer?.name || 'Cliente';
  const email = data.customer?.email || '';
  if (!telefone) return;
  db.prepare(`INSERT INTO contatos (nome,telefone,email,segmento) VALUES (?,?,?,'Compradora Ativa') ON CONFLICT(telefone) DO UPDATE SET nome=excluded.nome,segmento='Compradora Ativa'`).run(nome, telefone, email);
  if (event === 'order.created' || event === 'payment.approved') {
    const fluxo = db.prepare("SELECT * FROM fluxos WHERE tipo='pos_compra' AND ativo=1").get();
    if (fluxo) await wpp.enviarMensagem(telefone, fluxo.mensagem.replace(/{nome}/g, nome.split(' ')[0]));
  }
  if (event === 'checkout.abandoned') {
    const fluxo = db.prepare("SELECT * FROM fluxos WHERE tipo='carrinho_abandonado' AND ativo=1").get();
    if (fluxo) setTimeout(async () => await wpp.enviarMensagem(telefone, fluxo.mensagem.replace(/{nome}/g, nome.split(' ')[0])), (fluxo.delay_horas||1)*3600*1000);
  }
});

app.post('/webhook/popup', async (req, res) => {
  res.json({ ok: true });
  const { nome, whatsapp, email } = req.body;
  if (!whatsapp) return;
  const tel = whatsapp.replace(/\D/g, '');
  db.prepare(`INSERT INTO contatos (nome,telefone,email,segmento,origem) VALUES (?,?,?,'Lead','popup') ON CONFLICT(telefone) DO NOTHING`).run(nome||'', tel, email||'');
  const fluxo = db.prepare("SELECT * FROM fluxos WHERE tipo='boas_vindas' AND ativo=1").get();
  if (fluxo) {
    await new Promise(r => setTimeout(r, 3000));
    await wpp.enviarMensagem(tel, fluxo.mensagem.replace(/{nome}/g, (nome||'Cliente').split(' ')[0]));
  }
});

app.listen(PORT, () => console.log(`Madame Ka CRM porta ${PORT}`));