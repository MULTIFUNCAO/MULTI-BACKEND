/**
 * Multi Funcao — Backend Node.js + Supabase
 * Versão com banco de dados persistente
 */

require("dotenv").config();
const express  = require("express");
const axios    = require("axios");
const cors     = require("cors");
const sgMail   = require("@sendgrid/mail");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const allowedOrigins = [process.env.FRONTEND_URL, "https://floragestao.com.br", "https://localhost", "capacitor://localhost", "http://localhost"].filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : "*" }));
app.use(express.json());

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── SendGrid ────────────────────────────────────────────────────────────────
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const FROM    = "contato@multifuncao.com.br";
const APP_URL = "https://multifuncao.com.br";
const keyPreview = process.env.SENDGRID_API_KEY
  ? process.env.SENDGRID_API_KEY.slice(0,10) + "..." + process.env.SENDGRID_API_KEY.slice(-4)
  : "NÃO DEFINIDA ⚠️";
console.log("[SENDGRID] Chave carregada:", keyPreview);

// ─── Asaas ───────────────────────────────────────────────────────────────────
// A Asaas migrou o domínio da API — www.asaas.com/sandbox.asaas.com eram os
// hosts antigos. O alias antigo de produção (www.asaas.com) ainda responde,
// mas o de sandbox (sandbox.asaas.com) não valida mais chave de sandbox
// (retorna "chave não pertence a este ambiente" mesmo com chave certa —
// achado testando a cobrança de assinatura ao vivo). Hosts atuais conforme
// docs.asaas.com/docs/sandbox.
const ASAAS_BASE = process.env.ASAAS_ENV === "production"
  ? "https://api.asaas.com/v3"
  : "https://api-sandbox.asaas.com/v3";

const asaas = axios.create({
  baseURL: ASAAS_BASE,
  headers: { "access_token": process.env.ASAAS_API_KEY, "Content-Type": "application/json" },
  timeout: 15000,
});

const PLANS = {
  monthly:   { label: "Mensal",     value: 29.90  },
  quarterly: { label: "Trimestral", value: 79.90  },
  annual:    { label: "Anual",      value: 249.90 },
};

function log(tag, data) {
  console.log(`[${new Date().toISOString()}] ${tag}`, JSON.stringify(data));
}

// ─── DB Helpers ──────────────────────────────────────────────────────────────
async function getUser(phone) {
  const { data } = await supabase.from("users").select("*").eq("phone", phone).maybeSingle();
  return data;
}

async function upsertUser(phone, fields) {
  const { data } = await supabase.from("users").upsert({ phone, ...fields }, { onConflict: "email" }).select().maybeSingle();
  return data;
}

async function savePayment(fields) {
  const { data } = await supabase.from("payments").upsert(fields, { onConflict: "payment_id" }).select().maybeSingle();
  return data;
}

