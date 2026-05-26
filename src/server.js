require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const { pool } = require('./database');
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
app.post('/api/wpp/reset', async (req, res) => {
  try {
    const sessionDir = path.join(__dirname, '../sessions');
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir);
    }
    res.json({ ok: true, msg: 'Sessao resetada' });
  } catch(e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.post('/webhook/wpp', async (req, res) => {
  res.json({ ok: true });
  try {
    const body = req.body;
    if (!body?.data?.message) return;
    const from = body.data.key?.remoteJid?.replace('@s.whatsapp.net', '');
    const text = body.data.message.conversation || body.data.message.extendedTextMessage?.text || '';
    if (!text || !from) return;
    const { rows } = await pool.query('SELECT * FROM contatos WHERE telefone LIKE $1', ['%' + from.slice(-9)]);
    const nome = rows[0]?.nome || 'Cliente';
    await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de) VALUES ($1,$2,$3,$4)', [from, nome, text, 'cliente']);
    const hist = await pool.query('SELECT * FROM conversas WHERE telefone=$1 ORDER BY criado_em DESC LIMIT 10', [from]);
    const resposta = await responderIA(hist.rows.reverse(), text);
    if (resposta) {
      await new Promise(r => setTimeout(r, 2000));
      const enviou = await wpp.enviarMensagem(from, resposta);
      if (enviou.ok) await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de, respondida_ia) VALUES ($1,$2,$3,$4,$5)', [from, 'Madame Ka', resposta, 'bot', 1]);
    }
  } catch (e) { console.error(e); }
});

