require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const { pool, buscarPorSegmento } = require('./database');
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

// ─── AUTH ────────────────────────────────────────────────────────────────────
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

// ─── WEBHOOK WHATSAPP (receber mensagens) ─────────────────────────────────────
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
    // Aniversariantes hoje
    const hoje = new Date();
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const dia = String(hoje.getDate()).padStart(2, '0');
    const aniv = await pool.query(
      `SELECT COUNT(*) as c FROM contatos WHERE nascimento LIKE $1 OR nascimento LIKE $2`,
      [`%-${mes}-${dia}`, `${dia}/${mes}%`]
    );
    res.json({
      ok: true,
      total: parseInt(total.rows[0].c),
      vip: parseInt(vip.rows[0].c),
      ativas: parseInt(ativas.rows[0].c),
      inativas: parseInt(inativas.rows[0].c),
      leads: parseInt(leads.rows[0].c),
      disparos: parseInt(disparos.rows[0].c),
      aniversariantes: parseInt(aniv.rows[0].c)
    });
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
        await pool.query(
          `INSERT INTO contatos (nome,telefone,email,segmento,valor_ultimo_pedido,data_ultimo_pedido,cidade,estado,origem,data_cadastro,nascimento)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (telefone) DO NOTHING`,
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
    const { nome, mensagem, segmento, intervalo_segundos } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO campanhas (nome,mensagem,segmento,intervalo_segundos) VALUES ($1,$2,$3,$4) RETURNING id',
      [nome, mensagem, segmento||'todos', intervalo_segundos||45]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/api/campanhas/:id/disparar', async (req, res) => {
  try {
    const { rows: camp } = await pool.query('SELECT * FROM campanhas WHERE id=$1', [req.params.id]);
    if (!camp.length) return res.json({ ok: false, erro: 'Nao encontrada' });
    const campanha = camp[0];

    // Busca quem JÁ recebeu essa campanha
    const { rows: jaEnviados } = await pool.query(
      "SELECT telefone FROM disparos WHERE campanha_id=$1 AND status='enviado'",
      [campanha.id]
    );
    const jaEnviadosSet = new Set(jaEnviados.map(r => r.telefone));

    // Busca todos os contatos do segmento
    const todosContatos = await buscarPorSegmento(campanha.segmento);

    // Filtra quem ainda NÃO recebeu
    const contatos = todosContatos.filter(c => !jaEnviadosSet.has(c.telefone));

    if (!contatos.length) {
      await pool.query('UPDATE campanhas SET status=$1 WHERE id=$2', ['concluido', campanha.id]);
      return res.json({ ok: true, total: 0, mensagem: 'Todos já receberam esta campanha!' });
    }

    await pool.query('UPDATE campanhas SET status=$1, disparado_em=NOW() WHERE id=$2', ['disparando', campanha.id]);
    res.json({ ok: true, total: contatos.length, mensagem: `Disparando para ${contatos.length} contatos (${jaEnviadosSet.size} já receberam)` });

    let i = 0;
    const intervalo = (campanha.intervalo_segundos || 45) * 1000;

    async function enviarProximo() {
      // Verifica se campanha foi pausada
      const { rows: status } = await pool.query('SELECT status FROM campanhas WHERE id=$1', [campanha.id]);
      if (status[0]?.status === 'pausado') {
        console.log(`Campanha ${campanha.id} pausada em ${i} de ${contatos.length}`);
        return;
      }

      if (i >= contatos.length) {
        await pool.query('UPDATE campanhas SET status=$1 WHERE id=$2', ['concluido', campanha.id]);
        console.log(`Campanha ${campanha.id} concluida!`);
        return;
      }

      const c = contatos[i++];
      const msg = campanha.mensagem
        .replace(/{nome}/g, (c.nome||'Cliente').split(' ')[0])
        .replace(/{email}/g, c.email||'')
        .replace(/{cidade}/g, c.cidade||'');

      let resultado;
      if (campanha.midia_tipo && campanha.midia_tipo !== 'texto' && campanha.midia_url) {
        resultado = await wpp.enviarMidia(c.telefone, campanha.midia_tipo, campanha.midia_url, msg);
      } else {
        resultado = await wpp.enviarMensagem(c.telefone, msg);
      }

      const statusEnvio = resultado.ok ? 'enviado' : 'erro';
      await pool.query(
        'INSERT INTO disparos (campanha_id,contato_id,telefone,mensagem,status,erro,enviado_em) VALUES ($1,$2,$3,$4,$5,$6,NOW())',
        [campanha.id, c.id, c.telefone, msg, statusEnvio, resultado.erro||null]
      );
      await pool.query(
        'UPDATE campanhas SET total_envios=total_envios+$1, total_erros=total_erros+$2 WHERE id=$3',
        [resultado.ok?1:0, resultado.ok?0:1, campanha.id]
      );
      await pool.query(
        'UPDATE contatos SET ultimo_disparo=NOW(), total_mensagens=total_mensagens+1 WHERE id=$1',
        [c.id]
      );

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
    const { nome, mensagem, ativo, delay_horas } = req.body;
    await pool.query('UPDATE fluxos SET nome=$1, mensagem=$2, ativo=$3, delay_horas=$4 WHERE id=$5', [nome, mensagem, ativo?1:0, delay_horas, req.params.id]);
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

    // Salva/atualiza contato com nascimento
    await pool.query(
      `INSERT INTO contatos (nome,telefone,email,segmento,nascimento)
       VALUES ($1,$2,$3,'Compradora Ativa',$4)
       ON CONFLICT (telefone) DO UPDATE SET
         nome=EXCLUDED.nome,
         segmento='Compradora Ativa',
         nascimento=COALESCE(NULLIF(EXCLUDED.nascimento,''), contatos.nascimento)`,
      [nome, telefone, email, nascimento]
    );

    // Incrementa total_compras se for compra
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
      // Delay mínimo de 30 minutos + delay configurado no fluxo
      const { rows } = await pool.query("SELECT * FROM fluxos WHERE tipo='carrinho_abandonado' AND ativo=1");
      if (rows[0]) {
        const delayMinutos = Math.max(30, (rows[0].delay_horas || 1) * 60);
        const delayMs = delayMinutos * 60 * 1000;
        setTimeout(async () => {
          // Verifica se já comprou antes de enviar
          const { rows: check } = await pool.query("SELECT segmento FROM contatos WHERE telefone=$1", [telefone]);
          if (check[0]?.segmento === 'Compradora Ativa') return; // Já comprou, não manda
          await wpp.enviarMensagem(telefone, rows[0].mensagem.replace(/{nome}/g, primeiro));
          // Dispara sequências de carrinho se houver
          await iniciarSequencia('carrinho_abandonado', telefone, nome);
        }, delayMs);
        return;
      }
    }

    if (event === 'customer.created') {
      // Não faz nada extra, contato já foi salvo
    }

    if (mensagem) {
      await new Promise(r => setTimeout(r, 3000));
      await wpp.enviarMensagem(telefone, mensagem);
    }

    // Dispara sequências de pós-compra se houver
    if (['order.created','order.approved','payment.approved'].includes(event)) {
      await iniciarSequencia('pos_compra', telefone, nome);
    }

  } catch (e) { console.error('Webhook Yampi erro:', e.message); }
});