// Template base dos e-mails
function layout(content) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#F8F9FA;font-family:sans-serif">
    <div style="max-width:520px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <div style="background:linear-gradient(135deg,#007BFF,#0055d4);padding:28px 32px;text-align:center">
        <h1 style="color:white;margin:0;font-size:24px;font-weight:900">multi</h1>
        <p style="color:rgba(255,255,255,.7);margin:4px 0 0;font-size:12px">serviços em um toque</p>
      </div>
      <div style="padding:32px">${content}</div>
      <div style="background:#F8F9FA;padding:20px 32px;text-align:center;border-top:1px solid #E5E7EB">
        <p style="color:#9CA3AF;font-size:12px;margin:0">
          Multi Funcao · <a href="mailto:${FROM}" style="color:#9CA3AF">${FROM}</a><br>
          <a href="${APP_URL}" style="color:#007BFF;font-weight:700">${APP_URL}</a>
        </p>
      </div>
    </div>
  </body></html>`;
}

// ════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════
app.get("/", (req, res) => res.json({
  status: "online",
  env: process.env.ASAAS_ENV || "sandbox",
  db: "supabase"
}));

// ════════════════════════════════════════════════════════════════════════════
// GATILHO 1 — Boas-Vindas
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/email/boas-vindas", async (req, res) => {
  const { name, email, role } = req.body;
  if (!name || !email || !role)
    return res.status(400).json({ error: "name, email e role são obrigatórios" });

  const firstName = name.trim().split(" ")[0];
  const isPro     = role === "professional";

  const subject = isPro
    ? "Seja bem-vindo ao Multi PRO! Vamos lucrar? 🚀"
    : "Bem-vindo ao Multi! Sua casa em boas mãos 🏠";

  const body = isPro ? `
    <h2 style="color:#1a1a2e;margin:0 0 8px">Olá, ${firstName}! 🎉</h2>
    <p style="color:#555;line-height:1.7">Seu perfil de <strong>profissional</strong> foi criado com sucesso no Multi.</p>
    <div style="background:#F5F3FF;border-radius:12px;padding:20px;margin:20px 0;border-left:4px solid #7C3AED">
      <p style="margin:0 0 10px;font-weight:700;color:#5B21B6">Existem serviços esperando por você!</p>
      <p style="margin:4px 0;color:#555">🔍 Acesse o mural e veja pedidos abertos na sua região</p>
      <p style="margin:4px 0;color:#555">📱 Ative o botão "Ficar Online" para receber alertas</p>
      <p style="margin:4px 0;color:#555">⚡ Assine o Multi PRO para ver contatos e fechar mais negócios</p>
    </div>
    <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#7C3AED,#4F46E5);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700">
      Acessar o Mural →
    </a>
  ` : `
    <h2 style="color:#1a1a2e;margin:0 0 8px">Olá, ${firstName}! 🏠</h2>
    <p style="color:#555;line-height:1.7">Que bom ter você aqui! Agora você tem os melhores profissionais verificados da sua região na palma da mão.</p>
    <div style="background:#EBF4FF;border-radius:12px;padding:20px;margin:20px 0;border-left:4px solid #007BFF">
      <p style="margin:0 0 10px;font-weight:700;color:#1d4ed8">Como funciona o Multi:</p>
      <p style="margin:4px 0;color:#555">1️⃣ Poste o serviço que você precisa</p>
      <p style="margin:4px 0;color:#555">2️⃣ Receba propostas de profissionais verificados</p>
      <p style="margin:4px 0;color:#555">3️⃣ Escolha, feche o acordo e pague com segurança</p>
    </div>
    <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#007BFF,#0055d4);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700">
      Postar meu primeiro pedido →
    </a>
  `;

  try {
    await sgMail.send({ to: email, from: FROM, subject, html: layout(body) });
    log("EMAIL BOAS-VINDAS", { email, role });
    res.json({ ok: true, message: `E-mail de boas-vindas enviado para ${email}` });
  } catch (e) {
    const sgErr = e.response?.body || e.message;
    log("ERRO boas-vindas", sgErr);
    res.status(500).json({ error: "Falha ao enviar e-mail", detail: sgErr });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GATILHO 2 — Confirmação de Serviço
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/email/servico", async (req, res) => {
  const { name, email, serviceTitle, serviceDesc, serviceValue, serviceLocation } = req.body;
  if (!name || !email || !serviceTitle)
    return res.status(400).json({ error: "name, email e serviceTitle são obrigatórios" });

  const firstName = name.trim().split(" ")[0];
  const protocolo = `MF-${Date.now().toString(36).toUpperCase()}`;

  const body = `
    <h2 style="color:#1a1a2e;margin:0 0 8px">Pedido recebido! ✅</h2>
    <p style="color:#555;line-height:1.7">Olá, <strong>${firstName}</strong>! Seu pedido foi publicado.</p>
    <div style="background:#EBF4FF;border-radius:12px;padding:20px;margin:20px 0">
      <p style="margin:4px 0;color:#555"><strong>Serviço:</strong> ${serviceTitle}</p>
      ${serviceLocation ? `<p style="margin:4px 0;color:#555"><strong>Local:</strong> ${serviceLocation}</p>` : ""}
      ${serviceValue ? `<p style="margin:4px 0;color:#555"><strong>Valor:</strong> R$ ${serviceValue}</p>` : ""}
      <p style="margin:4px 0;color:#555"><strong>Protocolo:</strong> ${protocolo}</p>
    </div>
    <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#007BFF,#0055d4);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700">
      Acompanhar pedido →
    </a>
  `;

  try {
    await sgMail.send({ to: email, from: FROM, subject: `✅ Pedido confirmado — Protocolo ${protocolo}`, html: layout(body) });
    log("EMAIL SERVICO", { email, serviceTitle, protocolo });
    res.json({ ok: true, protocolo });
  } catch (e) {
    log("ERRO servico", e.response?.body || e.message);
    res.status(500).json({ error: "Falha ao enviar e-mail" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GATILHO 3 — Campanha de Marketing
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/email/campanha", async (req, res) => {
  const { adminKey, subject, titulo, mensagem, cta, ctaUrl, destinatarios } = req.body;
  if (adminKey !== process.env.EMAIL_ADMIN_KEY)
    return res.status(401).json({ error: "Acesso não autorizado" });

  let lista = [];
  if (destinatarios === "todos") {
    const { data } = await supabase.from("users").select("name, email").not("email", "is", null);
    lista = data || [];
  } else if (Array.isArray(destinatarios)) {
    lista = destinatarios.filter(d => d.email);
  }

  if (lista.length === 0)
    return res.status(400).json({ error: "Nenhum destinatário válido" });

  let enviados = 0, falhas = 0;
  for (let i = 0; i < lista.length; i += 10) {
    const lote = lista.slice(i, i + 10);
    await Promise.allSettled(lote.map(async (dest) => {
      const firstName = dest.name?.split(" ")[0] || "";
      const body = `
        <p style="color:#6B7280;font-size:13px;margin:0 0 4px">Olá, ${firstName}!</p>
        <h2 style="color:#1a1a2e;margin:0 0 16px">${titulo}</h2>
        <div style="color:#555;line-height:1.8;font-size:14px">${mensagem.replace(/\n/g, "<br>")}</div>
        ${cta ? `<div style="margin:24px 0"><a href="${ctaUrl || APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#FF5722,#E64A19);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700">${cta} →</a></div>` : ""}
      `;
      try {
        await sgMail.send({ to: dest.email, from: FROM, subject, html: layout(body) });
        enviados++;
      } catch { falhas++; }
    }));
    if (i + 10 < lista.length) await new Promise(r => setTimeout(r, 500));
  }

  log("CAMPANHA", { subject, enviados, falhas });
  res.json({ ok: true, enviados, falhas, total: lista.length });
});

// ════════════════════════════════════════════════════════════════════════════
// ASAAS — Criar cliente
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/criar-cliente", async (req, res) => {
  const { name, phone, email, role } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "name e phone são obrigatórios" });

  // Check existing
  const existing = await getUser(phone);
  if (existing?.customer_id) return res.json({ customerId: existing.customer_id });

  try {
    // Search in Asaas first
    const search = await asaas.get(`/customers?email=${email}`);
    let customerId;

    if (search.data.data?.length > 0) {
      customerId = search.data.data[0].id;
    } else {
      const { data } = await asaas.post("/customers", {
        name,
        email: email || undefined,
      cpfCnpj: cpf || "00000000191",
      });
      customerId = data.id;
    }

    // Save to Supabase
    await upsertUser(phone, { name, email, role, customer_id: customerId, is_pro: false });
    log("CLIENTE CRIADO", { customerId, phone });
    res.json({ customerId });
  } catch (e) {
    log("ERRO criar-cliente", e.response?.data || e.message);
    res.status(500).json({ error: "Erro ao criar cliente", detail: e.response?.data || e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ASAAS — Gerar PIX
// ════════════════════════════════════════════════════════════════════════════

// ── PIX para pagamento de serviço (valor livre) ──────────────────

// ─── Notificar profissionais via OneSignal ───────────────────────────────────
async function notifyProfessionals(category, clientName, value) {
  try {
    const res = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.ONESIGNAL_API_KEY
      },
      body: JSON.stringify({
        app_id: process.env.ONESIGNAL_APP_ID,
        included_segments: ['Total Subscriptions'],
        headings: { en: '🔨 NEW ORDER — Multi!', pt: '🔨 NOVO PEDIDO — Multi!' },
        contents: { en: category + ' • ' + clientName + ' • R$ ' + value, pt: category + ' • ' + clientName + ' • R$ ' + value },
        url: 'https://multifuncao.com.br'
      })
    });
    const data = await res.json();
    console.log('[ONESIGNAL]', data.id || data.errors);
  } catch(e) {
    console.log('[ONESIGNAL ERROR]', e.message);
  }
}

app.post("/api/gerar-pix-servico", async (req, res) => {
  const { customerId, value, description, phone, name, email, cpf } = req.body; console.log("[GERAR-PIX] body:", JSON.stringify(req.body));
  try {
    // Criar cliente se não tiver customerId
    let custId = customerId;
    if (!custId) {
      const custRes = await asaas.post("/customers", {
        name: name || "Cliente Multi",
        email: email || "",
        
        externalReference: phone || email,
        cpfCnpj: cpf || "00000000191",
      });
      custId = custRes.data.id;
    }

    // Criar cobrança PIX
    const pay = await asaas.post("/payments", {
      customer: custId,
      billingType: "PIX",
      value: parseFloat(value),
      dueDate: new Date().toISOString().split("T")[0],
      description: description || "Pagamento de servico - Multi",
      externalReference: phone || email || custId,
    });

    const qr = await asaas.get(`/payments/${pay.data.id}/pixQrCode`);

    log("PIX SERVICO GERADO", { paymentId: pay.data.id, value });

    // Salva payment_id no pedido
    if (req.body.pedidoId) {
      await supabase.from("pedidos").update({ payment_id: pay.data.id }).eq("id", req.body.pedidoId);
    }

    res.json({
      paymentId:    pay.data.id,
      pixCode:      qr.data.payload,
      qrCodeBase64: qr.data.encodedImage,
      expiresAt:    qr.data.expirationDate,
      value:        pay.data.value,
    });
    notifyProfessionals(description||"Serviço", name||"Cliente", value);
  } catch (e) {
    log("ERRO gerar-pix-servico", e.response?.data || e.message);
    res.status(500).json({ error: "Erro ao gerar PIX", detail: e.response?.data || e.message });
  }
});

app.post("/api/gerar-pix", async (req, res) => {
  const { plan = "monthly", phone, name, email } = req.body;
  if (!email) return res.status(400).json({ error: "email obrigatorio" });
  const { data: userData } = await supabase.from("users").select("customer_id").eq("email", email).maybeSingle();
  const customerId = userData?.customer_id;

  const pd = PLANS[plan] || PLANS.monthly;
  try {
    const pay = await asaas.post("/payments", {
      customer: customerId,
      billingType: "UNDEFINED",
      value: pd.value,
      dueDate: new Date().toISOString().split("T")[0],
      description: `Multi PRO — Plano ${pd.label}`,
      externalReference: phone || customerId,
    });

    const qr = await asaas.get(`/payments/${pay.data.id}/pixQrCode`);

    // Save payment to Supabase
    if (phone) {
      await upsertUser(phone, { name, email, payment_id: pay.data.id, plan });
      await savePayment({ phone, payment_id: pay.data.id, plan, value: pd.value, status: "PENDING" });
    }

    log("PIX GERADO", { paymentId: pay.data.id, plan, value: pd.value });
    res.json({
      paymentId:    pay.data.id,
      pixCode:      qr.data.payload,
      qrCodeBase64: qr.data.encodedImage,
      expiresAt:    qr.data.expirationDate,
      value:        pd.value,
      plan:         pd.label,
    });
  } catch (e) {
    log("ERRO gerar-pix", e.response?.data || e.message);
    res.status(500).json({ error: "Erro ao gerar PIX", detail: e.response?.data || e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ASAAS — Status do Pagamento
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/status-pagamento/:id", async (req, res) => {
  try {
    const { data } = await asaas.get(`/payments/${req.params.id}`);
    res.json({
      status: data.status,
      isPaid: ["RECEIVED", "CONFIRMED"].includes(data.status),
      value:  data.value,
    });
  } catch (e) {
    res.status(500).json({ error: "Erro ao verificar pagamento" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Status do usuário (isPro)
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/usuario/:phone", async (req, res) => {
  const user = await getUser(req.params.phone);
  res.json({ isPro: user?.is_pro || false, plan: user?.plan || null });
});

// ════════════════════════════════════════════════════════════════════════════
// WEBHOOK Asaas — Ativa PRO automaticamente ao pagar
// ════════════════════════════════════════════════════════════════════════════
app.post("/webhook/asaas", async (req, res) => {
  res.sendStatus(200);
  const { event, payment } = req.body;
  if (!["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"].includes(event)) return;

  const phone = payment.externalReference;
  if (!phone) return;

  // Activate PRO in Supabase
  const user = await getUser(phone);
  await upsertUser(phone, { is_pro: true });
  await supabase.from("payments").update({ status: "PAID", paid_at: new Date().toISOString() }).eq("payment_id", payment.id);
      mobilePhone: (()=>{ const d=phone.replace(/\D/g,""); return "("+d.slice(0,2)+") "+d.slice(2,7)+"-"+d.slice(7); })(),
  log("PRO ATIVADO", { phone, paymentId: payment.id });

  // Send confirmation email
  if (user?.email) {
    sgMail.send({
      to: user.email, from: FROM,
      subject: "🚀 Acesso PRO liberado! Boas vendas!",
      html: layout(`
        <h2>Olá, ${user.name || "Profissional"}! 🎉</h2>
        <p>Seu plano <strong>Multi PRO</strong> foi ativado com sucesso.</p>
        <div style="background:#F5F3FF;border-radius:12px;padding:16px;margin:16px 0;border-left:4px solid #7C3AED">
          <p style="margin:4px 0">✅ Contatos de clientes desbloqueados</p>
          <p style="margin:4px 0">✅ Chat direto e ilimitado</p>
          <p style="margin:4px 0">✅ Selo PRO verificado no perfil</p>
          <p style="margin:4px 0">✅ Prioridade no mural de serviços</p>
        </div>
        <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#7C3AED,#4F46E5);color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700">
          Acessar o App e Começar a Faturar →
        </a>
      `),
    }).catch(() => {});
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Admin — Lista usuários (protegido por adminKey)
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/admin/usuarios", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.EMAIL_ADMIN_KEY)
    return res.status(401).json({ error: "Não autorizado" });
  const { data } = await supabase.from("usuarios").select("*").order("created_at", { ascending: false });
  res.json({ total: data?.length || 0, users: data });
});

app.get("/api/admin/pagamentos", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.EMAIL_ADMIN_KEY)
    return res.status(401).json({ error: "Não autorizado" });
  const { data } = await supabase.from("payments").select("*").order("created_at", { ascending: false });
  res.json({ total: data?.length || 0, payments: data });
});

// ════════════════════════════════════════════════════════════════════════════

// ─── Sugestão de Meta por IA (Aflor Studio) ──────────────────────────────────
app.post('/api/sugestao-meta', async (req, res) => {
  const { servicos, meta } = req.body || {};
  if (!Array.isArray(servicos) || servicos.length === 0 || !(meta > 0)) {
    return res.status(400).json({ erro: 'Parâmetros inválidos' });
  }
  const key = process.env.ANTHROPIC_KEY;
  if (!key) return res.status(500).json({ erro: 'ANTHROPIC_KEY não configurada no servidor' });

  const lista = servicos.map(s =>
    `- ${s.nome}${s.categoria ? ' (' + s.categoria + ')' : ''} — R$ ${Number(s.preco).toFixed(2).replace('.', ',')}`
  ).join('\n');

  const prompt = `Você é um assistente de gestão para salões de beleza brasileiros.\nA empresária quer atingir uma meta financeira e selecionou os seguintes serviços:\n${lista}\nDistribua percentuais de demanda realistas entre esses serviços.\nConsidere que serviços mais frequentes (design de sobrancelha, escova, manicure) têm naturalmente maior volume que serviços esporádicos (alongamento, remoção, tratamentos especiais).\nA soma de todos os percentuais deve ser exatamente 1.0.\nResponda SOMENTE em JSON válido, sem texto adicional, sem markdown, sem explicação:\n{"Nome do Serviço": percentual_decimal}`;

  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 512, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 20000 }
    );
    const txt = r.data?.content?.[0]?.text || '{}';
    const match = txt.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    res.json(parsed);
  } catch (e) {
    console.error('[sugestao-meta] Erro Claude API:', e.message);
    res.status(500).json({ erro: 'IA indisponível' });
  }
});

// ─── Chat IA Estratégica (Aflor Studio) ──────────────────────────────────────
app.post('/api/ia-chat', async (req, res) => {
  const { system, message } = req.body || {};
  if (!message) return res.status(400).json({ erro: 'message obrigatório' });
  const key = process.env.ANTHROPIC_KEY;
  if (!key) return res.status(500).json({ erro: 'ANTHROPIC_KEY não configurada' });
  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 600, system: system || '', messages: [{ role: 'user', content: message }] },
      { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 20000 }
    );
    const resposta = r.data?.content?.[0]?.text || '';
    res.json({ resposta });
  } catch (e) {
    console.error('[ia-chat] Erro Claude API:', e.message);
    res.status(500).json({ erro: 'IA indisponível' });
  }
});

// ─── Webhook Asaas ───────────────────────────────────────────────────────────
app.post('/api/webhook/asaas', (req, res) => {
  const { event, payment } = req.body;
  console.log('[WEBHOOK]', event, payment?.id, payment?.status);
  
  if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
    // Pagamento confirmado - frontend faz polling e detecta automaticamente
    console.log('[WEBHOOK] Pagamento confirmado:', payment?.id, 'valor:', payment?.value);
  }
  
  res.status(200).json({ received: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   Multi Backend — Porta ${PORT}                           ║
║   Asaas:    ${(process.env.ASAAS_ENV||"sandbox").padEnd(42)}║
║   Banco:    Supabase (persistente)                    ║
║   E-mails:  boas-vindas · serviço · campanha          ║
╚═══════════════════════════════════════════════════════╝
  `);
});

