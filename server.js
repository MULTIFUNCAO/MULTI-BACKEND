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
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
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
      cpfCnpj: "52998224725",
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
  const { data } = await supabase.from("users").select("*").order("created_at", { ascending: false });
  res.json({ total: data?.length || 0, users: data });
});

app.get("/api/admin/pagamentos", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.EMAIL_ADMIN_KEY)
    return res.status(401).json({ error: "Não autorizado" });
  const { data } = await supabase.from("payments").select("*").order("created_at", { ascending: false });
  res.json({ total: data?.length || 0, payments: data });
});

// ════════════════════════════════════════════════════════════════════════════
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
      if (authError.message.includes("already registered"))
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
      console.log("[WEBHOOK] PRO ativado para payment_id:", paymentId);
    }
  }
  res.sendStatus(200);
});
