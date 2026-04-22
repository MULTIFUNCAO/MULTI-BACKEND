/**
 * Multi Funcao — Backend Node.js (Produção)
 * Asaas PIX + SendGrid + 3 Gatilhos de E-mail
 *
 * Rotas de e-mail:
 *   POST /api/email/boas-vindas   → Cadastro de cliente ou profissional
 *   POST /api/email/servico       → Confirmação de pedido de serviço
 *   POST /api/email/campanha      → Disparo de marketing para lista
 */

require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const sgMail  = require("@sendgrid/mail");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

// ─── SendGrid ────────────────────────────────────────────────────────────────
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const FROM    = "contato@multifuncao.com.br";
const APP_URL = "https://multifuncao.com.br";
const keyPreview = process.env.SENDGRID_API_KEY
  ? process.env.SENDGRID_API_KEY.slice(0,10) + "..." + process.env.SENDGRID_API_KEY.slice(-4)
  : "NÃO DEFINIDA ⚠️";
console.log("[SENDGRID] Chave carregada:", keyPreview);
console.log("[SENDGRID] Remetente from :", FROM);

// ─── Asaas ───────────────────────────────────────────────────────────────────
const ASAAS_BASE = process.env.ASAAS_ENV === "production"
  ? "https://www.asaas.com/api/v3"
  : "https://sandbox.asaas.com/api/v3";

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

// Banco em memória — substitua por banco real em produção
const users = new Map();