// AUTH — Cadastro
app.post("/api/auth/cadastro", async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role)
    return res.status(400).json({ error: "name, email, password e role são obrigatórios" });
  try {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { name, role },
    });
    if (authError) {
      if (/already.*registered/i.test(authError.message))
        return res.status(409).json({ error: "E-mail já cadastrado. Faça login." });
      throw authError;
    }
    const firstName = name.trim().split(" ")[0];
    await supabase.from("users").upsert({ email, name: firstName, full_name: name, role, auth_id: authData.user.id, is_pro: false }, { onConflict: "email" });
    log("CADASTRO", { email, role });
    res.json({ ok: true, user: { id: authData.user.id, name: firstName, email, role, isPro: role === "professional" } });
  } catch (e) {
    log("ERRO cadastro", e.message);
    res.status(500).json({ error: e.message || "Erro ao criar conta" });
  }
});

// AUTH — Login
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "email e password são obrigatórios" });
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: "Email ou senha incorretos" });
    const { data: profile } = await supabase.from("users").select("*").eq("email", email).maybeSingle();
    log("LOGIN", { email });
    res.json({ ok: true, token: data.session.access_token, user: { id: data.user.id, name: profile?.name || email.split("@")[0], email, role: profile?.role || "client", isPro: profile?.is_pro || false } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AUTH — Recuperar Senha
app.post("/api/auth/recuperar-senha", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email é obrigatório" });
  try {
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: "https://multifuncao.com.br" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AUTH — Redefinir Senha
app.post("/api/auth/redefinir-senha", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "token e password são obrigatórios" });
  try {
    const { error } = await supabase.auth.admin.updateUserById(
      (await supabase.auth.getUser(token)).data.user?.id,
      { password }
    );
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao redefinir senha" });
  }
});

// Reset senha com codigo 6 digitos via SendGrid
const resetCodes = {};

app.post("/api/auth/solicitar-codigo", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email obrigatorio" });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  resetCodes[email] = { code, expires: Date.now() + 15 * 60 * 1000 };
  try {
    await sgMail.send({ to: email, from: { name: "Multi Servicos", email: "contato@multifuncao.com.br" }, subject: "Seu codigo de recuperacao - Multi", html: "<h2>Codigo: " + code + "</h2><p>Expira em 15 minutos.</p>" });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: "Erro ao enviar email" }); }
});