app.get('/api/contatos/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) as c FROM contatos');
    const vip = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='VIP'");
    const ativas = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='Compradora Ativa'");
    const inativas = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='Compradora Inativa'");
    const leads = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='Lead'");
    const disparos = await pool.query("SELECT COUNT(*) as c FROM disparos WHERE status='enviado'");
    res.json({ ok: true, total: parseInt(total.rows[0].c), vip: parseInt(vip.rows[0].c), ativas: parseInt(ativas.rows[0].c), inativas: parseInt(inativas.rows[0].c), leads: parseInt(leads.rows[0].c), disparos: parseInt(disparos.rows[0].c) });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/contatos', async (req, res) => {
  try {
    const { segmento, busca, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT * FROM contatos WHERE 1=1';
    const params = [];
    let i = 1;
    if (segmento && segmento !== 'todos') { sql += ` AND segmento=$${i++}`; params.push(segmento); }
    if (busca) { sql += ` AND (nome ILIKE $${i} OR telefone ILIKE $${i} OR email ILIKE $${i})`; params.push(`%${busca}%`); i++; }
    sql += ` ORDER BY criado_em DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await pool.query(sql, params);
    let countSql = 'SELECT COUNT(*) as c FROM contatos WHERE 1=1';
    const countParams = [];
    let j = 1;
    if (segmento && segmento !== 'todos') { countSql += ` AND segmento=$${j++}`; countParams.push(segmento); }
    const count = await pool.query(countSql, countParams);
    res.json({ ok: true, contatos: rows, total: parseInt(count.rows[0].c) });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/contatos/importar', upload.single('arquivo'), async (req, res) => {
  try {
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const rows = parse(content, { columns: true, skip_empty_lines: true });
    let importados = 0;
    for (const r of rows) {
      const tel = (r['whatsapp'] || r['WhatsApp'] || r['telefone'] || r['telefone_com_ddd'] || r['phone'] || '').replace(/\D/g, '');
      if (!tel) continue;
      try {
        await pool.query(`INSERT INTO contatos (nome,telefone,email,segmento,valor_ultimo_pedido,data_ultimo_pedido,cidade,estado,origem,data_cadastro,nascimento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (telefone) DO NOTHING`,
          [r['nome']||r['Nome']||'', tel, r['Email']||r['email']||'', r['Segmento']||r['segmento']||'Lead', r['Valor Último Pedido']||r['valor_ultimo_pedido']||'', r['Data Último Pedido']||r['data_ultimo_pedido']||'', r['Cidade']||r['cidade']||'', r['Estado']||r['estado']||'', r['Origem']||r['utm_source']||'', r['Data Cadastro']||r['criado_em']||'', r['Nascimento']||r['data_nascimento']||'']);
        importados++;
      } catch(e) {}
    }
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, importados });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/campanhas', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM campanhas ORDER BY criado_em DESC');
    res.json({ ok: true, campanhas: rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/campanhas', async (req, res) => {
  try {
    const { nome, mensagem, segmento, intervalo_segundos } = req.body;
    const { rows } = await pool.query('INSERT INTO campanhas (nome,mensagem,segmento,intervalo_segundos) VALUES ($1,$2,$3,$4) RETURNING id', [nome, mensagem, segmento||'todos', intervalo_segundos||45]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/campanhas/:id/disparar', async (req, res) => {
  try {
    const { rows: camp } = await pool.query('SELECT * FROM campanhas WHERE id=$1', [req.params.id]);
    if (!camp.length) return res.json({ ok: false, erro: 'Nao encontrada' });
    const campanha = camp[0];
    let sql = 'SELECT * FROM contatos WHERE 1=1';
    const params = [];
    if (campanha.segmento !== 'todos') { sql += ' AND segmento=$1'; params.push(campanha.segmento); }
    const { rows: contatos } = await pool.query(sql, params);
    await pool.query('UPDATE campanhas SET status=$1, disparado_em=NOW() WHERE id=$2', ['disparando', campanha.id]);
    res.json({ ok: true, total: contatos.length, mensagem: `Disparando para ${contatos.length} contatos` });
    let i = 0;
    const intervalo = (campanha.intervalo_segundos || 45) * 1000;
    async function enviarProximo() {
      if (i >= contatos.length) { await pool.query('UPDATE campanhas SET status=$1 WHERE id=$2', ['concluido', campanha.id]); return; }
      const c = contatos[i++];
      const msg = campanha.mensagem.replace(/{nome}/g, c.nome.split(' ')[0]).replace(/{email}/g, c.email||'').replace(/{cidade}/g, c.cidade||'');
      const resultado = await wpp.enviarMensagem(c.telefone, msg);
      const status = resultado.ok ? 'enviado' : 'erro';
      await pool.query('INSERT INTO disparos (campanha_id,contato_id,telefone,mensagem,status,erro,enviado_em) VALUES ($1,$2,$3,$4,$5,$6,NOW())', [campanha.id, c.id, c.telefone, msg, status, resultado.erro||null]);
      await pool.query('UPDATE campanhas SET total_envios=total_envios+$1, total_erros=total_erros+$2 WHERE id=$3', [resultado.ok?1:0, resultado.ok?0:1, campanha.id]);
      await pool.query('UPDATE contatos SET ultimo_disparo=NOW(), total_mensagens=total_mensagens+1 WHERE id=$1', [c.id]);
      setTimeout(enviarProximo, intervalo);
    }
    enviarProximo();
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/fluxos', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fluxos ORDER BY id');
    res.json({ ok: true, fluxos: rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put('/api/fluxos/:id', async (req, res) => {
  try {
    const { nome, mensagem, ativo, delay_horas } = req.body;
    await pool.query('UPDATE fluxos SET nome=$1, mensagem=$2, ativo=$3, delay_horas=$4 WHERE id=$5', [nome, mensagem, ativo?1:0, delay_horas, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/conversas', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT DISTINCT ON (telefone) telefone, nome, criado_em as ultima, COUNT(*) OVER (PARTITION BY telefone) as total FROM conversas ORDER BY telefone, criado_em DESC LIMIT 50');
    res.json({ ok: true, conversas: rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/conversas/:telefone', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM conversas WHERE telefone=$1 ORDER BY criado_em ASC', [req.params.telefone]);
    res.json({ ok: true, mensagens: rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/webhook/yampi', async (req, res) => {
  res.json({ ok: true });
  try {
    const { event, resource } = req.body;
    const data = resource || req.body.data || req.body;
    
    // Extrai dados do cliente
    const telefone = (data.customer?.phone || data.phone || '').replace(/\D/g, '');
    const nome = data.customer?.name || data.name || 'Cliente';
    const email = data.customer?.email || data.email || '';
    
    if (!telefone) return;

    // Salva/atualiza contato
    await pool.query(`INSERT INTO contatos (nome,telefone,email,segmento) VALUES ($1,$2,$3,'Compradora Ativa') ON CONFLICT (telefone) DO UPDATE SET nome=EXCLUDED.nome`, [nome, telefone, email]);

    const primeiro = nome.split(' ')[0];
    let mensagem = null;

    if (event === 'order.created' || event === 'order.approved' || event === 'payment.approved') {
      const { rows } = await pool.query("SELECT * FROM fluxos WHERE tipo='pos_compra' AND ativo=1");
      if (rows[0]) mensagem = rows[0].mensagem.replace(/{nome}/g, primeiro);
    }

    if (event === 'order.payment_failed' || event === 'transaction.denied') {
      mensagem = `Oi ${primeiro}! Vi que houve um problema com o pagamento do seu pedido na Madame Ka. Posso te ajudar a finalizar sua compra? 💜`;
    }

    if (event === 'checkout.abandoned' || event === 'cart.abandoned') {
      const { rows } = await pool.query("SELECT * FROM fluxos WHERE tipo='carrinho_abandonado' AND ativo=1");
      if (rows[0]) {
        const delay = (rows[0].delay_horas || 1) * 3600 * 1000;
        setTimeout(async () => {
          await wpp.enviarMensagem(telefone, rows[0].mensagem.replace(/{nome}/g, primeiro));
        }, delay);
        return;
      }
    }

    if (event === 'customer.created') {
      await pool.query(`UPDATE contatos SET segmento='Lead' WHERE telefone=$1 AND segmento='Lead'`, [telefone]);
    }

    if (mensagem) {
      await new Promise(r => setTimeout(r, 3000));
      await wpp.enviarMensagem(telefone, mensagem);
    }

  } catch (e) { console.error('Webhook Yampi erro:', e.message); }
});

app.post('/webhook/popup', async (req, res) => {
  res.json({ ok: true });
  try {
    const { nome, whatsapp, email } = req.body;
    if (!whatsapp) return;
    const tel = whatsapp.replace(/\D/g, '');
    await pool.query(`INSERT INTO contatos (nome,telefone,email,segmento,origem) VALUES ($1,$2,$3,'Lead','popup') ON CONFLICT (telefone) DO NOTHING`, [nome||'', tel, email||'']);
    const { rows } = await pool.query("SELECT * FROM fluxos WHERE tipo='boas_vindas' AND ativo=1");
    if (rows[0]) {
      await new Promise(r => setTimeout(r, 3000));
      await wpp.enviarMensagem(tel, rows[0].mensagem.replace(/{nome}/g, (nome||'Cliente').split(' ')[0]));
    }
  } catch (e) { console.error(e); }
});

app.listen(PORT, () => console.log(`Madame Ka CRM porta ${PORT}`));