function log(tag, data) {
  console.log(`[${new Date().toISOString()}] ${tag}`, JSON.stringify(data));
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
// GATILHO 1 — Boas-Vindas
// POST /api/email/boas-vindas
// Body: { name, email, role: "client" | "professional" }
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/email/boas-vindas", async (req, res) => {
  const { name, email, role } = req.body;
  console.log("[BOAS-VINDAS] Body recebido:", { name, email, role });
  if (!name || !email || !role) {
    console.warn("[BOAS-VINDAS] ⚠️  Campos ausentes:", { name: !!name, email: !!email, role: !!role });
    return res.status(400).json({ error: "name, email e role são obrigatórios" });
  }

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
    <div style="background:#FFF8E1;border-radius:12px;padding:14px 16px;margin:16px 0;border-left:4px solid #F9A825">
      <p style="margin:0;color:#92400E;font-size:13px">💡 <strong>Dica:</strong> Profissionais PRO faturam até 3× mais. Teste 7 dias grátis!</p>
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
    console.log("[BOAS-VINDAS] 📡 Chamando sgMail.send...");
    console.log("[BOAS-VINDAS]    to     :", email);
    console.log("[BOAS-VINDAS]    from   :", FROM);
    console.log("[BOAS-VINDAS]    subject:", subject);
    await sgMail.send({ to: email, from: FROM, subject, html: layout(body) });
    console.log("[BOAS-VINDAS] ✅ SendGrid aceitou o e-mail");
    log("EMAIL BOAS-VINDAS", { email, role });
    res.json({ ok: true, message: `E-mail de boas-vindas enviado para ${email}` });
  } catch (e) {
    const sgErr = e.response?.body || e.message;
    console.error("[BOAS-VINDAS] ❌ Erro SendGrid:", JSON.stringify(sgErr, null, 2));
    console.error("[BOAS-VINDAS]    HTTP status :", e.code || e.response?.status);
    console.error("[BOAS-VINDAS]    Remetente   :", FROM);
    console.error("[BOAS-VINDAS]    Destinatário:", email);
    console.error("[BOAS-VINDAS]    Dica: verifique se o domínio está autenticado no SendGrid");
    log("ERRO boas-vindas", sgErr);
    res.status(500).json({ error: "Falha ao enviar e-mail", detail: sgErr });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GATILHO 2 — Confirmação de Serviço
// POST /api/email/servico
// Body: { name, email, serviceTitle, serviceDesc, serviceValue, serviceLocation }
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/email/servico", async (req, res) => {
  const { name, email, serviceTitle, serviceDesc, serviceValue, serviceLocation } = req.body;
  if (!name || !email || !serviceTitle)
    return res.status(400).json({ error: "name, email e serviceTitle são obrigatórios" });

  const firstName = name.trim().split(" ")[0];
  const protocolo = `MF-${Date.now().toString(36).toUpperCase()}`;
  const dataHoje  = new Date().toLocaleDateString("pt-BR", {
    day:"2-digit", month:"long", year:"numeric", hour:"2-digit", minute:"2-digit",
  });

  const body = `
    <h2 style="color:#1a1a2e;margin:0 0 8px">Pedido recebido! ✅</h2>
    <p style="color:#555;line-height:1.7">
      Olá, <strong>${firstName}</strong>! Seu pedido foi publicado e já está visível para profissionais da sua região.
    </p>
    <div style="background:#F8F9FA;border-radius:12px;padding:20px;margin:20px 0;border:1px solid #E5E7EB">
      <p style="margin:0 0 14px;font-weight:700;color:#1a1a2e">📋 Detalhes do Pedido</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#6B7280;font-size:13px;width:120px">Protocolo</td>
            <td style="padding:6px 0;color:#1a1a2e;font-weight:700;font-size:13px">${protocolo}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;font-size:13px">Serviço</td>
            <td style="padding:6px 0;color:#1a1a2e;font-weight:700;font-size:13px">${serviceTitle}</td></tr>
        ${serviceDesc ? `<tr><td style="padding:6px 0;color:#6B7280;font-size:13px;vertical-align:top">Descrição</td>
            <td style="padding:6px 0;color:#555;font-size:13px">${serviceDesc}</td></tr>` : ""}
        ${serviceValue ? `<tr><td style="padding:6px 0;color:#6B7280;font-size:13px">Orçamento</td>
            <td style="padding:6px 0;color:#007BFF;font-weight:900;font-size:15px">R$ ${serviceValue}</td></tr>` : ""}
        ${serviceLocation ? `<tr><td style="padding:6px 0;color:#6B7280;font-size:13px">Região</td>
            <td style="padding:6px 0;color:#1a1a2e;font-size:13px">📍 ${serviceLocation}</td></tr>` : ""}
        <tr><td style="padding:6px 0;color:#6B7280;font-size:13px">Data</td>
            <td style="padding:6px 0;color:#1a1a2e;font-size:13px">${dataHoje}</td></tr>
      </table>
    </div>
    <div style="background:#FFF8E1;border-radius:12px;padding:14px 16px;margin:16px 0;border-left:4px solid #F9A825">
      <p style="margin:0;color:#92400E;font-size:12px;line-height:1.6">
        ⚠️ <strong>Segurança:</strong> Não faça pagamentos antecipados. Só forneça o PIN de liberação após o serviço concluído.
      </p>
    </div>
    <a href="${APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#007BFF,#0055d4);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700">
      Acompanhar meu pedido →
    </a>
  `;

  try {
    await sgMail.send({
      to: email, from: FROM,
      subject: `✅ Pedido confirmado: ${serviceTitle} — Protocolo ${protocolo}`,
      html: layout(body),
    });
    log("EMAIL SERVICO", { email, serviceTitle, protocolo });
    res.json({ ok: true, protocolo, message: `Confirmação enviada para ${email}` });
  } catch (e) {
    log("ERRO servico", e.response?.body || e.message);
    res.status(500).json({ error: "Falha ao enviar e-mail" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GATILHO 3 — Campanha de Marketing
// POST /api/email/campanha
// Body: { adminKey, subject, titulo, mensagem, cta, ctaUrl, destinatarios }
// destinatarios: [{ name, email }] ou "todos" (usa base de usuários em memória)
// ════════════════════════════════════════════════════════════════════════════
app.post("/api/email/campanha", async (req, res) => {
  const { adminKey, subject, titulo, mensagem, cta, ctaUrl, destinatarios } = req.body;

  if (adminKey !== process.env.EMAIL_ADMIN_KEY)
    return res.status(401).json({ error: "Acesso não autorizado" });

  if (!subject || !titulo || !mensagem)
    return res.status(400).json({ error: "subject, titulo e mensagem são obrigatórios" });

  let lista = [];
  if (destinatarios === "todos") {
    lista = [...users.values()].filter(u => u.email);
  } else if (Array.isArray(destinatarios)) {
    lista = destinatarios.filter(d => d.email);
  }

  if (lista.length === 0)
    return res.status(400).json({ error: "Nenhum destinatário válido" });

  let enviados = 0, falhas = 0;
  const BATCH = 10;

  for (let i = 0; i < lista.length; i += BATCH) {
    const lote = lista.slice(i, i + BATCH);
    await Promise.allSettled(lote.map(async (dest) => {
      const firstName = dest.name?.split(" ")[0] || "";
      const body = `
        <p style="color:#6B7280;font-size:13px;margin:0 0 4px">Olá, ${firstName}!</p>
        <h2 style="color:#1a1a2e;margin:0 0 16px">${titulo}</h2>
        <div style="color:#555;line-height:1.8;font-size:14px">${mensagem.replace(/\n/g, "<br>")}</div>
        ${cta ? `<div style="margin:24px 0">
          <a href="${ctaUrl || APP_URL}" style="display:inline-block;background:linear-gradient(135deg,#FF5722,#E64A19);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700">${cta} →</a>
        </div>` : ""}
        <p style="color:#9CA3AF;font-size:12px;margin-top:24px;border-top:1px solid #E5E7EB;padding-top:16px">
          Para cancelar comunicações: <a href="mailto:${FROM}" style="color:#007BFF">${FROM}</a>
        </p>
      `;
      try {
        await sgMail.send({ to: dest.email, from: FROM, subject, html: layout(body) });
        enviados++;
      } catch { falhas++; }
    }));
    if (i + BATCH < lista.length) await new Promise(r => setTimeout(r, 500));
  }

  log("CAMPANHA", { subject, enviados, falhas, total: lista.length });
  res.json({ ok: true, enviados, falhas, total: lista.length });
});

// ════════════════════════════════════════════════════════════════════════════
// ROTAS ASAAS
// ════════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => res.json({ status:"online", env: process.env.ASAAS_ENV || "sandbox" }));

app.post("/api/criar-cliente", async (req, res) => {
  const { name, phone, email, role } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "name e phone são obrigatórios" });
  const existing = users.get(phone);
  if (existing?.customerId) return res.json({ customerId: existing.customerId });
  try {
    const search = await asaas.get(`/customers?mobilePhone=${phone.replace(/\D/g,"")}`);
    if (search.data.data?.length > 0) {
      const cid = search.data.data[0].id;
      users.set(phone, { customerId:cid, isPro:false, name, email, role });
      return res.json({ customerId: cid });
    }
    const { data } = await asaas.post("/customers", { name, mobilePhone:phone.replace(/\D/g,""), email:email||undefined });
    users.set(phone, { customerId:data.id, isPro:false, name, email, role });
    log("CLIENTE CRIADO", { customerId:data.id });
    // Disparo automático de boas-vindas
    if (email) {
      sgMail.send({ to:email, from:FROM,
        subject: role==="professional" ? "Seja bem-vindo ao Multi PRO! 🚀" : "Bem-vindo ao Multi! 🏠",
        html: layout(`<h2>Olá, ${name.split(" ")[0]}!</h2><p>Sua conta foi criada. <a href="${APP_URL}">Acessar o app →</a></p>`),
      }).catch(() => {});
    }
    res.json({ customerId: data.id });
  } catch (e) {
    log("ERRO criar-cliente", e.response?.data || e.message);
    res.status(500).json({ error: "Erro ao criar cliente" });
  }
});

app.post("/api/gerar-pix", async (req, res) => {
  const { customerId, plan="monthly", phone, name, email } = req.body;
  if (!customerId) return res.status(400).json({ error: "customerId obrigatório" });
  const pd = PLANS[plan] || PLANS.monthly;
  try {
    const pay = await asaas.post("/payments", { customer:customerId, billingType:"PIX", value:pd.value, dueDate:new Date().toISOString().split("T")[0], description:`Multi PRO — Plano ${pd.label}`, externalReference:phone||customerId });
    const qr  = await asaas.get(`/payments/${pay.data.id}/pixQrCode`);
    if (phone) users.set(phone, { ...(users.get(phone)||{}), paymentId:pay.data.id, plan, name, email });
    res.json({ paymentId:pay.data.id, pixCode:qr.data.payload, qrCodeBase64:qr.data.encodedImage, expiresAt:qr.data.expirationDate, value:pd.value, plan:pd.label });
  } catch (e) {
    log("ERRO gerar-pix", e.response?.data || e.message);
    res.status(500).json({ error: "Erro ao gerar PIX" });
  }
});

app.get("/api/status-pagamento/:id", async (req, res) => {
  try {
    const { data } = await asaas.get(`/payments/${req.params.id}`);
    res.json({ status:data.status, isPaid:["RECEIVED","CONFIRMED"].includes(data.status), value:data.value });
  } catch (e) { res.status(500).json({ error: "Erro ao verificar" }); }
});

app.get("/api/usuario/:phone", (req, res) => {
  const u = users.get(req.params.phone);
  res.json({ isPro: u?.isPro||false, plan: u?.plan||null });
});

app.post("/webhook/asaas", (req, res) => {
  res.sendStatus(200);
  const { event, payment } = req.body;
  if (!["PAYMENT_RECEIVED","PAYMENT_CONFIRMED"].includes(event)) return;
  const phone = payment.externalReference;
  if (phone && users.has(phone)) {
    const u = users.get(phone);
    users.set(phone, { ...u, isPro:true });
    log("PRO ATIVADO", { phone });
    if (u.email) {
      sgMail.send({ to:u.email, from:FROM, subject:"🚀 Acesso PRO liberado! Boas vendas!",
        html: layout(`
          <h2>Olá, ${u.name||"Profissional"}! 🎉</h2>
          <p>Seu plano <strong>Multi PRO</strong> foi ativado.</p>
          <div style="background:#F5F3FF;border-radius:12px;padding:16px;margin:16px 0">
            <p style="margin:4px 0">✅ Contatos desbloqueados</p>
            <p style="margin:4px 0">✅ Chat ilimitado</p>
            <p style="margin:4px 0">✅ Selo PRO verificado</p>
          </div>
          <a href="${APP_URL}" style="display:inline-block;background:#7C3AED;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700">Acessar o App →</a>
        `),
      }).catch(() => {});
    }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   Multi Backend — Porta ${PORT}                           ║
║   Asaas:    ${(process.env.ASAAS_ENV||"sandbox").padEnd(42)}║
║   E-mails:  boas-vindas · serviço · campanha          ║
╚═══════════════════════════════════════════════════════╝
  `);
});