app.post("/api/auth/verificar-codigo", async (req, res) => {
  const { email, code, newPassword } = req.body;
  const entry = resetCodes[email];
  if (!entry) return res.status(400).json({ error: "Nenhum codigo solicitado" });
  if (Date.now() > entry.expires) { delete resetCodes[email]; return res.status(400).json({ error: "Codigo expirado" }); }
  if (entry.code !== code) return res.status(400).json({ error: "Codigo incorreto" });
  try {
    const { data: { users: authUsers } } = await supabase.auth.admin.listUsers();
      const authUser = authUsers?.find(u => u.email === email);
      if (!authUser) return res.status(404).json({ error: "Usuario nao encontrado" });
      const { error } = await supabase.auth.admin.updateUserById(authUser.id, { password: newPassword });
    if (error) throw error;
    delete resetCodes[email];
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Enderecos
app.post("/api/enderecos", async (req, res) => {
  const { phone, label, street, city, cep } = req.body; const user_id = phone;
  
  const { data, error } = await supabase.from("enderecos").insert({ user_id: phone, label, street, city, cep }).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/enderecos/:user_id", async (req, res) => {
  const { data, error } = await supabase.from("enderecos").select("*").eq("user_id", req.params.user_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Cartoes
app.post("/api/cartoes", async (req, res) => {
  const { phone, nome, numero, bandeira, tipo } = req.body; const user_id = phone;
  
  const { data, error } = await supabase.from("cartoes").insert({ user_id, nome, numero, bandeira, tipo }).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/cartoes/:user_id", async (req, res) => {
  const { data, error } = await supabase.from("cartoes").select("*").eq("user_id", req.params.user_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/api/enderecos/:id", async (req, res) => {
  const { id } = req.params;
  const { label, street, city, cep } = req.body;
  try {
    const { data, error } = await supabase.from("enderecos").update({ label, street, city, cep }).eq("id", id).select().maybeSingle();
    if (error) throw error;
    res.json({ address: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/enderecos/:id", async (req, res) => {
  const { error } = await supabase.from("enderecos").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/api/cartoes/:id", async (req, res) => {
  const { error } = await supabase.from("cartoes").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── WEBHOOK ASAAS ──────────────────────────────────────────
app.post("/api/webhook-asaas", async (req, res) => {
  const { event, payment } = req.body;
  console.log("[WEBHOOK]", event, payment?.id);
  if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") {
    const paymentId = payment?.id;
    if (paymentId) {
      await supabase.from("users").update({ is_pro: true }).eq("payment_id", paymentId);
      const { data: pedidos } = await supabase.from("pedidos").select("id").eq("payment_id", paymentId);
      if (pedidos && pedidos.length > 0) {
        await supabase.from("pedidos").update({ status: "pago", phase: 2 }).eq("payment_id", paymentId);
        console.log("[WEBHOOK] Pedido pago:", paymentId);
      }
    }
  }
  res.sendStatus(200);
});

// ════════════════════════════════════════════════════════════════════════════
// ASSINATURA (usuarios/empresas + tabela "assinaturas") — cobrança real via
// Asaas, substitui o antigo trial de 7 dias criado direto pelo frontend.
// A tabela "assinaturas" agora só aceita insert/update via service_role (RLS
// travada na migration supabase_pendencias_doc_pagamento_migration.sql) —
// esse endpoint é o ÚNICO jeito de um plano virar "ativa".
// ════════════════════════════════════════════════════════════════════════════
const PLANOS_ASSINATURA = {
  autonomo: { valor: 29.90,  label: "Multi Autônomo" },
  pro:      { valor: 59.90,  label: "Multi Pro" },
  premium:  { valor: 129.90, label: "Multi Premium" },
};

// Limites de negócio (categoria/valor/quantidade) por plano do profissional.
// Espelha PLANO_LIMITES_USUARIO em MULTI/src/App.jsx — repos separados, sem
// pacote compartilhado, então qualquer mudança aqui precisa ser replicada
// manualmente lá (e vice-versa). null = sem limite (Premium).
const PLANO_LIMITES_USUARIO = {
  autonomo: { maxCategorias: 1, maxServicosMes: 3,  valorMaxServico: 600  },
  pro:      { maxCategorias: 3, maxServicosMes: 10, valorMaxServico: 3000 },
  premium:  { maxCategorias: null, maxServicosMes: null, valorMaxServico: null },
};

// Ciclo de cobrança rolante de 30 dias a partir de assinaturas.inicio — não
// existe renovação automática/coluna de "última cobrança" ainda (ver aviso
// logo acima, em /api/assinatura/cobrar), então o ciclo é sempre calculado
// on-the-fly a partir da data de início da assinatura.
function cicloAtualInicio(inicioISO) {
  const inicio = new Date(inicioISO).getTime();
  const now = Date.now();
  const CICLO_MS = 30 * 24 * 60 * 60 * 1000;
  if (now <= inicio) return new Date(inicio);
  const ciclosPassados = Math.floor((now - inicio) / CICLO_MS);
  return new Date(inicio + ciclosPassados * CICLO_MS);
}

// Busca cliente Asaas por e-mail, cria se não existir — extraído de dentro de
// /api/assinatura/cobrar pra ser reaproveitado também por /api/assinatura/gerar-pix
// (mesmo titular não deve virar 2 clientes Asaas diferentes por ter tentado
// cartão e PIX).
async function buscarOuCriarClienteAsaas({ email, nome, cpf, phone }) {
  const search = await asaas.get(`/customers?email=${encodeURIComponent(email)}`);
  if (search.data?.data?.length > 0) return search.data.data[0].id;
  const { data } = await asaas.post("/customers", {
    name: nome || email, email, cpfCnpj: cpf,
    mobilePhone: (phone || "").replace(/\D/g, "") || undefined,
  });
  return data.id;
}

// Grava/atualiza a linha de "assinaturas" — único ponto que faz isso, chamado
// só depois que o pagamento já está confirmado de verdade na Asaas (cartão:
// síncrono, dentro do próprio /api/assinatura/cobrar; PIX: assíncrono, só
// depois que /api/assinatura/confirmar-pix reconfere o status). RLS trava
// insert/update de "assinaturas" pra service_role (ver comentário acima).
async function ativarAssinatura({ titularTipo, titularEmail, plano, paymentId, customerId }) {
  const inicio = new Date();
  const proximaCobranca = new Date(inicio.getTime() + 30 * 24 * 60 * 60 * 1000);
  const { error } = await supabase.from("assinaturas").upsert({
    titular_tipo: titularTipo,
    titular_email: titularEmail,
    plano,
    status: "ativa",
    inicio: inicio.toISOString(),
    expira_em: proximaCobranca.toISOString(),
    proxima_cobranca: proximaCobranca.toISOString(),
    asaas_customer_id: customerId,
    asaas_payment_id: paymentId,
  }, { onConflict: "titular_tipo,titular_email" });
  if (error) throw error;
  return { proximaCobranca };
}

app.post("/api/assinatura/cobrar", async (req, res) => {
  const {
    titularTipo, titularEmail, titularNome, plano,
    cardNumber, cardHolder, expiryMonth, expiryYear, cvv, cpf, phone,
  } = req.body || {};

  // Planos pagos de empresa deixaram de existir — só profissional (titular_tipo
  // "usuario") pode assinar a partir daqui. Assinaturas "empresa"/"empresa_plus"
  // já existentes continuam válidas no banco (ver supabase_planos_premium_migration.sql),
  // só não é mais possível criar novas por aqui.
  if (titularTipo !== "usuario")
    return res.status(400).json({ error: "titularTipo inválido" });
  const planoInfo = PLANOS_ASSINATURA[plano];
  if (!planoInfo) return res.status(400).json({ error: "Plano inválido" });
  if (!titularEmail || !cardNumber || !cardHolder || !expiryMonth || !expiryYear || !cvv || !cpf)
    return res.status(400).json({ error: "Dados de pagamento incompletos" });

  try {
    const customerId = await buscarOuCriarClienteAsaas({ email: titularEmail, nome: titularNome, cpf, phone });

    // Cobrança do primeiro mês — cartão de crédito, síncrono (mesmo padrão
    // testado em /api/cobrar-cartao). Renovação automática do mês seguinte
    // ainda NÃO está automatizada aqui (precisaria da Asaas Subscriptions
    // API ou de um job agendado) — ver aviso no retorno.
    const pay = await asaas.post("/payments", {
      customer: customerId, billingType: "CREDIT_CARD", value: planoInfo.valor,
      dueDate: new Date().toISOString().split("T")[0],
      creditCard: { holderName: cardHolder, number: cardNumber, expiryMonth, expiryYear, ccv: cvv },
      creditCardHolderInfo: {
        name: cardHolder, email: titularEmail, cpfCnpj: cpf,
        phone: (phone || "").replace(/\D/g, "") || undefined,
        postalCode: "01310100", addressNumber: "1",
      },
      description: `${planoInfo.label} — assinatura mensal`,
    });

    if (!["CONFIRMED", "RECEIVED"].includes(pay.data.status)) {
      log("ASSINATURA COBRANCA PENDENTE", { titularEmail, plano, status: pay.data.status, paymentId: pay.data.id });
      return res.status(402).json({ error: "Pagamento não confirmado", status: pay.data.status });
    }

    const { proximaCobranca } = await ativarAssinatura({ titularTipo, titularEmail, plano, paymentId: pay.data.id, customerId });

    log("ASSINATURA ATIVADA", { titularEmail, plano, paymentId: pay.data.id });
    res.json({
      success: true,
      status: "ativa",
      valor: planoInfo.valor,
      proximaCobranca: proximaCobranca.toISOString(),
      paymentId: pay.data.id,
    });
  } catch (e) {
    log("ERRO assinatura/cobrar", e.response?.data || e.message || e);
    res.status(500).json({
      error: e.response?.data?.errors?.[0]?.description || e.response?.data?.message || e.message || "Erro ao processar pagamento",
      detail: e.response?.data || { message: e.message, code: e.code, hint: e.hint, details: e.details },
    });
  }
});

// ── ASSINATURA VIA PIX ────────────────────────────────────────────────────
// PIX não confirma na hora como cartão — aqui só gera a cobrança (QR code +
// copia-e-cola). A ativação de verdade em "assinaturas" só acontece em
// /api/assinatura/confirmar-pix, chamado pelo front depois que o polling em
// /api/status-pagamento/:id indicar que o pagamento foi recebido.
app.post("/api/assinatura/gerar-pix", async (req, res) => {
  const { titularTipo, titularEmail, titularNome, plano, cpf, phone } = req.body || {};

  if (titularTipo !== "usuario")
    return res.status(400).json({ error: "titularTipo inválido" });
  const planoInfo = PLANOS_ASSINATURA[plano];
  if (!planoInfo) return res.status(400).json({ error: "Plano inválido" });
  if (!titularEmail || !cpf)
    return res.status(400).json({ error: "Dados incompletos" });

  try {
    const customerId = await buscarOuCriarClienteAsaas({ email: titularEmail, nome: titularNome, cpf, phone });

    const pay = await asaas.post("/payments", {
      customer: customerId, billingType: "PIX", value: planoInfo.valor,
      dueDate: new Date().toISOString().split("T")[0],
      description: `${planoInfo.label} — assinatura mensal (PIX)`,
      externalReference: `plano:${titularTipo}:${titularEmail}:${plano}`,
    });

    const qr = await asaas.get(`/payments/${pay.data.id}/pixQrCode`);

    log("ASSINATURA PIX GERADO", { titularEmail, plano, paymentId: pay.data.id });
    res.json({
      paymentId: pay.data.id,
      customerId,
      pixCode: qr.data.payload,
      qrCodeBase64: qr.data.encodedImage,
      expiresAt: qr.data.expirationDate,
      value: planoInfo.valor,
    });
  } catch (e) {
    log("ERRO assinatura/gerar-pix", e.response?.data || e.message || e);
    res.status(500).json({
      error: e.response?.data?.errors?.[0]?.description || e.response?.data?.message || e.message || "Erro ao gerar PIX",
      detail: e.response?.data || { message: e.message },
    });
  }
});

// Confirma e ativa a assinatura depois que o PIX foi pago — reconfere o
// status direto na Asaas (nunca confia só no que o front informou de volta)
// antes de gravar em "assinaturas". Idempotente: se chamado de novo pra um
// pagamento já ativado, só regrava os mesmos dados (upsert).
app.post("/api/assinatura/confirmar-pix", async (req, res) => {
  const { paymentId, titularTipo, titularEmail, plano, customerId } = req.body || {};
  if (!paymentId || !titularTipo || !titularEmail || !plano)
    return res.status(400).json({ error: "dados_incompletos" });
  const planoInfo = PLANOS_ASSINATURA[plano];
  if (!planoInfo) return res.status(400).json({ error: "Plano inválido" });

  try {
    const { data: pay } = await asaas.get(`/payments/${paymentId}`);
    if (!["CONFIRMED", "RECEIVED"].includes(pay.status)) {
      return res.status(402).json({ error: "pagamento_nao_confirmado", status: pay.status });
    }

    const { proximaCobranca } = await ativarAssinatura({
      titularTipo, titularEmail, plano, paymentId,
      customerId: customerId || pay.customer,
    });

    log("ASSINATURA PIX ATIVADA", { titularEmail, plano, paymentId });
    res.json({
      success: true,
      status: "ativa",
      valor: planoInfo.valor,
      proximaCobranca: proximaCobranca.toISOString(),
      paymentId,
    });
  } catch (e) {
    log("ERRO assinatura/confirmar-pix", e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data?.message || e.message || "Erro ao confirmar pagamento" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CONFIRMAR SERVIÇO (profissional) — único jeito de gravar
// pedidos.aceite_formal_profissional_em (trigger trg_lock_aceite_formal_profissional
// no Postgres barra escrita direta via chave anon, ver
// supabase_lock_aceite_formal_profissional_migration.sql). É aqui que mora a
// regra de acesso de verdade: categoria já foi filtrada no mural (frontend),
// mas plano ativo / valor máximo / cota mensal só valem se checados aqui —
// o frontend é só UX, quem confia cegamente no client pode ser burlado.
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/pedidos/confirmar-servico", async (req, res) => {
  const { pedidoId, profissionalEmail, dataAgendada } = req.body || {};
  if (!pedidoId || !profissionalEmail)
    return res.status(400).json({ error: "dados_incompletos" });

  try {
    const { data: pedido, error: errPedido } = await supabase
      .from("pedidos")
      .select("id,profissional_aceito,valor,status,data_agendada,aceite_formal_profissional_em")
      .eq("id", pedidoId)
      .maybeSingle();
    if (errPedido) throw errPedido;
    if (!pedido) return res.status(404).json({ error: "pedido_nao_encontrado" });
    if (pedido.profissional_aceito !== profissionalEmail)
      return res.status(403).json({ error: "nao_autorizado" });

    // Idempotente: se já confirmou antes (ex.: retry de rede), não conta de novo.
    if (pedido.aceite_formal_profissional_em) {
      return res.json({ success: true, aceiteFormalEm: pedido.aceite_formal_profissional_em, jaConfirmado: true });
    }

    const { data: assinatura, error: errAssinatura } = await supabase
      .from("assinaturas")
      .select("plano,status,inicio")
      .eq("titular_tipo", "usuario")
      .eq("titular_email", profissionalEmail)
      .maybeSingle();
    if (errAssinatura) throw errAssinatura;
    if (!assinatura || !["trial", "ativa"].includes(assinatura.status))
      return res.status(403).json({ error: "sem_plano_ativo" });

    const limite = PLANO_LIMITES_USUARIO[assinatura.plano];
    if (!limite) return res.status(403).json({ error: "sem_plano_ativo" });

    if (limite.valorMaxServico != null && pedido.valor != null && pedido.valor > limite.valorMaxServico) {
      return res.status(403).json({
        error: "valor_excede_plano",
        plano: assinatura.plano,
        valorMaxServico: limite.valorMaxServico,
        valorServico: pedido.valor,
      });
    }

    if (limite.maxServicosMes != null) {
      const cicloInicio = cicloAtualInicio(assinatura.inicio);
      const { count, error: errCount } = await supabase
        .from("pedidos")
        .select("id", { count: "exact", head: true })
        .eq("profissional_aceito", profissionalEmail)
        .not("aceite_formal_profissional_em", "is", null)
        .gte("aceite_formal_profissional_em", cicloInicio.toISOString());
      if (errCount) throw errCount;
      if ((count || 0) >= limite.maxServicosMes) {
        return res.status(403).json({
          error: "quota_excedida",
          plano: assinatura.plano,
          maxServicosMes: limite.maxServicosMes,
          usados: count || 0,
        });
      }
    }

    const updates = { aceite_formal_profissional_em: new Date().toISOString() };
    if (!pedido.data_agendada && dataAgendada) updates.data_agendada = dataAgendada;

    const { error: errUpdate } = await supabase.from("pedidos").update(updates).eq("id", pedidoId);
    if (errUpdate) throw errUpdate;

    log("SERVICO CONFIRMADO", { pedidoId, profissionalEmail, plano: assinatura.plano });
    res.json({ success: true, aceiteFormalEm: updates.aceite_formal_profissional_em });
  } catch (e) {
    log("ERRO pedidos/confirmar-servico", e.message || e);
    res.status(500).json({ error: e.message || "Erro ao confirmar serviço" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — Documentação do profissional (protegido por x-admin-key, mesmo
// padrão de /api/admin/usuarios). Único jeito de um documento virar
// "verified"/"rejected" — o trigger trg_lock_doc_status no Postgres também
// bloqueia isso vindo de qualquer sessão que não seja service_role, então
// mesmo sem esse endpoint um usuário não consegue se auto-aprovar.
// ════════════════════════════════════════════════════════════════════════════
app.get("/api/admin/documentos", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.EMAIL_ADMIN_KEY)
    return res.status(401).json({ error: "Não autorizado" });
  const { data, error } = await supabase.from("usuarios")
    .select("email,name,doc_rg_status,doc_rg_url,doc_crim_status,doc_crim_url,doc_address_status,doc_address_url,autonomia_aceita_em")
    .eq("role", "professional")
    .or("doc_rg_status.eq.analysis,doc_crim_status.eq.analysis,doc_address_status.eq.analysis");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ total: data?.length || 0, documentos: data });
});

app.post("/api/admin/documentos/verificar", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.EMAIL_ADMIN_KEY)
    return res.status(401).json({ error: "Não autorizado" });
  const { email, docId, aprovado } = req.body || {};
  if (!email || !["rg", "crim", "address"].includes(docId) || typeof aprovado !== "boolean")
    return res.status(400).json({ error: "Dados inválidos" });
  const col = `doc_${docId}_status`;
  const { error } = await supabase.from("usuarios").update({ [col]: aprovado ? "verified" : "rejected" }).eq("email", email);
  if (error) return res.status(500).json({ error: error.message });
  log("DOC VERIFICADO", { email, docId, aprovado });
  res.json({ success: true });
});

// ── COBRAR CARTÃO ──────────────────────────────────────────
app.post("/api/cobrar-cartao", async (req, res) => {
  const { email, name, phone, plan, cardNumber, cardHolder, expiryMonth, expiryYear, cvv, cpf, installments } = req.body;
  if (!email || !cardNumber) return res.status(400).json({ error: "Dados incompletos" });
  const { data: userData } = await supabase.from("users").select("customer_id").eq("email", email).maybeSingle();
  const customerId = userData?.customer_id;
  if (!customerId) return res.status(400).json({ error: "Cliente não encontrado" });
  const planMap = { monthly: 29.90, quarterly: 69.90, annual: 199.90 };
  const value = planMap[plan] || 29.90;
  try {
    const r = await axios.post(`${ASAAS_BASE}/payments`, {
      customer: customerId, billingType: "CREDIT_CARD", value,
      dueDate: new Date().toISOString().split("T")[0],
      creditCard: { holderName: cardHolder, number: cardNumber, expiryMonth, expiryYear, ccv: cvv },
      creditCardHolderInfo: { name: cardHolder, email, phone: phone || "11999999999", cpfCnpj: "52998224725", postalCode: "01310100", addressNumber: "1" },
      installmentCount: installments || 1, installmentValue: value, description: `Multi PRO - ${plan}`
    }, { headers: { access_token: process.env.ASAAS_API_KEY } });
    if (r.data.status === "CONFIRMED" || r.data.status === "RECEIVED") {
      await supabase.from("users").update({ is_pro: true, payment_id: r.data.id }).eq("email", email);
    }
    res.json({ success: true, status: r.data.status, paymentId: r.data.id });
  } catch(e) {
    console.error("[CARTAO ERROR]", JSON.stringify(e.response?.data || e.message));
    res.status(500).json({ error: e.response?.data?.errors?.[0]?.description || e.response?.data?.message || "Erro no cartão", detail: e.response?.data });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — 2026-08-07: todas as rotas abaixo consultavam "users"/"service_requests",
// tabelas legadas que o app real (App.jsx) nunca escreve — por isso o painel
// mostrava tudo zerado mesmo com contas reais. O app grava em "usuarios" e
// "pedidos" (confirmado direto na API do Supabase); PRO de verdade mora em
// "assinaturas" (status "ativa"), não em "usuarios.pro_plan" (nunca é setado
// pelo fluxo atual — ver [[supabase_multifuncao_project]] no histórico do
// projeto). Ver também [[multi_admin_dashboard_endpoint_mismatch]].
// ════════════════════════════════════════════════════════════════════════════
function checkAdminKey(req, res) {
  if (req.headers["x-admin-key"] !== "multi2026") {
    res.status(401).json({ error: "Não autorizado" });
    return false;
  }
  return true;
}

// ── ADMIN STATS ────────────────────────────────────────────
app.get("/api/admin/stats", async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data: usuarios } = await supabase.from("usuarios").select("role,created_at");
    const { data: assinaturas } = await supabase.from("assinaturas").select("status").eq("status", "ativa");
    const pros = usuarios?.filter(u => u.role === "professional") || [];
    const clients = usuarios?.filter(u => u.role === "client") || [];
    const proAtivos = assinaturas?.length || 0;
    const hoje = new Date().toISOString().split("T")[0];
    const novosHoje = usuarios?.filter(u => u.created_at?.startsWith(hoje)) || [];
    const mrr = proAtivos * 29.90;
    res.json({
      totalUsers: pros.length + clients.length,
      totalPros: pros.length,
      totalClients: clients.length,
      proAtivos,
      mrr: mrr.toFixed(2),
      novosHoje: novosHoje.length,
      receitaEstimada: mrr.toFixed(2)
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN - ASSINANTES PRO ─────────────────────────────────
app.get("/api/admin/assinantes-pro", async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data: ativas } = await supabase.from("assinaturas").select("*").eq("status", "ativa");
    res.json(ativas || []);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/pedidos-hoje', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const hoje = new Date();
    hoje.setHours(0,0,0,0);
    const { data } = await supabase
      .from('pedidos')
      .select('*')
      .gte('created_at', hoje.toISOString())
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/receita', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    // Não existe (ainda) um status "completed"/"concluido" nos pedidos reais —
    // ver GET /api/admin/financial para a agregação que o painel usa hoje.
    const { data } = await supabase
      .from('pedidos')
      .select('*')
      .eq('status', 'completed')
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/clientes', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data } = await supabase
      .from('usuarios')
      .select('*')
      .eq('role', 'client')
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN - PROFISSIONAIS (lista + aprovação) ────────────────
// "approved" é coluna nova (ver supabase_admin_approved_migration.sql) —
// default true (fail-open, mesma postura da mitigação em curso no doc gate).
app.get('/api/admin/professionals', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data: pros, error } = await supabase
      .from('usuarios')
      .select('id,email,name,whatsapp,city,cep,status,pro_plan,categoria_servico,approved,created_at')
      .eq('role', 'professional')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const emails = (pros || []).map(p => p.email).filter(Boolean);
    const [{ data: pedidos }, { data: avaliacoes }] = await Promise.all([
      emails.length
        ? supabase.from('pedidos').select('profissional_aceito,status,valor').in('profissional_aceito', emails)
        : Promise.resolve({ data: [] }),
      emails.length
        ? supabase.from('avaliacoes').select('avaliado_email,estrelas').in('avaliado_email', emails)
        : Promise.resolve({ data: [] }),
    ]);

    const professionals = (pros || []).map(p => {
      const seus = (pedidos || []).filter(x => x.profissional_aceito === p.email);
      const suasAvaliacoes = (avaliacoes || []).filter(x => x.avaliado_email === p.email);
      const rating = suasAvaliacoes.length
        ? (suasAvaliacoes.reduce((s, a) => s + (a.estrelas || 0), 0) / suasAvaliacoes.length)
        : null;
      return {
        id: p.id,
        email: p.email,
        name: p.name,
        whatsapp: p.whatsapp,
        city: p.city,
        cep: p.cep,
        categories: p.categoria_servico || [],
        approved: p.approved !== false, // coluna pode não existir ainda em contas antigas -> trata undefined como aprovado
        is_pro: !!p.pro_plan,
        services_count: seus.length,
        open_services: seus.filter(s => s.status === 'aberto').length,
        revenue: seus.reduce((s, x) => s + (Number(x.valor) || 0), 0),
        rating: rating ? Number(rating.toFixed(1)) : null,
        created_at: p.created_at,
      };
    });
    res.json({ professionals });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/approve-professional', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id é obrigatório' });
  const { error } = await supabase.from('usuarios').update({ approved: true }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  log('PROFISSIONAL APROVADO', { id });
  res.json({ success: true });
});

app.post('/api/admin/reject-professional', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id é obrigatório' });
  const { error } = await supabase.from('usuarios').update({ approved: false }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  log('PROFISSIONAL REPROVADO', { id });
  res.json({ success: true });
});

// ── ADMIN - SERVIÇOS (lista de pedidos) ───────────────────────
app.get('/api/admin/services', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data, error } = await supabase
      .from('pedidos')
      .select('id,status,categoria,descricao,valor,cliente_id,cliente_nome,profissional_aceito,profissional_nome,cidade,cep,created_at')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) return res.status(500).json({ error: error.message });
    const services = (data || []).map(p => ({
      id: p.id,
      status: p.status,
      title: p.descricao ? (p.descricao.length > 80 ? p.descricao.slice(0, 80) + '…' : p.descricao) : p.categoria,
      client_name: p.cliente_nome || p.cliente_id,
      professional_name: p.profissional_nome || p.profissional_aceito,
      location: p.cidade,
      city: p.cidade,
      value: p.valor,
      created_at: p.created_at,
    }));
    res.json({ services });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN - FINANCEIRO ─────────────────────────────────────────
// Estimativa a partir de "assinaturas" (status ativa) — a tabela "payments"
// existe mas está vazia hoje (nenhum webhook Asaas gravou lá ainda), e não há
// status "concluído"/"pago" nos pedidos reais para somar receita de serviços.
app.get('/api/admin/financial', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const [{ data: ativas }, { data: pedidosAbertos, count: pendingPayments }] = await Promise.all([
      supabase.from('assinaturas').select('plano,titular_email,inicio').eq('status', 'ativa'),
      supabase.from('pedidos').select('id', { count: 'exact', head: true }).eq('status', 'aberto'),
    ]);
    const activeSubscriptions = ativas?.length || 0;
    const proRevenue = activeSubscriptions * 29.90;
    res.json({
      totalRevenue: proRevenue.toFixed(2),
      totalWallets: '0,00',
      totalWithdrawals: '0,00',
      proRevenue: proRevenue.toFixed(2),
      pendingPayments: pendingPayments || 0,
      activeSubscriptions,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN - CAMPANHA DE EMAIL (segmentada) ────────────────────
app.post('/api/admin/send-campaign', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { subject, body, target } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'Assunto e mensagem são obrigatórios' });
  try {
    const { data: usuarios } = await supabase.from('usuarios').select('email,name,role');
    const { data: pedidos } = await supabase.from('pedidos').select('cliente_id,profissional_aceito');
    const { data: ativas } = await supabase.from('assinaturas').select('titular_email').eq('status', 'ativa');
    const clientesComPedido = new Set((pedidos || []).map(p => p.cliente_id).filter(Boolean));
    const prosComPedido = new Set((pedidos || []).map(p => p.profissional_aceito).filter(Boolean));
    const emailsPro = new Set((ativas || []).map(a => a.titular_email).filter(Boolean));

    let lista = (usuarios || []).filter(u => u.email);
    if (target === 'clients') lista = lista.filter(u => u.role === 'client');
    else if (target === 'professionals') lista = lista.filter(u => u.role === 'professional');
    else if (target === 'pro') lista = lista.filter(u => emailsPro.has(u.email));
    else if (target === 'no_close_clients') lista = lista.filter(u => u.role === 'client' && !clientesComPedido.has(u.email));
    else if (target === 'no_close_pros') lista = lista.filter(u => u.role === 'professional' && !prosComPedido.has(u.email));
    // target === 'all' (ou ausente): todos os usuários com email

    if (lista.length === 0) return res.status(400).json({ error: 'Nenhum destinatário para esse segmento' });

    let sent = 0, falhas = 0;
    for (let i = 0; i < lista.length; i += 10) {
      const lote = lista.slice(i, i + 10);
      await Promise.allSettled(lote.map(async (dest) => {
        const firstName = dest.name?.split(' ')[0] || '';
        const html = `
          <p style="color:#6B7280;font-size:13px;margin:0 0 4px">Olá, ${firstName}!</p>
          <div style="color:#555;line-height:1.8;font-size:14px">${body.replace(/\n/g, '<br>')}</div>
        `;
        try {
          await sgMail.send({ to: dest.email, from: FROM, subject, html: layout(html) });
          sent++;
        } catch { falhas++; }
      }));
      if (i + 10 < lista.length) await new Promise(r => setTimeout(r, 500));
    }

    log('CAMPANHA ADMIN', { subject, target, sent, falhas, total: lista.length });
    res.json({ ok: true, sent, falhas, total: lista.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// FASE 3 — Lembretes automáticos de agendamento (chamado por cron externo,
// ver .github/workflows/lembretes-cron.yml no repo MULTI). Idempotente via as
// colunas lembrete_*_enviado_em em "pedidos" — pode rodar quantas vezes quiser
// por hora que não manda o mesmo lembrete duas vezes.
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/cron/lembretes", async (req, res) => {
  if (req.headers["x-cron-key"] !== process.env.CRON_KEY) {
    return res.status(401).json({ error: "Não autorizado" });
  }

  const resumo = { processados: 0, notificados: 0, erros: [] };

  try {
    const { data: pedidos, error } = await supabase
      .from("pedidos")
      .select("id,categoria,cliente_id,profissional_aceito,data_agendada,lembrete_vespera_enviado_em,lembrete_dia_enviado_em,lembrete_pos_enviado_em")
      .in("status", ["em_andamento", "executando"])
      .not("data_agendada", "is", null)
      .not("aceite_formal_cliente_em", "is", null)
      .not("aceite_formal_profissional_em", "is", null);
    if (error) throw error;

    const agora = new Date();
    const hojeStr = agora.toISOString().slice(0, 10);
    const amanha = new Date(agora);
    amanha.setDate(amanha.getDate() + 1);
    const amanhaStr = amanha.toISOString().slice(0, 10);

    for (const p of (pedidos || [])) {
      resumo.processados++;
      const dataAgendada = new Date(p.data_agendada);
      const dataStr = dataAgendada.toISOString().slice(0, 10);

      let tipo = null;
      if (dataStr === amanhaStr && !p.lembrete_vespera_enviado_em) tipo = "vespera";
      else if (dataStr === hojeStr && !p.lembrete_dia_enviado_em) tipo = "dia";
      else if (agora.getTime() > dataAgendada.getTime() + 2 * 60 * 60 * 1000 && !p.lembrete_pos_enviado_em) tipo = "pos";
      if (!tipo) continue;

      try {
        const emails = [p.cliente_id, p.profissional_aceito].filter(Boolean);
        const [{ data: usuarios }, { data: empresas }] = await Promise.all([
          supabase.from("usuarios").select("onesignal_player_id").in("email", emails).not("onesignal_player_id", "is", null),
          supabase.from("empresas").select("onesignal_player_id").in("email", emails).not("onesignal_player_id", "is", null),
        ]);
        const playerIds = [...new Set([...(usuarios || []), ...(empresas || [])].map(u => u.onesignal_player_id).filter(Boolean))];

        const textos = {
          vespera: `🔔 Lembrete: seu serviço de ${p.categoria} está agendado pra amanhã.`,
          dia:     `📅 Hoje é o dia do seu serviço de ${p.categoria}.`,
          pos:     `✅ O serviço de ${p.categoria} foi realizado? Confirma no app.`,
        };

        let oneSignalResp = null;
        if (playerIds.length) {
          const r = await fetch("https://onesignal.com/api/v1/notifications", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.ONESIGNAL_API_KEY },
            body: JSON.stringify({
              app_id: process.env.ONESIGNAL_APP_ID,
              include_player_ids: playerIds,
              headings: { pt: "Multi" },
              contents: { pt: textos[tipo] },
              // Só o lembrete pós-horário leva direto pra tela de confirmar
              // conclusão (Fase 4) — cada dispositivo abre a tela certa
              // (cliente/profissional) sozinho, pelo próprio papel logado.
              ...(tipo === "pos" ? { url: "https://multifuncao.com.br/?tela=concluir&pedido=" + p.id } : {}),
            }),
          });
          oneSignalResp = await r.json();
          resumo.notificados += playerIds.length;
        }

        const campo = tipo === "vespera" ? "lembrete_vespera_enviado_em" : tipo === "dia" ? "lembrete_dia_enviado_em" : "lembrete_pos_enviado_em";
        await supabase.from("pedidos").update({ [campo]: new Date().toISOString() }).eq("id", p.id);

        console.log(`[LEMBRETES] pedido ${p.id} — ${tipo} — players: ${playerIds.length}`, oneSignalResp?.id || oneSignalResp?.errors || "");
      } catch (e) {
        resumo.erros.push({ pedido: p.id, erro: e.message });
      }
    }

    res.json(resumo);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
