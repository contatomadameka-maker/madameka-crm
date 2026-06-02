require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const { pool, buscarPorSegmento, getConfig } = require('./database');
const wpp = require('./whatsapp');
const { responderIA } = require('./ia');
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const PORT = process.env.PORT || 3000;
const PASS = process.env.ADMIN_PASSWORD || 'madameka2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
const upload = multer({ dest: '/tmp/uploads/' });

// Variações de saudação para evitar bloqueio
const SAUDACOES = ['Oi','Olá','Ei','Boa tarde','Bom dia','Oi, tudo bem?'];
const EMOJIS_FINAL = ['💛','✨','🌟','💕','🛍️','👗'];
function variarMensagem(msg, nome, idx) {
  // Substitui {nome}
  let m = msg.replace(/{nome}/g, nome||'Cliente');
  // Adiciona variação sutil no final para diferenciar mensagens
  const emoji = EMOJIS_FINAL[idx % EMOJIS_FINAL.length];
  if (!m.endsWith(emoji)) m = m + ' ' + emoji;
  return m;
}

// Verifica se está no horário permitido (9h-20h)
function horarioPermitido() {
  const hora = new Date().getHours();
  return hora >= 9 && hora < 20;
}

// Conta envios do dia
async function enviosHoje() {
  const { rows } = await pool.query(
    "SELECT COUNT(*) as c FROM disparos WHERE status='enviado' AND enviado_em >= NOW() - INTERVAL '24 hours'"
  );
  return parseInt(rows[0].c);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { senha } = req.body;
  if (senha === PASS) return res.json({ ok: true });
  res.status(401).json({ ok: false, erro: 'Senha incorreta' });
});

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────
app.get('/api/wpp/status', async (req, res) => res.json(await wpp.getStatus()));
app.get('/api/wpp/qr', async (req, res) => res.json(await wpp.getQRCode()));
app.post('/api/wpp/criar', async (req, res) => res.json(await wpp.criarInstancia()));
app.post('/api/wpp/desconectar', async (req, res) => res.json(await wpp.desconectar()));
app.post('/api/wpp/reset', async (req, res) => {
  try {
    const sessionDir = path.join(__dirname, '../sessions');
    if (fs.existsSync(sessionDir)) { fs.rmSync(sessionDir, { recursive: true, force: true }); fs.mkdirSync(sessionDir); }
    res.json({ ok: true, msg: 'Sessao resetada' });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── STATS SEGURANÇA ──────────────────────────────────────────────────────────
app.get('/api/seguranca/stats', async (req, res) => {
  try {
    const hoje = await enviosHoje();
    const horario = horarioPermitido();
    res.json({ ok: true, enviosHoje: hoje, limiteHoje: 200, horarioPermitido: horario, horaAtual: new Date().getHours() });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── WEBHOOK WPP ──────────────────────────────────────────────────────────────
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

// ─── CONTATOS ─────────────────────────────────────────────────────────────────
app.get('/api/contatos/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) as c FROM contatos');
    const vip = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='VIP'");
    const ativas = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='Compradora Ativa'");
    const inativas = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='Compradora Inativa'");
    const leads = await pool.query("SELECT COUNT(*) as c FROM contatos WHERE segmento='Lead'");
    const disparos = await pool.query("SELECT COUNT(*) as c FROM disparos WHERE status='enviado'");
    const hoje = new Date();
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const dia = String(hoje.getDate()).padStart(2, '0');
    const aniv = await pool.query(`SELECT COUNT(*) as c FROM contatos WHERE nascimento LIKE $1 OR nascimento LIKE $2`, [`%-${mes}-${dia}`, `${dia}/${mes}%`]);
    const envHoje = await enviosHoje();
    res.json({ ok: true, total: parseInt(total.rows[0].c), vip: parseInt(vip.rows[0].c), ativas: parseInt(ativas.rows[0].c), inativas: parseInt(inativas.rows[0].c), leads: parseInt(leads.rows[0].c), disparos: parseInt(disparos.rows[0].c), aniversariantes: parseInt(aniv.rows[0].c), enviosHoje: envHoje });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/api/contatos', async (req, res) => {
  try {
    const { segmento, busca, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT * FROM contatos WHERE 1=1';
    const params = [];
    let i = 1;
    if (segmento && segmento !== 'todos') { sql += ` AND segmento=$${i++}`; params.push(segmento); }
    if (busca && busca.trim() !== '') { sql += ` AND (nome ILIKE $${i} OR telefone ILIKE $${i} OR email ILIKE $${i})`; params.push(`%${busca.trim()}%`); i++; }
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
        await pool.query(
          `INSERT INTO contatos (nome,telefone,email,segmento,valor_ultimo_pedido,data_ultimo_pedido,cidade,estado,origem,data_cadastro,nascimento)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (telefone) DO UPDATE SET
             nome = CASE WHEN contatos.nome = '' OR contatos.nome IS NULL THEN EXCLUDED.nome ELSE contatos.nome END,
             segmento = CASE WHEN EXCLUDED.segmento != 'Lead' THEN EXCLUDED.segmento ELSE contatos.segmento END,
             valor_ultimo_pedido = CASE WHEN EXCLUDED.valor_ultimo_pedido != '' THEN EXCLUDED.valor_ultimo_pedido ELSE contatos.valor_ultimo_pedido END,
             data_ultimo_pedido = CASE WHEN EXCLUDED.data_ultimo_pedido != '' THEN EXCLUDED.data_ultimo_pedido ELSE contatos.data_ultimo_pedido END,
             cidade = CASE WHEN EXCLUDED.cidade != '' THEN EXCLUDED.cidade ELSE contatos.cidade END,
             nascimento = CASE WHEN EXCLUDED.nascimento != '' THEN EXCLUDED.nascimento ELSE contatos.nascimento END`,
          [r['nome']||r['Nome']||'', tel, r['Email']||r['email']||'', r['Segmento']||r['segmento']||'Lead',
           r['Valor Último Pedido']||r['valor_ultimo_pedido']||'', r['Data Último Pedido']||r['data_ultimo_pedido']||'',
           r['Cidade']||r['cidade']||'', r['Estado']||r['estado']||'', r['Origem']||r['utm_source']||'',
           r['Data Cadastro']||r['criado_em']||'', r['Nascimento']||r['data_nascimento']||'']);
        importados++;
      } catch(e) {}
    }
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, importados });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── CAMPANHAS ────────────────────────────────────────────────────────────────
app.get('/api/campanhas', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM campanhas ORDER BY criado_em DESC');
    res.json({ ok: true, campanhas: rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/campanhas', async (req, res) => {
  try {
    const { nome, mensagem, segmento, intervalo_segundos, midia_tipo, midia_url, limite } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO campanhas (nome,mensagem,segmento,intervalo_segundos,midia_tipo,midia_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [nome, mensagem, segmento||'todos', intervalo_segundos||60, midia_tipo||'texto', midia_url||'']
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/campanhas/:id/pausar', async (req, res) => {
  try {
    await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/campanhas/:id/disparar', async (req, res) => {
  try {
    const { rows: camp } = await pool.query('SELECT * FROM campanhas WHERE id=$1', [req.params.id]);
    if (!camp.length) return res.json({ ok: false, erro: 'Nao encontrada' });
    const campanha = camp[0];
    const { limite } = req.body; // limite opcional de contatos

    const cfg = await getConfig();
    const hora = new Date().getHours();
    if (hora < cfg.horario_inicio || hora >= cfg.horario_fim) {
      return res.json({ ok: false, erro: `Fora do horário permitido (${cfg.horario_inicio}h-${cfg.horario_fim}h).` });
    }
    const envHoje = await enviosHoje();
    const restante = cfg.limite_diario - envHoje;
    if (restante <= 0) {
      return res.json({ ok: false, erro: `Limite diário de ${cfg.limite_diario} atingido. Enviadas hoje: ${envHoje}.` });
    }

    // Busca quem JÁ recebeu
    const { rows: jaEnviados } = await pool.query(
      "SELECT telefone FROM disparos WHERE campanha_id=$1 AND status='enviado'", [campanha.id]
    );
    const jaEnviadosSet = new Set(jaEnviados.map(r => r.telefone));

    // Busca contatos do segmento
    const todosContatos = await buscarPorSegmento(campanha.segmento);
    let contatos = todosContatos.filter(c => !jaEnviadosSet.has(c.telefone));

    // Aplica limite de contatos se definido
    const limiteNum = parseInt(limite) || 0;
    if (limiteNum > 0) contatos = contatos.slice(0, limiteNum);

    // Respeita limite diário restante
    if (contatos.length > restante) contatos = contatos.slice(0, restante);

    if (!contatos.length) {
      await pool.query('UPDATE campanhas SET status=$1 WHERE id=$2', ['concluido', campanha.id]);
      return res.json({ ok: true, total: 0, mensagem: 'Todos já receberam ou limite diário atingido!' });
    }

    await pool.query('UPDATE campanhas SET status=$1, disparado_em=NOW() WHERE id=$2', ['disparando', campanha.id]);
    res.json({ ok: true, total: contatos.length, mensagem: `Disparando para ${contatos.length} contatos · ${restante} restantes hoje · ${jaEnviadosSet.size} já receberam` });

    let i = 0;
    const intervalo = (campanha.intervalo_segundos || 60) * 1000;

    async function enviarProximo() {
      // Verifica pausada
      const { rows: statusRows } = await pool.query('SELECT status FROM campanhas WHERE id=$1', [campanha.id]);
      if (statusRows[0]?.status === 'pausado') {
        console.log(`Campanha ${campanha.id} pausada em ${i}/${contatos.length}`);
        return;
      }

      // Verifica horário a cada envio
      const horaAtual = new Date().getHours();
      if (horaAtual < cfg.horario_inicio || horaAtual >= cfg.horario_fim) {
        await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [campanha.id]);
        return;
      }
      const envHojeNow = await enviosHoje();
      if (envHojeNow >= cfg.limite_diario) {
        await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [campanha.id]);
        console.log(`Campanha ${campanha.id} pausada — limite diário atingido`);
        return;
      }

      if (i >= contatos.length) {
        await pool.query('UPDATE campanhas SET status=$1 WHERE id=$2', ['concluido', campanha.id]);
        console.log(`Campanha ${campanha.id} concluida!`);
        return;
      }

      const c = contatos[i++];
      const nomeCliente = (c.nome||'').split(' ')[0] || 'Cliente';
      const msg = variarMensagem(campanha.mensagem, nomeCliente, i);

      // Busca instância da campanha
const { rows: instRows } = await pool.query(
  'SELECT * FROM instancias WHERE id=$1 AND ativo=1',
  [campanha.instancia_id || 1]
);
const inst = instRows[0];
let resultado;
if (inst) {
  if (campanha.midia_tipo && campanha.midia_tipo !== 'texto' && campanha.midia_url) {
    resultado = await wpp.enviarMidiaInstancia(inst, c.telefone, campanha.midia_tipo, campanha.midia_url, msg);
  } else {
    resultado = await wpp.enviarMensagemInstancia(inst, c.telefone, msg);
  }
} else {
  resultado = { ok: false, erro: 'Instância não encontrada' };
}

      const statusEnvio = resultado.ok ? 'enviado' : 'erro';
      await pool.query(
        'INSERT INTO disparos (campanha_id,contato_id,telefone,mensagem,status,erro,enviado_em) VALUES ($1,$2,$3,$4,$5,$6,NOW())',
        [campanha.id, c.id, c.telefone, msg, statusEnvio, resultado.erro||null]
      );
      await pool.query('UPDATE campanhas SET total_envios=total_envios+$1, total_erros=total_erros+$2 WHERE id=$3', [resultado.ok?1:0, resultado.ok?0:1, campanha.id]);
      await pool.query('UPDATE contatos SET ultimo_disparo=NOW(), total_mensagens=total_mensagens+1 WHERE id=$1', [c.id]);

      console.log(`Campanha ${campanha.id} [${i}/${contatos.length}] -> ${c.telefone}: ${resultado.ok?'OK':'ERRO'}`);
      setTimeout(enviarProximo, intervalo);
    }

    enviarProximo();
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── FLUXOS ───────────────────────────────────────────────────────────────────
app.get('/api/fluxos', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fluxos ORDER BY id');
    res.json({ ok: true, fluxos: rows });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put('/api/fluxos/:id', async (req, res) => {
  try {
    const { nome, mensagem, ativo, delay_horas, midia_tipo, midia_url } = req.body;
    await pool.query(
      'UPDATE fluxos SET nome=$1, mensagem=$2, ativo=$3, delay_horas=$4, midia_tipo=$5, midia_url=$6 WHERE id=$7',
      [nome, mensagem, ativo?1:0, delay_horas, midia_tipo||'texto', midia_url||'', req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── CONVERSAS ────────────────────────────────────────────────────────────────
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

// ─── WEBHOOK YAMPI ────────────────────────────────────────────────────────────
app.post('/webhook/yampi', async (req, res) => {
  res.json({ ok: true });
  try {
    const { event, resource } = req.body;
    const data = resource || req.body.data || req.body;
    const telefone = (data.customer?.phone || data.phone || '').replace(/\D/g, '');
    const nome = data.customer?.name || data.name || 'Cliente';
    const email = data.customer?.email || data.email || '';
    const nascimento = data.customer?.birthdate || data.birthdate || '';
    if (!telefone) return;
    await pool.query(
      `INSERT INTO contatos (nome,telefone,email,segmento,nascimento) VALUES ($1,$2,$3,'Compradora Ativa',$4)
       ON CONFLICT (telefone) DO UPDATE SET nome=EXCLUDED.nome, segmento='Compradora Ativa', nascimento=COALESCE(NULLIF(EXCLUDED.nascimento,''), contatos.nascimento)`,
      [nome, telefone, email, nascimento]
    );
    if (['order.created','order.approved','payment.approved'].includes(event)) {
      await pool.query('UPDATE contatos SET total_compras=COALESCE(total_compras,0)+1 WHERE telefone=$1', [telefone]);
    }
    const primeiro = nome.split(' ')[0];
    let mensagem = null;
    if (['order.created','order.approved','payment.approved'].includes(event)) {
      const { rows } = await pool.query("SELECT * FROM fluxos WHERE tipo='pos_compra' AND ativo=1");
      if (rows[0]) mensagem = rows[0].mensagem.replace(/{nome}/g, primeiro);
    }
    if (['order.payment_failed','transaction.denied'].includes(event)) {
      mensagem = `Oi ${primeiro}! Vi que houve um problema com o pagamento do seu pedido na Madame Ka. Posso te ajudar a finalizar sua compra? 💜`;
    }
    if (['checkout.abandoned','cart.abandoned'].includes(event)) {
      const { rows } = await pool.query("SELECT * FROM fluxos WHERE tipo='carrinho_abandonado' AND ativo=1");
      if (rows[0]) {
        const delayMs = Math.max(30, (rows[0].delay_horas || 1) * 60) * 60 * 1000;
        setTimeout(async () => {
          const { rows: check } = await pool.query("SELECT segmento FROM contatos WHERE telefone=$1", [telefone]);
          if (check[0]?.segmento === 'Compradora Ativa') return;
          await wpp.enviarMensagem(telefone, rows[0].mensagem.replace(/{nome}/g, primeiro));
          await iniciarSequencia('carrinho_abandonado', telefone, nome);
        }, delayMs);
        return;
      }
    }
    if (mensagem) { await new Promise(r => setTimeout(r, 3000)); await wpp.enviarMensagem(telefone, mensagem); }
    if (['order.created','order.approved','payment.approved'].includes(event)) await iniciarSequencia('pos_compra', telefone, nome);
  } catch (e) { console.error('Webhook Yampi erro:', e.message); }
});

// ─── WEBHOOK POPUP ────────────────────────────────────────────────────────────
app.post('/webhook/popup', async (req, res) => {
  res.json({ ok: true });
  try {
    const { nome, whatsapp, email } = req.body;
    if (!whatsapp) return;
    const tel = whatsapp.replace(/\D/g, '');
    await pool.query(
      `INSERT INTO contatos (nome,telefone,email,segmento,origem) VALUES ($1,$2,$3,'Lead','popup')
       ON CONFLICT (telefone) DO UPDATE SET
         nome = CASE WHEN contatos.nome = '' OR contatos.nome IS NULL THEN EXCLUDED.nome ELSE contatos.nome END`,
      [nome||'', tel, email||'']
    );
    const { rows: check } = await pool.query('SELECT segmento FROM contatos WHERE telefone=$1', [tel]);
    const jaComprou = ['Compradora Ativa','VIP','Compradora Recente'].includes(check[0]?.segmento);
    const { rows } = await pool.query("SELECT * FROM fluxos WHERE tipo='boas_vindas' AND ativo=1");
    if (rows[0]) {
      await new Promise(r => setTimeout(r, 3000));
      let msg = jaComprou
        ? `Oi ${(nome||'Cliente').split(' ')[0]}! Que bom ter você aqui! 💛\n\nSeja bem-vinda de volta à Madame Ka!\nmadameka.com.br`
        : rows[0].mensagem.replace(/{nome}/g, (nome||'Cliente').split(' ')[0]);
      await wpp.enviarMensagem(tel, msg);
    }
    await iniciarSequencia('boas_vindas', tel, nome||'Cliente');
  } catch (e) { console.error(e); }
});

// ─── SEQUÊNCIAS ───────────────────────────────────────────────────────────────
app.get('/api/sequencias', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM sequencias ORDER BY criado_em DESC');
    for (const s of rows) {
      const { rows: passos } = await pool.query('SELECT * FROM sequencia_passos WHERE sequencia_id=$1 ORDER BY ordem', [s.id]);
      s.passos = passos;
    }
    res.json({ ok: true, sequencias: rows });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/sequencias', async (req, res) => {
  try {
    const { nome, descricao, gatilho, segmento, passos } = req.body;
    const { rows } = await pool.query('INSERT INTO sequencias (nome,descricao,gatilho,segmento) VALUES ($1,$2,$3,$4) RETURNING id', [nome, descricao||'', gatilho, segmento||'todos']);
    const seqId = rows[0].id;
    for (let i = 0; i < passos.length; i++) {
      const p = passos[i];
      await pool.query('INSERT INTO sequencia_passos (sequencia_id,ordem,mensagem,delay_horas,delay_label,midia_tipo,midia_url) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [seqId, i+1, p.mensagem, p.delay_horas, p.delay_label||'', p.midia_tipo||'texto', p.midia_url||'']);
    }
    res.json({ ok: true, id: seqId });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put('/api/sequencias/:id', async (req, res) => {
  try {
    const { nome, descricao, gatilho, segmento, ativo, passos } = req.body;
    await pool.query('UPDATE sequencias SET nome=$1,descricao=$2,gatilho=$3,segmento=$4,ativo=$5 WHERE id=$6',
      [nome||'', descricao||'', gatilho||'manual', segmento||'todos', ativo?1:0, req.params.id]);
    if (passos && passos.length > 0) {
      await pool.query('DELETE FROM sequencia_passos WHERE sequencia_id=$1', [req.params.id]);
      for (let i = 0; i < passos.length; i++) {
        const p = passos[i];
        await pool.query('INSERT INTO sequencia_passos (sequencia_id,ordem,mensagem,delay_horas,delay_label,midia_tipo,midia_url) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [req.params.id, i+1, p.mensagem, p.delay_horas, p.delay_label||'', p.midia_tipo||'texto', p.midia_url||'']);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete('/api/sequencias/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM sequencias WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

async function iniciarSequencia(gatilho, telefone, nome) {
  try {
    const { rows: seqs } = await pool.query('SELECT * FROM sequencias WHERE gatilho=$1 AND ativo=1', [gatilho]);
    for (const seq of seqs) {
      const { rows: passos } = await pool.query('SELECT * FROM sequencia_passos WHERE sequencia_id=$1 ORDER BY ordem', [seq.id]);
      if (!passos.length) continue;
      const { rows: exec } = await pool.query("SELECT id FROM sequencia_execucoes WHERE sequencia_id=$1 AND telefone=$2 AND status='ativo'", [seq.id, telefone]);
      if (exec.length) continue;
      const proximo = new Date(Date.now() + (passos[0].delay_horas || 0) * 3600000);
      await pool.query('INSERT INTO sequencia_execucoes (sequencia_id,telefone,passo_atual,status,proximo_envio) VALUES ($1,$2,$3,$4,$5)', [seq.id, telefone, 0, 'ativo', proximo]);
    }
  } catch(e) { console.error('Erro iniciarSequencia:', e.message); }
}

// ─── UPLOAD MÍDIA ─────────────────────────────────────────────────────────────
const uploadMidia = multer({ dest: '/tmp/midia/' });
app.post('/api/upload', uploadMidia.single('arquivo'), async (req, res) => {
  try {
    const resultado = await cloudinary.uploader.upload(req.file.path, { folder: 'madameka-crm', resource_type: 'auto' });
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, url: resultado.secure_url, tipo: resultado.resource_type === 'video' ? 'video' : 'imagem' });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── CRON ─────────────────────────────────────────────────────────────────────
const cron = require('node-cron');

cron.schedule('* * * * *', async () => {
  try {
    const { rows: execucoes } = await pool.query(`
      SELECT se.*, sp.mensagem, sp.delay_horas, sp.ordem, sp.midia_tipo, sp.midia_url, s.nome as seq_nome, s.gatilho
      FROM sequencia_execucoes se
      JOIN sequencias s ON s.id = se.sequencia_id
      JOIN sequencia_passos sp ON sp.sequencia_id = se.sequencia_id AND sp.ordem = se.passo_atual + 1
      WHERE se.status = 'ativo' AND se.proximo_envio <= NOW()
    `);
    for (const exec of execucoes) {
      try {
        if (exec.gatilho === 'carrinho_abandonado') {
          const { rows: check } = await pool.query("SELECT segmento FROM contatos WHERE telefone=$1", [exec.telefone]);
          if (['Compradora Ativa','VIP'].includes(check[0]?.segmento)) {
            await pool.query("UPDATE sequencia_execucoes SET status='cancelado' WHERE id=$1", [exec.id]);
            continue;
          }
        }
        const { rows: contato } = await pool.query('SELECT nome FROM contatos WHERE telefone=$1', [exec.telefone]);
        const nome = contato[0]?.nome || 'Cliente';
        const msg = exec.mensagem.replace(/{nome}/g, nome.split(' ')[0]);
        let resultado;
        if (exec.midia_tipo && exec.midia_tipo !== 'texto' && exec.midia_url) {
          resultado = await wpp.enviarMidia(exec.telefone, exec.midia_tipo, exec.midia_url, msg);
        } else {
          resultado = await wpp.enviarMensagem(exec.telefone, msg);
        }
        console.log(`Seq ${exec.seq_nome} passo ${exec.ordem} -> ${exec.telefone}: ${resultado.ok?'OK':'ERRO'}`);
        const { rows: proximo } = await pool.query('SELECT * FROM sequencia_passos WHERE sequencia_id=$1 AND ordem=$2', [exec.sequencia_id, exec.ordem + 1]);
        if (proximo.length) {
          const proximoEnvio = new Date(Date.now() + (proximo[0].delay_horas || 1) * 3600000);
          await pool.query('UPDATE sequencia_execucoes SET passo_atual=$1, proximo_envio=$2 WHERE id=$3', [exec.ordem, proximoEnvio, exec.id]);
        } else {
          await pool.query("UPDATE sequencia_execucoes SET status='concluido', passo_atual=$1 WHERE id=$2", [exec.ordem, exec.id]);
        }
      } catch(e) { console.error('Erro exec:', e.message); }
    }
  } catch(e) { console.error('Erro cron sequencias:', e.message); }
});

cron.schedule('0 9 * * *', async () => {
  try {
    const hoje = new Date();
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const dia = String(hoje.getDate()).padStart(2, '0');
    const { rows } = await pool.query(`SELECT * FROM contatos WHERE nascimento LIKE $1 OR nascimento LIKE $2`, [`%-${mes}-${dia}`, `${dia}/${mes}%`]);
    for (const c of rows) {
      const nome = (c.nome||'Cliente').split(' ')[0];
      await wpp.enviarMensagem(c.telefone, `🎂 Feliz aniversário, ${nome}!\n\nA Madame Ka tem um presente especial para você hoje!\n\nUse o cupom *ANIVER15* e ganhe 15% de desconto em qualquer peça! 🎁\n\nmadameka.com.br`);
      await new Promise(r => setTimeout(r, 45000));
    }
  } catch(e) { console.error('Erro cron aniversariantes:', e.message); }
});
// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM configuracoes');
    const config = {};
    rows.forEach(r => config[r.chave] = r.valor);
    res.json({ ok: true, config });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/config', async (req, res) => {
  try {
    const { chave, valor } = req.body;
    await pool.query(
      'INSERT INTO configuracoes (chave, valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor=$2, atualizado_em=NOW()',
      [chave, valor]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
}); 
// ─── INSTÂNCIAS ───────────────────────────────────────────────────────────────
app.get('/api/instancias', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM instancias ORDER BY id');
    // Verifica status de cada uma
    for (const inst of rows) {
      try {
        // Meta Cloud API — sempre conectado
const status = 'conectado';
await pool.query('UPDATE instancias SET status=$1 WHERE id=$2', [status, inst.id]);
inst.status = status;
      } catch(e) { inst.status = 'erro'; }
    }
    res.json({ ok: true, instancias: rows });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/instancias', async (req, res) => {
  try {
    const { nome, instance_id, token, client_token } = req.body;
    if (!nome||!instance_id||!token||!client_token) return res.json({ ok: false, erro: 'Preencha todos os campos' });
    const { rows } = await pool.query(
      'INSERT INTO instancias (nome,instance_id,token,client_token) VALUES ($1,$2,$3,$4) RETURNING id',
      [nome, instance_id, token, client_token]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete('/api/instancias/:id', async (req, res) => {
  try {
    if (req.params.id === '1') return res.json({ ok: false, erro: 'Não pode excluir a instância principal' });
    await pool.query('DELETE FROM instancias WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── WEBHOOK META (WhatsApp Cloud API) ───────────────────────────────────────
app.get('/webhook/meta', (req, res) => {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (token === 'madameka2026') {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook/meta', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        for (const msg of value.messages || []) {
          const from = msg.from;
          const text = msg.text?.body || '';
          if (!text) continue;
          const { rows } = await pool.query('SELECT * FROM contatos WHERE telefone LIKE $1', ['%' + from.slice(-9)]);
          const nome = rows[0]?.nome || 'Cliente';
          await pool.query('INSERT INTO conversas (telefone, nome, mensagem, de) VALUES ($1,$2,$3,$4)', [from, nome, text, 'cliente']);
          console.log(`Meta webhook: mensagem de ${from}: ${text}`);
        }
      }
    }
  } catch(e) { console.error('Webhook Meta erro:', e.message); }
});

app.listen(PORT, () => console.log(`Madame Ka CRM porta ${PORT}`));