// ─── WEBHOOK POPUP ────────────────────────────────────────────────────────────
app.post('/webhook/popup', async (req, res) => {
  res.json({ ok: true });
  try {
    const { nome, whatsapp, email } = req.body;
    if (!whatsapp) return;
    const tel = whatsapp.replace(/\D/g, '');

    // Salva como Lead só se não existir (preserva segmento se já for compradora)
    await pool.query(
      `INSERT INTO contatos (nome,telefone,email,segmento,origem)
       VALUES ($1,$2,$3,'Lead','popup')
       ON CONFLICT (telefone) DO NOTHING`,
      [nome||'', tel, email||'']
    );

    // Verifica se já é compradora — se sim, não manda cupom
    const { rows: check } = await pool.query('SELECT segmento FROM contatos WHERE telefone=$1', [tel]);
    const jaComprou = check[0]?.segmento === 'Compradora Ativa' || check[0]?.segmento === 'VIP';

    const { rows } = await pool.query("SELECT * FROM fluxos WHERE tipo='boas_vindas' AND ativo=1");
    if (rows[0]) {
      await new Promise(r => setTimeout(r, 3000));
      let msg = rows[0].mensagem.replace(/{nome}/g, (nome||'Cliente').split(' ')[0]);
      // Se já comprou, adapta a mensagem removendo o cupom
      if (jaComprou) {
        msg = `Oi ${(nome||'Cliente').split(' ')[0]}! Que bom ter você aqui! 💛\n\nSeja bem-vinda de volta à Madame Ka!\nmadameka.com.br`;
      }
      await wpp.enviarMensagem(tel, msg);
    }

    // Inicia sequência de boas-vindas se houver
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
    const { rows } = await pool.query(
      'INSERT INTO sequencias (nome,descricao,gatilho,segmento) VALUES ($1,$2,$3,$4) RETURNING id',
      [nome, descricao||'', gatilho, segmento||'todos']
    );
    const seqId = rows[0].id;
    for (let i = 0; i < passos.length; i++) {
      const p = passos[i];
      await pool.query(
        'INSERT INTO sequencia_passos (sequencia_id,ordem,mensagem,delay_horas,delay_label) VALUES ($1,$2,$3,$4,$5)',
        [seqId, i+1, p.mensagem, p.delay_horas, p.delay_label||'']
      );
    }
    res.json({ ok: true, id: seqId });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put('/api/sequencias/:id', async (req, res) => {
  try {
    const { nome, descricao, gatilho, segmento, ativo, passos } = req.body;
    await pool.query(
      'UPDATE sequencias SET nome=$1,descricao=$2,gatilho=$3,segmento=$4,ativo=$5 WHERE id=$6',
      [nome||'', descricao||'', gatilho||'manual', segmento||'todos', ativo?1:0, req.params.id]
    );
    if (passos && passos.length > 0) {
      await pool.query('DELETE FROM sequencia_passos WHERE sequencia_id=$1', [req.params.id]);
      for (let i = 0; i < passos.length; i++) {
        const p = passos[i];
        await pool.query(
          'INSERT INTO sequencia_passos (sequencia_id,ordem,mensagem,delay_horas,delay_label) VALUES ($1,$2,$3,$4,$5)',
          [req.params.id, i+1, p.mensagem, p.delay_horas, p.delay_label||'']
        );
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

// Função para iniciar uma sequência para um contato
async function iniciarSequencia(gatilho, telefone, nome) {
  try {
    const { rows: seqs } = await pool.query(
      'SELECT * FROM sequencias WHERE gatilho=$1 AND ativo=1', [gatilho]
    );
    for (const seq of seqs) {
      const { rows: passos } = await pool.query(
        'SELECT * FROM sequencia_passos WHERE sequencia_id=$1 ORDER BY ordem', [seq.id]
      );
      if (!passos.length) continue;

      // Verifica se já tem execução ativa para esse contato nessa sequência
      const { rows: exec } = await pool.query(
        "SELECT id FROM sequencia_execucoes WHERE sequencia_id=$1 AND telefone=$2 AND status='ativo'",
        [seq.id, telefone]
      );
      if (exec.length) continue; // Já está em execução

      // Registra execução
      const proximo = new Date(Date.now() + (passos[0].delay_horas || 0) * 3600000);
      await pool.query(
        'INSERT INTO sequencia_execucoes (sequencia_id,telefone,passo_atual,status,proximo_envio) VALUES ($1,$2,$3,$4,$5)',
        [seq.id, telefone, 0, 'ativo', proximo]
      );

      // Agenda cada passo
      let acumulado = 0;
      for (const passo of passos) {
        acumulado += (passo.delay_horas || 0) * 3600000;
        const msgFinal = acumulado === 0 ? 0 : acumulado;
        setTimeout(async () => {
          try {
            // Verifica se deve ainda enviar (contato pode ter comprado)
            const { rows: checkSeq } = await pool.query(
              "SELECT status FROM sequencia_execucoes WHERE sequencia_id=$1 AND telefone=$2",
              [seq.id, telefone]
            );
            if (checkSeq[0]?.status !== 'ativo') return;

            // Se for carrinho abandonado, verifica se já comprou
            if (gatilho === 'carrinho_abandonado') {
              const { rows: checkCompra } = await pool.query(
                "SELECT segmento FROM contatos WHERE telefone=$1", [telefone]
              );
              if (checkCompra[0]?.segmento === 'Compradora Ativa') {
                await pool.query(
                  "UPDATE sequencia_execucoes SET status='cancelado' WHERE sequencia_id=$1 AND telefone=$2",
                  [seq.id, telefone]
                );
                return;
              }
            }

            const msg = passo.mensagem.replace(/{nome}/g, (nome||'Cliente').split(' ')[0]);
            await wpp.enviarMensagem(telefone, msg);
          } catch(e) { console.error('Erro sequencia passo:', e.message); }
        }, msgFinal > 0 ? msgFinal : 3000);
      }

      // Marca como concluído após o último passo
      const totalMs = passos.reduce((acc, p) => acc + (p.delay_horas||0)*3600000, 0) + 5000;
      setTimeout(async () => {
        await pool.query(
          "UPDATE sequencia_execucoes SET status='concluido' WHERE sequencia_id=$1 AND telefone=$2 AND status='ativo'",
          [seq.id, telefone]
        );
      }, totalMs);
    }
  } catch(e) { console.error('Erro iniciarSequencia:', e.message); }
}
// ─── CRON JOB — processa sequências a cada minuto ─────────────────────────────
const cron = require('node-cron');

cron.schedule('* * * * *', async () => {
  try {
    // Busca execuções ativas cujo próximo envio já chegou
    const { rows: execucoes } = await pool.query(`
  SELECT se.*, sp.mensagem, sp.delay_horas, sp.ordem,
         sp.midia_tipo, sp.midia_url,
         s.nome as seq_nome, s.gatilho
  FROM sequencia_execucoes se
  JOIN sequencias s ON s.id = se.sequencia_id
  JOIN sequencia_passos sp ON sp.sequencia_id = se.sequencia_id 
    AND sp.ordem = se.passo_atual + 1
  WHERE se.status = 'ativo'
    AND se.proximo_envio <= NOW()
`);

    for (const exec of execucoes) {
      try {
        // Se for carrinho abandonado, verifica se já comprou
        if (exec.gatilho === 'carrinho_abandonado') {
          const { rows: check } = await pool.query(
            "SELECT segmento FROM contatos WHERE telefone=$1", [exec.telefone]
          );
          if (check[0]?.segmento === 'Compradora Ativa' || check[0]?.segmento === 'VIP') {
            await pool.query(
              "UPDATE sequencia_execucoes SET status='cancelado' WHERE id=$1", [exec.id]
            );
            console.log(`Sequencia cancelada - ${exec.telefone} ja comprou`);
            continue;
          }
        }
      // Busca nome do contato
        const { rows: contato } = await pool.query(
          'SELECT nome FROM contatos WHERE telefone=$1', [exec.telefone]
        );
        const nome = contato[0]?.nome || 'Cliente';
        const msg = exec.mensagem.replace(/{nome}/g, nome.split(' ')[0]);

        // Envia a mensagem ou mídia
        let resultado;
        if (exec.midia_tipo && exec.midia_tipo !== 'texto' && exec.midia_url) {
          resultado = await wpp.enviarMidia(exec.telefone, exec.midia_tipo, exec.midia_url, msg);
        } else {
          resultado = await wpp.enviarMensagem(exec.telefone, msg);
        }
        console.log(`Sequencia ${exec.seq_nome} passo ${exec.ordem} -> ${exec.telefone}: ${resultado.ok ? 'OK' : 'ERRO'}`);

        // Verifica se tem próximo passo
        const { rows: proximo } = await pool.query(
          'SELECT * FROM sequencia_passos WHERE sequencia_id=$1 AND ordem=$2',
          [exec.sequencia_id, exec.ordem + 1]
        );

        if (proximo.length) {
          // Agenda próximo passo
          const proximoEnvio = new Date(Date.now() + (proximo[0].delay_horas || 1) * 3600000);
          await pool.query(
            'UPDATE sequencia_execucoes SET passo_atual=$1, proximo_envio=$2 WHERE id=$3',
            [exec.ordem, proximoEnvio, exec.id]
          );
        } else {
          // Última mensagem — marca como concluído
          await pool.query(
            "UPDATE sequencia_execucoes SET status='concluido', passo_atual=$1 WHERE id=$2",
            [exec.ordem, exec.id]
          );
          console.log(`Sequencia ${exec.seq_nome} concluida para ${exec.telefone}`);
        }
      } catch(e) { console.error('Erro processando execucao:', e.message); }
    }
  } catch(e) { console.error('Erro cron sequencias:', e.message); }
});

// Cron aniversariantes — roda todo dia às 9h
cron.schedule('0 9 * * *', async () => {
  try {
    const hoje = new Date();
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const dia = String(hoje.getDate()).padStart(2, '0');
    const { rows } = await pool.query(
      `SELECT * FROM contatos WHERE nascimento LIKE $1 OR nascimento LIKE $2`,
      [`%-${mes}-${dia}`, `${dia}/${mes}%`]
    );
    console.log(`Aniversariantes hoje: ${rows.length}`);
    for (const c of rows) {
      const nome = c.nome.split(' ')[0];
      await wpp.enviarMensagem(c.telefone, `🎂 Feliz aniversário, ${nome}!\n\nA Madame Ka tem um presente especial para você hoje!\n\nUse o cupom *ANIVER15* e ganhe 15% de desconto em qualquer peça! 🎁\n\nmadameka.com.br`);
      await new Promise(r => setTimeout(r, 45000));
    }
  } catch(e) { console.error('Erro cron aniversariantes:', e.message); }
});
app.post('/api/campanhas/:id/pausar', async (req, res) => {
  try {
    await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});
// ─── UPLOAD MÍDIA ─────────────────────────────────────────────────────────────
const uploadMidia = multer({ dest: '/tmp/midia/' });
app.post('/api/upload', uploadMidia.single('arquivo'), async (req, res) => {
  try {
    const resultado = await cloudinary.uploader.upload(req.file.path, {
      folder: 'madameka-crm',
      resource_type: 'auto'
    });
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, url: resultado.secure_url, tipo: resultado.resource_type === 'video' ? 'video' : 'imagem' });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.listen(PORT, () => console.log(`Madame Ka CRM porta ${PORT}`));