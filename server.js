/**
 * Multi Funcao — Backend Node.js + Supabase
 * Versão com banco de dados persistente
 */

require("dotenv").config();
const express  = require("express");
const axios    = require("axios");
const cors     = require("cors");
const crypto   = require("crypto");
const sgMail   = require("@sendgrid/mail");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const allowedOrigins = [process.env.FRONTEND_URL, "https://floragestao.com.br", "https://localhost", "capacitor://localhost", "http://localhost"].filter(Boolean);
// Aceita também a variante com/sem "www." de FRONTEND_URL. Achado
// 2026-08-24: cliente reportou "Failed to fetch" travado em "Criando
// conta..." no site; www.multifuncao.com.br serve o site normalmente (sem
// redirect pro domínio raiz), mas só "https://multifuncao.com.br" (sem www)
// estava na lista — qualquer visitante que chegasse pelo www tinha TODA
// chamada de API bloqueada por CORS, confirmado reproduzindo direto com
// curl contra o backend em produção (204 sem www, 500 com www).
if (process.env.FRONTEND_URL) {
  try {
    const u = new URL(process.env.FRONTEND_URL);
    const altHost = u.hostname.startsWith("www.") ? u.hostname.slice(4) : "www." + u.hostname;
    allowedOrigins.push(`${u.protocol}//${altHost}`);
  } catch (_) { /* FRONTEND_URL mal formada — ignora, resto da lista continua valendo */ }
}
// Previews do Vercel (deploy de teste do MULTI antes de ir pra produção)
// ganham uma URL aleatória tipo https://multi-<hash>-anacristinal1401-2650s-projects.vercel.app
// a cada "vercel deploy" — não dá pra colocar fixo em allowedOrigins. Libera
// só esse padrão específico do projeto, não *.vercel.app inteiro.
const previewOriginRegex = /^https:\/\/multi-[a-z0-9]+-anacristinal1401-2650s-projects\.vercel\.app$/;
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // requisições sem Origin (curl, server-to-server)
    if (!allowedOrigins.length) return callback(null, true);
    if (allowedOrigins.includes(origin) || previewOriginRegex.test(origin)) return callback(null, true);
    // callback(null, false) em vez de callback(new Error(...)): nega sem
    // acionar o error handler padrão do Express (que respondia 500 genérico
    // pra origem simplesmente não-permitida, poluindo os logs do Render
    // como se fosse erro de servidor).
    callback(null, false);
  },
}));
app.use(express.json());

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Client efêmero, sem estado, só para `auth.signInWithPassword()` (cadastro/
// login). Incidente 2026-08-10: usar `supabase.auth.signInWithPassword()`
// nesse client compartilhado acima troca o header Authorization dele pro
// JWT do usuário comum que acabou de logar — supabase-js escuta o próprio
// auth state e propaga pro client de REST inteiro. Depois disso, TODO
// `supabase.from(...)` seguinte (enderecos/cartoes/users/payments, que
// dependem do service_role pra passar pela RLS "Negar acesso publico") passa
// a sair autenticado como aquele usuário comum e cai na mesma policy de
// negação, com "new row violates row-level security policy". Sintoma:
// funciona só logo após um restart/deploy (client "virgem"), e quebra de
// novo assim que qualquer pessoa loga ou se cadastra — não é bug de chave
// nem de RLS, era o client de auth compartilhado sendo "logado" como
// usuário comum. `persistSession`/`autoRefreshToken` desligados porque esse
// client só serve pra emitir um sessionData e ser descartado, não precisa
// manter timers de refresh em segundo plano.
function supabaseAuthOnly() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

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
    // "users" é tabela morta (0 linhas, mesma raiz do bug já mapeado em
    // multi_admin_dashboard_endpoint_mismatch/multi_login_hang_critico na
    // memória) — campanha "todos" sempre voltava lista vazia. Fonte real é
    // "usuarios".
    const { data } = await supabase.from("usuarios").select("name, email").not("email", "is", null);
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
  const key = (process.env.ANTHROPIC_KEY_V2 || process.env.ANTHROPIC_KEY);
  if (!key) return res.status(500).json({ erro: 'ANTHROPIC_KEY não configurada no servidor' });

  const lista = servicos.map(s =>
    `- ${s.nome}${s.categoria ? ' (' + s.categoria + ')' : ''} — R$ ${Number(s.preco).toFixed(2).replace('.', ',')}`
  ).join('\n');

  const prompt = `Você é um assistente de gestão para salões de beleza brasileiros.\nA empresária quer atingir uma meta financeira e selecionou os seguintes serviços:\n${lista}\nDistribua percentuais de demanda realistas entre esses serviços.\nConsidere que serviços mais frequentes (design de sobrancelha, escova, manicure) têm naturalmente maior volume que serviços esporádicos (alongamento, remoção, tratamentos especiais).\nA soma de todos os percentuais deve ser exatamente 1.0.\nResponda SOMENTE em JSON válido, sem texto adicional, sem markdown, sem explicação:\n{"Nome do Serviço": percentual_decimal}`;

  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-5', max_tokens: 512, messages: [{ role: 'user', content: prompt }] },
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
  const key = (process.env.ANTHROPIC_KEY_V2 || process.env.ANTHROPIC_KEY);
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

// ─── Pré-checagem por IA do documento (RG/CNH) ───────────────────────────────
// Disparado pelo próprio frontend (handleFileSelect em App.jsx) logo depois
// que o profissional envia o RG/CNH e o arquivo já está público no Storage.
// Só dá um PARECER pro admin revisar no painel Multi Admin — nunca aprova
// sozinho, nunca toca a coluna "approved" (só approve-professional/
// reject-professional fazem isso). Se a IA falhar por qualquer motivo,
// responde 200 {success:false} — a revisão humana continua funcionando sem
// o apoio da IA, não pode travar o cadastro do profissional.
app.post('/api/documentos/analisar-ia', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email é obrigatório' });
  const key = (process.env.ANTHROPIC_KEY_V2 || process.env.ANTHROPIC_KEY);
  if (!key) return res.status(200).json({ success: false, error: 'ANTHROPIC_KEY não configurada no servidor' });
  // Busca as URLs (frente/verso) aqui no backend, pelo client de
  // service_role — o frontend só manda o email. Evita uma segunda consulta
  // ao Supabase no navegador logo depois do upload, que travou sem erro
  // nenhum em teste (mesma família do bug de lock do supabase-js já visto
  // no login desse projeto).
  const { data: userRow, error: fetchErr } = await supabase.from('usuarios')
    .select('doc_rg_url, doc_rg_url_verso').eq('email', email).maybeSingle();
  if (fetchErr) return res.status(200).json({ success: false, error: fetchErr.message });
  const url = userRow?.doc_rg_url;
  const urlVerso = userRow?.doc_rg_url_verso;
  if (!url) return res.status(200).json({ success: false, error: 'doc_rg_url não encontrado pra esse email' });

  // PDF não entra nesta primeira versão (precisaria de um content block de
  // documento em vez de imagem) — não derruba o fluxo, só não gera parecer.
  if (/\.pdf($|\?)/i.test(url) || (urlVerso && /\.pdf($|\?)/i.test(urlVerso))) {
    return res.json({ success: false, error: 'Análise por IA não cobre PDF ainda' });
  }

  // RG/CNH exige as duas faces — o frontend só chama esta rota depois que
  // frente E verso já foram enviados, mas cobre urlVerso ausente também
  // (chamada antiga/manual com 1 imagem só).
  const imageBlocks = [{ type: 'image', source: { type: 'url', url } }];
  if (urlVerso) imageBlocks.push({ type: 'image', source: { type: 'url', url: urlVerso } });

  const prompt = `Você está revisando um documento de identidade (RG ou CNH) enviado por um profissional se cadastrando numa plataforma de serviços brasileira. A primeira imagem é a FRENTE${urlVerso ? " e a segunda é o VERSO" : ""} do documento. Analise ${urlVerso ? "as duas imagens" : "a imagem"} e responda:
1. É de fato um documento de identidade (RG ou CNH) legível${urlVerso ? " nas duas faces" : ""}?
2. Está cortado, borrado, ou parece print de tela / foto de outra foto (baixa qualidade, reflexo de tela, moiré)?
3. Se der pra ler, qual o nome completo no documento?

Responda SOMENTE em JSON válido, sem markdown, sem texto fora do JSON:
{"status": "ok" | "suspeito" | "ilegivel", "nome_extraido": "nome como aparece no documento, ou null se não der pra ler", "observacoes": "1-2 frases curtas explicando o motivo do status, em português, pro admin decidir rápido"}

Use "ok" só quando o documento estiver claramente legível e íntegro. Use "ilegivel" quando não der pra confirmar nem que é um documento de identidade. Use "suspeito" pra qualquer coisa no meio — corte, borrão leve, indício de print de tela, foto de foto, face faltando, ou qualquer sinal de possível adulteração.`;

  try {
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-5',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [...imageBlocks, { type: 'text', text: prompt }],
        }],
      },
      { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 25000 }
    );
    const txt = r.data?.content?.[0]?.text || '{}';
    const match = txt.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    const status = ['ok', 'suspeito', 'ilegivel'].includes(parsed.status) ? parsed.status : 'suspeito';
    const observacoes = typeof parsed.observacoes === 'string' ? parsed.observacoes.slice(0, 500) : '';

    const { error } = await supabase.from('usuarios').update({
      analise_ia_status: status,
      analise_ia_observacoes: observacoes,
      analise_ia_em: new Date().toISOString(),
    }).eq('email', email);
    if (error) throw error;

    log('DOC ANALISADO POR IA', { email, status });
    res.json({ success: true, status, observacoes });
  } catch (e) {
    console.error('[analisar-ia] Erro:', e.message);
    res.status(200).json({ success: false, error: 'IA indisponível no momento' });
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
    // Loga o usuário recém-criado pra já sair com sessão real do Supabase Auth
    // (mesmo token/refresh_token que /api/auth/login devolve) — sem isso o
    // front tinha que fazer uma segunda chamada de login logo em seguida.
    const { data: sessionData, error: sessionError } = await supabaseAuthOnly().auth.signInWithPassword({ email, password });
    if (sessionError) log("AVISO cadastro sem sessao", sessionError.message);
    log("CADASTRO", { email, role });
    res.json({
      ok: true,
      token: sessionData?.session?.access_token || null,
      refresh_token: sessionData?.session?.refresh_token || null,
      user: { id: authData.user.id, name: firstName, email, role, isPro: role === "professional" },
    });
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
    const { data, error } = await supabaseAuthOnly().auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: "Email ou senha incorretos" });
    const { data: profile } = await supabase.from("users").select("*").eq("email", email).maybeSingle();
    log("LOGIN", { email });
    res.json({ ok: true, token: data.session.access_token, refresh_token: data.session.refresh_token, user: { id: data.user.id, name: profile?.name || email.split("@")[0], email, role: profile?.role || "client", isPro: profile?.is_pro || false } });
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

// Reset senha com codigo 6 digitos via SendGrid — código guardado na tabela
// password_reset_codes (ver supabase_password_reset_codes_migration.sql),
// não mais em memória do processo. Achado 2026-08-18 investigando o caso do
// Jhonatan: o objeto `resetCodes = {}` em memória se perdia em qualquer
// restart do backend (deploy, crash, sleep do Render) — código pendente
// virava inválido sem nenhum aviso pro usuário, mesmo digitando certo.
app.post("/api/auth/solicitar-codigo", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email obrigatorio" });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const { error: dbError } = await supabase.from("password_reset_codes").upsert({ email, code, expires_at: expiresAt });
  if (dbError) return res.status(500).json({ error: "Erro ao gerar codigo" });
  try {
    await sgMail.send({ to: email, from: { name: "Multi Servicos", email: "contato@multifuncao.com.br" }, subject: "Seu codigo de recuperacao - Multi", html: "<h2>Codigo: " + code + "</h2><p>Expira em 15 minutos.</p>" });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: "Erro ao enviar email" }); }
});

app.post("/api/auth/verificar-codigo", async (req, res) => {
  const { email, code, newPassword } = req.body;
  const { data: entry } = await supabase.from("password_reset_codes").select("code, expires_at").eq("email", email).maybeSingle();
  if (!entry) return res.status(400).json({ error: "Nenhum codigo solicitado" });
  if (Date.now() > new Date(entry.expires_at).getTime()) {
    await supabase.from("password_reset_codes").delete().eq("email", email);
    return res.status(400).json({ error: "Codigo expirado" });
  }
  if (entry.code !== code) return res.status(400).json({ error: "Codigo incorreto" });
  try {
    const { data: { users: authUsers } } = await supabase.auth.admin.listUsers();
      const authUser = authUsers?.find(u => u.email === email);
      if (!authUser) return res.status(404).json({ error: "Usuario nao encontrado" });
      const { error } = await supabase.auth.admin.updateUserById(authUser.id, { password: newPassword });
    if (error) throw error;
    await supabase.from("password_reset_codes").delete().eq("email", email);
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
// 2026-08-07: até aqui esse endpoint aceitava QUALQUER POST sem checar se
// veio da Asaas de verdade — achado durante a investigação do painel admin
// (ver [[multi_admin_dashboard_endpoint_mismatch]]). Asaas manda de volta o
// token configurado em Configurações > Integrações > Webhooks no header
// "asaas-access-token" — validamos contra ASAAS_WEBHOOK_TOKEN (setar no
// Render com o MESMO valor cadastrado lá na Asaas). Fail-closed de propósito:
// sem a env var setada, rejeita tudo (401) em vez de aceitar tudo — força
// configurar explicitamente em vez de destravar sozinho.
//
// Nota à parte (não é o motivo da validação, mas fica registrado): a lógica
// abaixo hoje já não teria efeito nenhum mesmo sem essa checagem — ela grava
// em "users" (tabela morta) e em "pedidos.payment_id"/"phase" (colunas que
// não existem no schema real). A ativação de PRO de verdade acontece só em
// ativarAssinatura(), chamada por /api/assinatura/cobrar e /confirmar-pix,
// que reconferem o pagamento direto na Asaas antes de gravar.
app.post("/api/webhook-asaas", async (req, res) => {
  const token = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!token || req.headers["asaas-access-token"] !== token) {
    console.warn("[WEBHOOK] Token ausente ou inválido — requisição rejeitada");
    return res.status(401).json({ error: "Não autorizado" });
  }

  const { event, payment } = req.body;
  console.log("[WEBHOOK]", event, payment?.id, payment?.subscription || "");

  // Renovação de uma assinatura Multi (Autônomo/Pro/Premium) — a Asaas
  // cobrou sozinha o ciclo seguinte (ver /api/assinatura/cobrar, que agora
  // cria a cobrança como POST /subscriptions em vez de /payments avulso).
  // "payment.subscription" só vem preenchido quando o pagamento pertence a
  // uma assinatura recorrente — distingue isso de qualquer outro pagamento
  // avulso que a Asaas possa notificar aqui. Nunca confia em
  // titular_email/plano vindos do payload do webhook (poderia ser forjado
  // até aqui, mesmo com o token validado): busca a linha em "assinaturas"
  // pelo asaas_subscription_id, que é o vínculo real gravado na ativação.
  if ((event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") && payment?.subscription) {
    try {
      const { data: assinatura } = await supabase
        .from("assinaturas").select("titular_tipo,titular_email")
        .eq("asaas_subscription_id", payment.subscription).maybeSingle();
      if (assinatura) {
        const proximaCobranca = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await supabase.from("assinaturas").update({
          status: "ativa",
          expira_em: proximaCobranca.toISOString(),
          proxima_cobranca: proximaCobranca.toISOString(),
          asaas_payment_id: payment.id,
          // Cortesia só valia pro ciclo 1 (se veio de cupom) — uma cobrança
          // confirmada aqui é sempre um ciclo pago de verdade.
          cortesia: false,
        }).eq("titular_tipo", assinatura.titular_tipo).eq("titular_email", assinatura.titular_email);
        console.log("[WEBHOOK] Renovação de assinatura confirmada:", payment.subscription, assinatura.titular_email);
      } else {
        console.warn("[WEBHOOK] Renovação de uma assinatura sem registro em 'assinaturas':", payment.subscription);
      }
    } catch (e) {
      console.error("[WEBHOOK] Erro ao processar renovação:", e.message || e);
    }
  }

  // 2026-08-13: cobrança de renovação que falhou/venceu — antes disso não
  // existia NENHUM handler pra esse evento, então uma assinatura cujo cartão
  // falhasse na renovação ficava "ativa" pra sempre (com proxima_cobranca no
  // passado, mas nada sinalizando isso em lugar nenhum). Marca "inadimplente"
  // (revoga isPro no front — ver App.jsx carregarPlano — e bloqueia limites
  // de plano no backend, que só aceitam status "ativa"/"trial"). Mesmo
  // lookup por asaas_subscription_id do bloco de renovação acima, mesmo
  // motivo (nunca confiar em titular_email vindo do payload). Recuperação é
  // automática: se a Asaas cobrar de novo com sucesso depois, o bloco de
  // PAYMENT_RECEIVED/CONFIRMED acima já sobrescreve status pra "ativa" de
  // novo, sem precisar de lógica extra aqui.
  // 2026-08-15, achado real: esse handler gravava "vencida" desde que foi
  // criado — não é um valor válido de assinaturas_status_check (só
  // 'trial','pendente','ativa','inadimplente','cancelada','expirada'), então
  // TODO UPDATE aqui falhava com erro 23514, sempre, silenciosamente
  // (capturado pelo catch abaixo, só logado). Nenhuma cobrança atrasada
  // nunca foi marcada de verdade. Trocado pro valor real da constraint.
  if (event === "PAYMENT_OVERDUE" && payment?.subscription) {
    try {
      const { data: assinatura } = await supabase
        .from("assinaturas").select("titular_tipo,titular_email")
        .eq("asaas_subscription_id", payment.subscription).maybeSingle();
      if (assinatura) {
        await supabase.from("assinaturas").update({ status: "inadimplente" })
          .eq("titular_tipo", assinatura.titular_tipo).eq("titular_email", assinatura.titular_email);
        console.log("[WEBHOOK] Assinatura marcada inadimplente:", payment.subscription, assinatura.titular_email);
      } else {
        console.warn("[WEBHOOK] PAYMENT_OVERDUE de uma assinatura sem registro em 'assinaturas':", payment.subscription);
      }
    } catch (e) {
      console.error("[WEBHOOK] Erro ao processar PAYMENT_OVERDUE:", e.message || e);
    }
  }

  // 2026-08-16: removida a lógica antiga que gravava em "users"
  // (tabela morta) e "pedidos.payment_id"/"phase" (colunas que não existem
  // no schema real) — nunca teve efeito real (ver nota histórica no topo
  // deste handler) e, diferente dos dois blocos acima, rodava SEM
  // try/catch em todo evento de pagamento. Investigando a fila da Asaas
  // pausada após 15 falhas em sequência (nenhuma delas deixou rastro nos
  // logs da aplicação, nem nos catch acima — consistente com timeout de
  // cold-start do plano Free do Render, não com uma exceção daqui; ver
  // memória multi_webhook_asaas_fila_pausada), mas um bloco sem try/catch
  // no meio do handler era risco real e desnecessário de qualquer forma.

  // Compra de moeda ("Multi Moeda") — pagamento avulso (nunca tem
  // payment.subscription), reconhecido pelo externalReference
  // "moedas:<email>:<pacoteId>" gravado em /api/moedas/gerar-pix. Fallback
  // pro caso do client fechar o app antes do polling de
  // /api/moedas/confirmar-pix detectar o pagamento — creditar_moedas() é
  // idempotente por paymentId, então não importa qual dos dois chega
  // primeiro, nunca credita em dobro.
  if ((event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") && typeof payment?.externalReference === "string" && payment.externalReference.startsWith("moedas:")) {
    try {
      const [, email, pacoteId] = payment.externalReference.split(":");
      const pacotes = await getPacotesMoedas();
      const pacote = pacotes.find(p => String(p.id) === String(pacoteId));
      if (!pacote) {
        console.warn("[WEBHOOK] Compra de moeda com pacoteId desconhecido:", payment.externalReference);
      } else {
        const { data: saldo, error } = await supabase.rpc("creditar_moedas", {
          p_email: email,
          p_quantidade: pacote.quantidade,
          p_payment_id: payment.id,
          p_tipo: "compra",
          p_descricao: `Compra: ${pacote.nome}`,
        });
        if (error) throw error;
        console.log("[WEBHOOK] Moedas creditadas:", email, pacote.quantidade, "saldo:", saldo);
      }
    } catch (e) {
      console.error("[WEBHOOK] Erro ao processar compra de moeda:", e.message || e);
    }
  }

  res.sendStatus(200);
});

// ── WEBHOOK ASAAS — validação de saque/transferência ───────────────────────
// Mecanismo opcional da Asaas (User Menu > Integrações > Mecanismos de
// Segurança na Asaas): quando ATIVADO LÁ (não confundir com esse endpoint
// existir — a Asaas só chama isso se o mecanismo estiver ligado no painel
// deles), toda transferência/saque solicitado passa a esperar essa validação
// em vez do token SMS/app padrão. A Asaas manda esse POST ~5s depois de cada
// transferência pedida e espera {"status":"APPROVED"} ou
// {"status":"REFUSED","refuseReason":"..."} de volta — se a chamada falhar
// 3x ou não devolver um status válido, a operação é CANCELADA (inclusive
// saque manual pelo painel, se o mecanismo lá estiver marcado pra cobrir
// também a interface web, não só a API).
//
// IMPORTANTE — ainda NÃO ativado no painel da Asaas de propósito (ver
// [[multi_modelo_comissao_pagamento_intermediado]]): nada no backend chama
// POST /transfers ainda (Fase 6 do modelo de comissão não existe), então
// não há nenhuma transferência legítima pra aprovar hoje. Esse endpoint
// existe só pra já estar no ar, testado, ANTES de ativar o mecanismo lá —
// só ativar depois de confirmar que ele responde certo (ver instrução de
// teste no final do arquivo de migration/notas). Até a Fase 6 existir de
// verdade (com pedidos.valor_repasse/pix_key gravados e o transfer.id
// reservado no momento da criação), esse handler RECUSA por padrão —
// fail-closed de propósito, mesmo raciocínio do /api/webhook-asaas de
// pagamento: melhor barrar uma transferência legítima por engano (o
// profissional só ficaria alguns minutos sem receber, corrigível manual)
// do que aprovar automaticamente algo que não conseguimos conferir de
// verdade ainda.
//
// Mesmo padrão de header de auth do webhook de pagamento
// (asaas-access-token), mas token PRÓPRIO — ASAAS_TRANSFER_VALIDATION_TOKEN,
// não o mesmo ASAAS_WEBHOOK_TOKEN do webhook de pagamento, porque são duas
// URLs/configurações separadas no painel da Asaas.
app.post("/api/webhook-asaas-validar-transferencia", async (req, res) => {
  const token = process.env.ASAAS_TRANSFER_VALIDATION_TOKEN;
  if (!token || req.headers["asaas-access-token"] !== token) {
    console.warn("[WEBHOOK-TRANSFER] Token ausente ou inválido — recusando por segurança");
    return res.status(200).json({ status: "REFUSED", refuseReason: "Token de validação ausente ou inválido" });
  }

  const { type, transfer } = req.body || {};
  log("WEBHOOK-TRANSFER recebido", { type, id: transfer?.id, value: transfer?.value, externalReference: transfer?.externalReference });

  // TODO (Fase 6 do modelo de comissão): trocar este REFUSED fixo por uma
  // conferência real — buscar em "pedidos" a linha com
  // repasse_asaas_transfer_id = transfer.id (gravado no momento em que
  // fizemos o POST /transfers), validar que transfer.value bate com
  // pedidos.valor_repasse, que transfer.pixAddressKey bate com o pix_key
  // cadastrado pelo profissional daquele pedido, e que ainda não foi
  // aprovado antes (idempotência). Só então {"status":"APPROVED"}.
  console.warn("[WEBHOOK-TRANSFER] Recusado — Fase 6 (repasse) ainda não implementada, nenhuma transferência é esperada hoje", transfer?.id);
  return res.status(200).json({
    status: "REFUSED",
    refuseReason: "Multi: validação automática ainda não implementada — nenhuma transferência via API é esperada neste momento",
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ASSINATURA (usuarios/empresas + tabela "assinaturas") — cobrança real via
// Asaas, substitui o antigo trial de 7 dias criado direto pelo frontend.
// A tabela "assinaturas" agora só aceita insert/update via service_role (RLS
// travada na migration supabase_pendencias_doc_pagamento_migration.sql) —
// esse endpoint é o ÚNICO jeito de um plano virar "ativa".
// ════════════════════════════════════════════════════════════════════════════
const PLANOS_ASSINATURA = {
  autonomo:     { valor: 29.90,  label: "Multi Autônomo" },
  pro:          { valor: 59.90,  label: "Multi Pro" },
  premium:      { valor: 129.90, label: "Multi Premium" },
  // Planos de empresa parceira, reintroduzidos 2026-08-19 (ver PLANOS_EMPRESA
  // em MULTI/src/App.jsx) — mesmo motor de cobrança do profissional, só troca
  // titularTipo pra "empresa" (a constraint de assinaturas.plano no banco já
  // aceitava esses dois valores mesmo com a monetização de empresa desligada
  // no front, confirmado ao vivo antes de reativar).
  empresa:      { valor: 149.90, label: "Multi Empresa" },
  empresa_plus: { valor: 299.90, label: "Multi Empresa Plus" },
};

// Limites de negócio (categoria/valor/quantidade) por plano do profissional.
// Espelha PLANO_LIMITES_USUARIO em MULTI/src/App.jsx — repos separados, sem
// pacote compartilhado, então qualquer mudança aqui precisa ser replicada
// manualmente lá (e vice-versa). null = sem limite (Premium).
// 2026-08-09: maxCategorias (flat) virou maxGrupos+maxItensPorGrupo (grupo×
// profissões-por-grupo). 2026-08-10: voltou a ser flat (maxCategorias) —
// decisão explícita de manter a reforma comercial separada da reforma de
// 23 grupos/profissões aninhadas (projeto à parte). Só afeta a UI/copy do
// front hoje, este backend nunca aplicou o teto de categoria de fato (só
// maxServicosMes/valorMaxServico são checados abaixo, no endpoint de
// confirmação); mantido em sync mesmo assim pra não divergir do front caso
// um gate real seja adicionado aqui depois.
const PLANO_LIMITES_USUARIO = {
  autonomo: { maxCategorias: 1, maxServicosMes: 3,  valorMaxServico: 5000 },
  pro:      { maxCategorias: 3, maxServicosMes: 10, valorMaxServico: 5000 },
  premium:  { maxCategorias: null, maxServicosMes: null, valorMaxServico: null },
};
// Lê os limites reais de "configuracoes_planos" (fonte única de verdade,
// compartilhada com o front) em vez do objeto hardcoded acima, que agora só
// serve de fallback se a leitura falhar (rede, ou o bug de durabilidade
// desse projeto Supabase). Cache curto pra não bater no banco em toda
// confirmação de serviço — limites de plano mudam raramente (só quando o
// admin ajusta), 60s é sobra.
let _planoLimitesCache = null;
let _planoLimitesCacheEm = 0;
const PLANO_LIMITES_CACHE_TTL_MS = 60_000;
async function getPlanoLimites() {
  const agora = Date.now();
  if (_planoLimitesCache && (agora - _planoLimitesCacheEm) < PLANO_LIMITES_CACHE_TTL_MS) {
    return _planoLimitesCache;
  }
  try {
    const { data, error } = await supabase.from("configuracoes_planos").select("*");
    if (error || !data?.length) throw error || new Error("configuracoes_planos vazia");
    const limites = {};
    for (const row of data) {
      limites[row.plano] = {
        maxCategorias: row.max_categorias,
        maxServicosMes: row.max_servicos_mes,
        valorMaxServico: row.valor_max_servico,
      };
    }
    _planoLimitesCache = limites;
    _planoLimitesCacheEm = agora;
    return limites;
  } catch (e) {
    log("AVISO: falha ao ler configuracoes_planos, usando fallback hardcoded", e.message || e);
    return PLANO_LIMITES_USUARIO;
  }
}

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
async function ativarAssinatura({ titularTipo, titularEmail, plano, paymentId, customerId, subscriptionId, cupomCodigo, cortesia }) {
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
    asaas_subscription_id: subscriptionId || null,
    cupom_codigo: cupomCodigo || null,
    cortesia: !!cortesia,
  }, { onConflict: "titular_tipo,titular_email" });
  if (error) throw error;
  return { proximaCobranca };
}

// ── CUPONS (mês grátis pra quem divulga a plataforma) ───────────────────────
// Reutilizável de propósito (mesmo código serve pra N profissionais) — ver
// supabase_cupons_migration.sql. Só vale pro Multi Autônomo, checado tanto
// aqui (implícito — quem chama já filtra) quanto de novo em
// /api/assinatura/cobrar antes de aplicar, nunca confia só na UI ter
// escondido o campo pros outros planos.
//
// Retorna { ok:false, motivo } em vez de lançar erro pros casos "normais"
// (cupom não existe, expirado, já usado...) — são respostas esperadas do dia
// a dia, não uma falha de sistema; só erro de infra (Supabase fora do ar)
// deve virar exceção de verdade.
async function buscarCupomValido(codigoBruto, titularEmail) {
  const codigo = (codigoBruto || "").trim().toUpperCase();
  if (!codigo) return { ok: false, motivo: "cupom_vazio" };

  const { data: cupom, error } = await supabase.from("cupons").select("*").eq("codigo", codigo).maybeSingle();
  if (error) throw error;
  if (!cupom) return { ok: false, motivo: "cupom_nao_encontrado" };
  if (!cupom.ativo) return { ok: false, motivo: "cupom_inativo" };
  if (cupom.expira_em && new Date(cupom.expira_em) < new Date()) return { ok: false, motivo: "cupom_expirado" };
  if (cupom.usos_maximos != null && cupom.usos_count >= cupom.usos_maximos) return { ok: false, motivo: "cupom_esgotado" };

  const { data: usoExistente, error: errUso } = await supabase
    .from("cupons_usados").select("id").eq("cupom_id", cupom.id).eq("titular_email", titularEmail).maybeSingle();
  if (errUso) throw errUso;
  if (usoExistente) return { ok: false, motivo: "cupom_ja_usado" };

  return { ok: true, cupom };
}

// Registra o uso (insert em cupons_usados + incrementa cupons.usos_count) —
// só chamado DEPOIS que a assinatura já foi ativada de verdade em
// ativarAssinatura(), nunca antes: se o resto da ativação falhar no meio, o
// cupom não é "gasto" à toa. O unique(cupom_id, titular_email) em
// cupons_usados é a trava definitiva contra reuso mesmo sob corrida — este
// try/catch aqui é só pra transformar a violação de unique numa mensagem
// legível, buscarCupomValido() acima já é quem faz a checagem "no caminho feliz".
async function registrarUsoCupom(cupom, titularEmail) {
  const { error } = await supabase.from("cupons_usados").insert({ cupom_id: cupom.id, titular_email: titularEmail });
  if (error) {
    if (error.code === "23505") throw new Error("cupom_ja_usado"); // unique violation
    throw error;
  }
  await supabase.from("cupons").update({ usos_count: cupom.usos_count + 1 }).eq("id", cupom.id);
}

// Validação "leve" pro front dar feedback instantâneo assim que a pessoa
// digita o cupom em EscolherPlanoScreen — NÃO consome o cupom (só
// buscarCupomValido, sem registrarUsoCupom). A validação que decide de
// verdade se ativa o plano de graça acontece de novo, do zero, dentro de
// /api/assinatura/cobrar — esta rota aqui é só UX, nunca autoriza nada sozinha.
app.post("/api/assinatura/validar-cupom", async (req, res) => {
  const { cupom, titularEmail } = req.body || {};
  if (!titularEmail) return res.status(400).json({ error: "titularEmail obrigatório" });
  try {
    const resultado = await buscarCupomValido(cupom, titularEmail);
    res.json(resultado.ok ? { valido: true, tipo: resultado.cupom.tipo } : { valido: false, motivo: resultado.motivo });
  } catch (e) {
    log("ERRO validar-cupom", e.message || e);
    res.status(500).json({ error: "Erro ao validar cupom" });
  }
});

app.post("/api/assinatura/cobrar", async (req, res) => {
  const {
    titularTipo, titularEmail, titularNome, plano, cupom,
    cardNumber, cardHolder, expiryMonth, expiryYear, cvv, cpf, phone,
  } = req.body || {};

  // Planos de empresa voltaram a existir (2026-08-19) — titular_tipo "usuario"
  // (profissional) e "empresa" são os dois aceitos aqui agora, mesmo padrão
  // de validação pros dois (PLANOS_ASSINATURA cruza plano×titularTipo).
  if (titularTipo !== "usuario" && titularTipo !== "empresa")
    return res.status(400).json({ error: "titularTipo inválido" });
  const planoInfo = PLANOS_ASSINATURA[plano];
  if (!planoInfo) return res.status(400).json({ error: "Plano inválido" });
  // Plano de empresa não pode ser cobrado com titularTipo "usuario" e
  // vice-versa — mesmo tipo de checagem cruzada que o CHECK constraint do
  // banco já faz, mas falhar aqui com uma mensagem clara é melhor que deixar
  // o insert em "assinaturas" estourar um erro genérico de constraint lá na
  // frente.
  const planoEhDeEmpresa = plano === "empresa" || plano === "empresa_plus";
  if (planoEhDeEmpresa !== (titularTipo === "empresa"))
    return res.status(400).json({ error: "Plano não corresponde ao tipo de titular" });
  if (!titularEmail || !cardNumber || !cardHolder || !expiryMonth || !expiryYear || !cvv || !cpf)
    return res.status(400).json({ error: "Dados de pagamento incompletos" });

  // Cupom só vale pro Multi Autônomo — mandar cupom junto de outro plano é
  // rejeitado explicitamente em vez de silenciosamente cobrar normal (evita
  // o "testei o cupom e não fez nada, será que tá quebrado?").
  if (cupom && plano !== "autonomo")
    return res.status(400).json({ error: "Cupom vale apenas para o Multi Autônomo" });

  try {
    // Revalida o cupom do zero aqui (nunca confia no /validar-cupom anterior
    // — pode ter expirado/esgotado/sido usado nesse intervalo) e só marca
    // "usado" depois que a assinatura ativar de verdade, lá embaixo.
    let cupomValidado = null;
    if (cupom) {
      const resultado = await buscarCupomValido(cupom, titularEmail);
      if (!resultado.ok) return res.status(400).json({ error: "cupom_invalido", motivo: resultado.motivo });
      cupomValidado = resultado.cupom;
    }

    const customerId = await buscarOuCriarClienteAsaas({ email: titularEmail, nome: titularNome, cpf, phone });

    // A cobrança agora cria uma ASSINATURA de verdade na Asaas (POST
    // /subscriptions), não um pagamento avulso (POST /payments) como era
    // antes — é a própria Asaas quem cobra o mês 2, 3, 4... sozinha, no
    // ciclo MONTHLY, sem precisar guardar cartão nem rodar cron aqui (ver
    // renovação no webhook /api/webhook-asaas, evento PAYMENT_CONFIRMED com
    // "subscription" preenchido). Com cupom válido, nextDueDate vai pra
    // daqui a 30 dias — pula a cobrança do ciclo 1 (cortesia); sem cupom,
    // nextDueDate é hoje, cobra na hora, como sempre foi.
    const hoje = new Date();
    const dataInicioCobranca = cupomValidado
      ? new Date(hoje.getTime() + 30 * 24 * 60 * 60 * 1000)
      : hoje;

    const sub = await asaas.post("/subscriptions", {
      customer: customerId, billingType: "CREDIT_CARD", value: planoInfo.valor,
      nextDueDate: dataInicioCobranca.toISOString().split("T")[0],
      cycle: "MONTHLY",
      creditCard: { holderName: cardHolder, number: cardNumber, expiryMonth, expiryYear, ccv: cvv },
      creditCardHolderInfo: {
        name: cardHolder, email: titularEmail, cpfCnpj: cpf,
        phone: (phone || "").replace(/\D/g, "") || undefined,
        postalCode: "01310100", addressNumber: "1",
      },
      description: `${planoInfo.label} — assinatura mensal`,
    });

    let paymentId = null;
    if (!cupomValidado) {
      // Sem cupom: a Asaas cobra o ciclo 1 na hora, junto da criação da
      // assinatura. Confere de verdade se essa cobrança confirmou antes de
      // liberar o plano — a resposta de POST /subscriptions é só o objeto
      // da assinatura (sempre "sucesso" ali), o status real de pagamento
      // está no primeiro item de /payments?subscription=<id>.
      const { data: pagamentos } = await asaas.get(`/payments?subscription=${sub.data.id}&limit=1`);
      const primeiroPagamento = pagamentos?.data?.[0];
      if (!primeiroPagamento || !["CONFIRMED", "RECEIVED"].includes(primeiroPagamento.status)) {
        log("ASSINATURA COBRANCA PENDENTE", { titularEmail, plano, status: primeiroPagamento?.status, subscriptionId: sub.data.id });
        // Desfaz a assinatura recém-criada na Asaas — sem isso ela ficaria
        // órfã lá (cobrando nos próximos ciclos) sem nunca ter sido ativada
        // aqui, sujeira grave numa integração de cobrança recorrente.
        await asaas.delete(`/subscriptions/${sub.data.id}`).catch(() => {});
        return res.status(402).json({ error: "Pagamento não confirmado", status: primeiroPagamento?.status });
      }
      paymentId = primeiroPagamento.id;
    }

    const { proximaCobranca } = await ativarAssinatura({
      titularTipo, titularEmail, plano, paymentId, customerId,
      subscriptionId: sub.data.id,
      cupomCodigo: cupomValidado?.codigo || null,
      cortesia: !!cupomValidado,
    });

    if (cupomValidado) await registrarUsoCupom(cupomValidado, titularEmail);

    log(cupomValidado ? "ASSINATURA ATIVADA (CORTESIA CUPOM)" : "ASSINATURA ATIVADA", { titularEmail, plano, subscriptionId: sub.data.id, cupom: cupomValidado?.codigo });
    res.json({
      success: true,
      status: "ativa",
      cortesia: !!cupomValidado,
      valor: planoInfo.valor,
      proximaCobranca: proximaCobranca.toISOString(),
      subscriptionId: sub.data.id,
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
//
// Exceção: cupom de mês grátis (2026-08-15). Antes disso o front travava o
// método em "cartao" sempre que tinha cupom aplicado, excluindo quem só usa
// Pix — justamente quem mais precisa poder testar antes de se comprometer.
// Com cupom válido não existe nada pra cobrar no ciclo 1, então nem chega a
// gerar QR Code: ativa a assinatura direto como cortesia (mesmo shape que
// ativarAssinatura() já grava pra cartão+cupom em /cobrar, só que sem
// subscriptionId — Pix nunca teve cobrança recorrente automática na Asaas
// aqui, com ou sem cupom, então o 2º mês cai no mesmo padrão manual que já
// vale pra qualquer assinante Pix hoje).
app.post("/api/assinatura/gerar-pix", async (req, res) => {
  const { titularTipo, titularEmail, titularNome, plano, cpf, phone, cupom } = req.body || {};

  // Mesma regra de /cobrar (planos de empresa voltaram 2026-08-19).
  if (titularTipo !== "usuario" && titularTipo !== "empresa")
    return res.status(400).json({ error: "titularTipo inválido" });
  const planoInfo = PLANOS_ASSINATURA[plano];
  if (!planoInfo) return res.status(400).json({ error: "Plano inválido" });
  const planoEhDeEmpresaPix = plano === "empresa" || plano === "empresa_plus";
  if (planoEhDeEmpresaPix !== (titularTipo === "empresa"))
    return res.status(400).json({ error: "Plano não corresponde ao tipo de titular" });
  if (!titularEmail || !cpf)
    return res.status(400).json({ error: "Dados incompletos" });

  // Mesma regra de /cobrar: cupom só vale pro Multi Autônomo, nunca confia
  // que o front já escondeu o campo pros outros planos.
  if (cupom && plano !== "autonomo")
    return res.status(400).json({ error: "Cupom vale apenas para o Multi Autônomo" });

  try {
    // Revalida do zero (nunca confia no /validar-cupom anterior) — mesmo
    // padrão de /cobrar.
    let cupomValidado = null;
    if (cupom) {
      const resultado = await buscarCupomValido(cupom, titularEmail);
      if (!resultado.ok) return res.status(400).json({ error: "cupom_invalido", motivo: resultado.motivo });
      cupomValidado = resultado.cupom;
    }

    const customerId = await buscarOuCriarClienteAsaas({ email: titularEmail, nome: titularNome, cpf, phone });

    if (cupomValidado) {
      const { proximaCobranca } = await ativarAssinatura({
        titularTipo, titularEmail, plano, paymentId: null, customerId,
        subscriptionId: null,
        cupomCodigo: cupomValidado.codigo,
        cortesia: true,
      });
      await registrarUsoCupom(cupomValidado, titularEmail);

      log("ASSINATURA PIX ATIVADA (CORTESIA CUPOM)", { titularEmail, plano, cupom: cupomValidado.codigo });
      return res.json({
        success: true,
        cortesia: true,
        status: "ativa",
        customerId,
        valor: planoInfo.valor,
        proximaCobranca: proximaCobranca.toISOString(),
      });
    }

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

    const limites = await getPlanoLimites();
    const limite = limites[assinatura.plano];
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
// MOEDAS ("Multi Moeda") — Fase 1 da monetização por moeda: carteira + compra.
// Ainda não gasta moeda em lugar nenhum (isso é Fase 3, o gate de aceite em
// /api/pedidos/confirmar-servico acima) — só permite comprar e consultar
// saldo. saldo_moedas só pode mudar via creditar_moedas() no Postgres (ver
// supabase_moedas_carteira_migration.sql — RPC security definer, EXECUTE
// restrito a service_role, e um trigger que reverte qualquer UPDATE direto
// de saldo_moedas que não venha do service_role).
// ════════════════════════════════════════════════════════════════════════════
const PACOTES_MOEDAS_FALLBACK = [
  { id: "10",  nome: "10 moedas",  quantidade: 10,  preco_centavos: 2500,  ativo: true, ordem: 1 },
  { id: "25",  nome: "25 moedas",  quantidade: 25,  preco_centavos: 5990,  ativo: true, ordem: 2 },
  { id: "50",  nome: "50 moedas",  quantidade: 50,  preco_centavos: 10990, ativo: true, ordem: 3 },
  { id: "100", nome: "100 moedas", quantidade: 100, preco_centavos: 19990, ativo: true, ordem: 4 },
];
// Mesmo padrão de cache de getPlanoLimites() acima — lê "moedas_pacotes" do
// Supabase (fonte única, admin-editável sem precisar mexer em código) com
// cache de 60s, e cai pro fallback hardcoded se a leitura falhar.
let _pacotesMoedasCache = null;
let _pacotesMoedasCacheEm = 0;
async function getPacotesMoedas() {
  const agora = Date.now();
  if (_pacotesMoedasCache && (agora - _pacotesMoedasCacheEm) < PLANO_LIMITES_CACHE_TTL_MS) {
    return _pacotesMoedasCache;
  }
  try {
    const { data, error } = await supabase.from("moedas_pacotes").select("*").eq("ativo", true).order("ordem");
    if (error || !data?.length) throw error || new Error("moedas_pacotes vazia");
    _pacotesMoedasCache = data;
    _pacotesMoedasCacheEm = agora;
    return data;
  } catch (e) {
    log("AVISO: falha ao ler moedas_pacotes, usando fallback hardcoded", e.message || e);
    return PACOTES_MOEDAS_FALLBACK;
  }
}

// Gera a cobrança Pix do pacote de moeda — mesmo template de
// /api/assinatura/gerar-pix (buscarOuCriarClienteAsaas reaproveitado dali).
// externalReference "moedas:<email>:<pacoteId>" é o que o webhook usa pra
// reconhecer esse pagamento como compra de moeda (ver /api/webhook-asaas).
app.post("/api/moedas/gerar-pix", async (req, res) => {
  const { email, nome, cpf, phone, pacoteId } = req.body || {};
  if (!email || !cpf || !pacoteId)
    return res.status(400).json({ error: "dados_incompletos" });

  try {
    // Moeda só serve pra profissional sem plano pagar por resposta a
    // oportunidade — não tem nenhum uso pra quem é só cliente. Achado
    // 2026-08-18: o front tinha um buraco (tela "Escolher plano" acessível
    // direto do Profile de cliente comum, sem checar role nenhum) que deixou
    // um cliente comprar moeda de verdade via PIX, sem nunca ter como usar.
    // Bloqueio aqui é o que realmente impede a cobrança de acontecer — o
    // gate no front (permiteComprarMoedas) evita mostrar a opção, mas
    // qualquer um batendo direto nesse endpoint pulava ele.
    const { data: usuario, error: usuarioErr } = await supabase
      .from("usuarios").select("role").eq("email", email).maybeSingle();
    if (usuarioErr) throw usuarioErr;
    if (!usuario || usuario.role !== "professional")
      return res.status(403).json({ error: "somente_profissional" });

    const pacotes = await getPacotesMoedas();
    const pacote = pacotes.find(p => String(p.id) === String(pacoteId));
    if (!pacote) return res.status(400).json({ error: "pacote_invalido" });

    const customerId = await buscarOuCriarClienteAsaas({ email, nome, cpf, phone });
    const valor = pacote.preco_centavos / 100;

    const pay = await asaas.post("/payments", {
      customer: customerId, billingType: "PIX", value: valor,
      dueDate: new Date().toISOString().split("T")[0],
      description: `${pacote.nome} — Multi Moeda (PIX)`,
      externalReference: `moedas:${email}:${pacote.id}`,
    });

    const qr = await asaas.get(`/payments/${pay.data.id}/pixQrCode`);

    log("MOEDAS PIX GERADO", { email, pacoteId: pacote.id, paymentId: pay.data.id });
    res.json({
      paymentId: pay.data.id,
      customerId,
      pixCode: qr.data.payload,
      qrCodeBase64: qr.data.encodedImage,
      expiresAt: qr.data.expirationDate,
      value: valor,
      quantidade: pacote.quantidade,
    });
  } catch (e) {
    log("ERRO moedas/gerar-pix", e.response?.data || e.message || e);
    res.status(500).json({
      error: e.response?.data?.errors?.[0]?.description || e.response?.data?.message || e.message || "Erro ao gerar PIX",
      detail: e.response?.data || { message: e.message },
    });
  }
});

// Reconfere o pagamento direto na Asaas (nunca confia no client) e credita
// via a RPC creditar_moedas — idempotente: se esse paymentId já creditou
// antes (retry do polling, ou o webhook chegou primeiro), só devolve o saldo
// atual sem duplicar. Mesmo template de /api/assinatura/confirmar-pix.
app.post("/api/moedas/confirmar-pix", async (req, res) => {
  const { paymentId, email, pacoteId } = req.body || {};
  if (!paymentId || !email || !pacoteId)
    return res.status(400).json({ error: "dados_incompletos" });

  try {
    const pacotes = await getPacotesMoedas();
    const pacote = pacotes.find(p => String(p.id) === String(pacoteId));
    if (!pacote) return res.status(400).json({ error: "pacote_invalido" });

    const { data: pay } = await asaas.get(`/payments/${paymentId}`);
    if (!["CONFIRMED", "RECEIVED"].includes(pay.status)) {
      return res.status(402).json({ error: "pagamento_nao_confirmado", status: pay.status });
    }

    const { data: saldo, error } = await supabase.rpc("creditar_moedas", {
      p_email: email,
      p_quantidade: pacote.quantidade,
      p_payment_id: paymentId,
      p_tipo: "compra",
      p_descricao: `Compra: ${pacote.nome}`,
    });
    if (error) throw error;

    log("MOEDAS CREDITADAS", { email, pacoteId: pacote.id, paymentId, saldo });
    res.json({ success: true, saldo, quantidade: pacote.quantidade, paymentId });
  } catch (e) {
    log("ERRO moedas/confirmar-pix", e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data?.message || e.message || "Erro ao confirmar pagamento" });
  }
});

// Gasto de moeda ao responder uma oportunidade (Fase 2 do motor de
// precificação/monetização por moeda) — profissional sem plano pago ativo
// paga custo_moedas do pedido em vez de assinar. Único ponto que chama a RPC
// debitar_moedas (ver supabase_moedas_debito_oportunidade_migration.sql):
// ela mesma lê pedidos.custo_moedas, nunca confia em nada que o client
// mande aqui além do pedidoId — não dá pra manipular quanto vai ser cobrado.
// Idempotente do lado do Postgres (mesmo profissional + mesmo pedido não
// debita duas vezes); esse endpoint só repassa o resultado.
app.post("/api/moedas/responder-oportunidade", async (req, res) => {
  const { email, pedidoId } = req.body || {};
  if (!email || !pedidoId)
    return res.status(400).json({ error: "dados_incompletos" });

  try {
    const { data: saldo, error } = await supabase.rpc("debitar_moedas", {
      p_email: email,
      p_pedido_id: pedidoId,
    });
    if (error) throw error;

    log("MOEDAS DEBITADAS", { email, pedidoId, saldo });
    res.json({ success: true, saldo });
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("saldo_insuficiente")) {
      // Busca o saldo atual pra o front mostrar quanto falta, já que a RPC
      // não retorna nada quando dá exception.
      const { data: usuario } = await supabase.from("usuarios").select("saldo_moedas").eq("email", email).maybeSingle();
      return res.status(402).json({ error: "saldo_insuficiente", saldo: usuario?.saldo_moedas || 0 });
    }
    if (msg.includes("pedido_sem_custo")) {
      return res.status(400).json({ error: "pedido_sem_custo" });
    }
    if (msg.includes("usuario_nao_encontrado")) {
      return res.status(404).json({ error: "usuario_nao_encontrado" });
    }
    log("ERRO moedas/responder-oportunidade", e.response?.data || msg || e);
    res.status(500).json({ error: msg || "Erro ao debitar moeda" });
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
//
// 2026-08-13: a senha do Admin Panel geral morava hardcoded ("multi2026")
// tanto aqui quanto no frontend (AdminDashboard.jsx), que mandava ela crua
// em todo request via header x-admin-key — ou seja, a senha real ficava
// exposta no bundle JS pra qualquer um que abrisse o dev tools. Trocado por
// login por token: POST /api/admin/senha real (ADMIN_PASSWORD, só no
// servidor) devolve um token assinado (HMAC com ADMIN_TOKEN_SECRET, também
// só no servidor, expira em 24h); o frontend nunca mais guarda a senha, só
// o token.
// ════════════════════════════════════════════════════════════════════════════
function signAdminToken() {
  const exp = Date.now() + 1000 * 60 * 60 * 24; // 24h
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.ADMIN_TOKEN_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!process.env.ADMIN_TOKEN_SECRET || typeof token !== "string") return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", process.env.ADMIN_TOKEN_SECRET).update(payload).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

function checkAdminKey(req, res) {
  if (!verifyAdminToken(req.headers["x-admin-key"])) {
    res.status(401).json({ error: "Não autorizado" });
    return false;
  }
  return true;
}

// POST /api/admin/login — única rota que vê a senha real (ADMIN_PASSWORD,
// env var só do servidor, nunca enviada ao bundle do frontend).
app.post("/api/admin/login", (req, res) => {
  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_TOKEN_SECRET) {
    return res.status(500).json({ error: "Admin login não configurado no servidor" });
  }
  const { password } = req.body || {};
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Senha incorreta" });
  }
  res.json({ token: signAdminToken() });
});

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

// 2026-08-18: achado real investigando por que TODA conta cliente aparecia
// em "Não Fecharam" no Admin (Erika/Rafael/Fabio, ver memória) — mesmo
// quem tinha fechado serviço de verdade. Esse endpoint devolvia a linha
// crua de "usuarios", sem nunca calcular "services_count"; o front lia
// c.services_count (sempre undefined) e tratava como 0 pra qualquer
// cliente, sem exceção — a aba "Não Fecharam" nunca foi um filtro real,
// era só "todo mundo". Mesmo padrão de join com "pedidos" que
// /api/admin/professionals já usa pros profissionais. "completed_count"
// é o que a UI passa a usar pra decidir fechou/não fechou (status
// 'concluido' — mesma definição usada na lista de "quem fechou" por
// categoria); "services_count" continua sendo o total de pedidos (aberto
// + em andamento + concluído + cancelado), pra não mudar o que já era
// mostrado como "X serviços" ao lado do nome.
app.get('/api/admin/clientes', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data: clientes, error } = await supabase
      .from('usuarios')
      .select('*')
      .eq('role', 'client')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const emails = (clientes || []).map(c => c.email).filter(Boolean);
    const { data: pedidos } = emails.length
      ? await supabase.from('pedidos').select('cliente_id,status,valor').in('cliente_id', emails)
      : { data: [] };

    const result = (clientes || []).map(c => {
      const seus = (pedidos || []).filter(p => p.cliente_id === c.email);
      const concluidos = seus.filter(p => p.status === 'concluido');
      return {
        ...c,
        services_count: seus.length,
        completed_count: concluidos.length,
        valor_movimentado: concluidos.reduce((s, p) => s + (Number(p.valor) || 0), 0),
      };
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN — EMPRESAS ─────────────────────────────────────────────────────
// Fase 1 do plano de CRM (ver memória multi_admin_crm_plano). Demandas de
// empresa entram na mesma tabela "pedidos" que pedidos de cliente comum —
// NovaDemandaFuncionarioScreen grava cliente_id = email da própria empresa
// (App.jsx) — então dá pra reaproveitar o mesmo join usado acima pra
// clientes, só trocando a tabela de origem pra "empresas". Planos pagos de
// empresa não existem mais (cadastro é sempre grátis agora, ver
// multi_reforma_modelo_comercial) — não expõe status de assinatura/plano
// aqui por não haver mais nada real pra mostrar.
app.get('/api/admin/empresas', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data: empresas, error } = await supabase
      .from('empresas')
      .select('*')
      .order('criado_em', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const emails = (empresas || []).map(e => e.email).filter(Boolean);
    const { data: pedidos } = emails.length
      ? await supabase.from('pedidos').select('cliente_id,status,valor').in('cliente_id', emails)
      : { data: [] };
    // Vínculo empresa <-> profissionais/funcionários é via usuarios.empresa_id
    // (empresa "pro" que também presta serviço) — contagem best-effort, só
    // pra dar o número pedido na spec, não afeta o resto do endpoint se
    // falhar.
    const empresaIds = (empresas || []).map(e => e.id).filter(Boolean);
    const { data: vinculados } = empresaIds.length
      ? await supabase.from('usuarios').select('empresa_id').in('empresa_id', empresaIds)
      : { data: [] };

    const result = (empresas || []).map(e => {
      const suas = (pedidos || []).filter(p => p.cliente_id === e.email);
      const aceitas = suas.filter(p => p.status !== 'aberto' && p.status !== 'cancelado');
      const concluidas = suas.filter(p => p.status === 'concluido');
      return {
        ...e,
        demandas_recebidas: suas.length,
        demandas_aceitas: aceitas.length,
        demandas_concluidas: concluidas.length,
        valor_movimentado: concluidas.reduce((s, p) => s + (Number(p.valor) || 0), 0),
        taxa_conversao: suas.length ? Math.round((concluidas.length / suas.length) * 100) : 0,
        qtd_vinculados: (vinculados || []).filter(v => v.empresa_id === e.id).length,
      };
    });
    res.json({ empresas: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN — CATEGORIAS ───────────────────────────────────────────────────
// Fase 1 do plano de CRM. "Buscas" (o que a spec original pedia como
// primeira coluna) não existe — não há nenhum tracking de busca/visita no
// app hoje (isso é Fase 3, infra de rastreamento nova). O que dá pra
// calcular sem infra nova: solicitações (pedidos por categoria), propostas
// (quantas propostas cada categoria recebeu, via join pedidos->propostas),
// fechamentos (status 'concluido') e conversão. categoria_servico de
// usuarios/empresas é array (profissional pode ter mais de uma); pedidos.
// categoria é sempre um texto único (a categoria daquele pedido
// específico), que é o que importa aqui.
app.get('/api/admin/categorias', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data: pedidos, error } = await supabase
      .from('pedidos')
      .select('id,categoria,status');
    if (error) return res.status(500).json({ error: error.message });

    const pedidoIds = (pedidos || []).map(p => p.id);
    const { data: propostas } = pedidoIds.length
      ? await supabase.from('propostas').select('pedido_id').in('pedido_id', pedidoIds)
      : { data: [] };
    const catByPedidoId = Object.fromEntries((pedidos || []).map(p => [p.id, p.categoria || 'Sem categoria']));

    const porCategoria = {};
    const get = (cat) => (porCategoria[cat] ||= { categoria: cat, solicitacoes: 0, propostas: 0, fechamentos: 0 });

    (pedidos || []).forEach(p => {
      const c = get(p.categoria || 'Sem categoria');
      c.solicitacoes++;
      if (p.status === 'concluido') c.fechamentos++;
    });
    (propostas || []).forEach(pr => {
      const cat = catByPedidoId[pr.pedido_id];
      if (cat) get(cat).propostas++;
    });

    const categorias = Object.values(porCategoria)
      .map(c => ({ ...c, conversao: c.solicitacoes ? Math.round((c.fechamentos / c.solicitacoes) * 100) : 0 }))
      .sort((a, b) => b.solicitacoes - a.solicitacoes);

    res.json({ categorias });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN — OPORTUNIDADES PERDIDAS / "DINHEIRO NA MESA" ──────────────────
// Fase 1 do plano de CRM — o item de maior valor de negócio dos dois
// documentos (doc1 item 3, doc2 quase inteiro), calculável 100% com dados
// que já existem (pedidos/propostas/usuarios), sem precisar da infra de
// tracking da Fase 3. Não cobre "pagamento abandonado" (não existe hoje
// um estado de pagamento parcial por pedido pra detectar isso) — fica pra
// quando essa informação existir.
//
// 3 categorias de pedido parado:
//   sem_proposta        — status 'aberto', zero propostas
//   proposta_sem_resposta — status 'aberto', tem proposta 'pendente', cliente ainda não escolheu
//   parado_pos_aceite   — aceito (confirmado/em_andamento/executando) mas nunca chegou a 'concluido'
// + clientes_reativaveis — já fecharam pelo menos 1 serviço antes, mas
//   sem NENHUM pedido novo (de qualquer status) há mais de 30 dias.
// Não filtra por tempo mínimo aqui (threshold é decisão de UI/negócio,
// não do endpoint) — devolve horas_parado calculado pra cada item, o
// front decide como agrupar/colorir.
app.get('/api/admin/oportunidades', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data: pedidos, error } = await supabase
      .from('pedidos')
      .select('id,cliente_id,cliente_nome,categoria,valor,status,created_at');
    if (error) return res.status(500).json({ error: error.message });

    const abertoIds = (pedidos || []).filter(p => p.status === 'aberto').map(p => p.id);
    const { data: propostasAbertos } = abertoIds.length
      ? await supabase.from('propostas').select('pedido_id,status,created_at').in('pedido_id', abertoIds)
      : { data: [] };
    const propostasPorPedido = {};
    (propostasAbertos || []).forEach(pr => (propostasPorPedido[pr.pedido_id] ||= []).push(pr));

    const clienteEmails = [...new Set((pedidos || []).map(p => p.cliente_id).filter(Boolean))];
    const { data: usuariosData } = clienteEmails.length
      ? await supabase.from('usuarios').select('email,name,whatsapp').in('email', clienteEmails)
      : { data: [] };
    const usuarioPorEmail = Object.fromEntries((usuariosData || []).map(u => [u.email, u]));

    const agora = Date.now();
    const horasDesde = (iso) => iso ? Math.round((agora - new Date(iso).getTime()) / 3600000) : null;

    const itens = [];
    (pedidos || []).forEach(p => {
      const contato = usuarioPorEmail[p.cliente_id] || {};
      const base = {
        pedido_id: p.id,
        cliente_nome: p.cliente_nome || contato.name || 'Sem nome',
        cliente_email: p.cliente_id,
        cliente_whatsapp: contato.whatsapp || null,
        categoria: p.categoria || 'Sem categoria',
        valor: Number(p.valor) || 0,
      };

      if (p.status === 'aberto') {
        const suasPropostas = propostasPorPedido[p.id] || [];
        const pendentes = suasPropostas.filter(pr => pr.status === 'pendente');
        if (suasPropostas.length === 0) {
          itens.push({ ...base, tipo: 'sem_proposta', horas_parado: horasDesde(p.created_at) });
        } else if (pendentes.length > 0) {
          const maisAntiga = pendentes.reduce((min, pr) => (!min || new Date(pr.created_at) < new Date(min.created_at)) ? pr : min, null);
          itens.push({ ...base, tipo: 'proposta_sem_resposta', horas_parado: horasDesde(maisAntiga?.created_at || p.created_at) });
        }
      } else if (['confirmado', 'em_andamento', 'executando'].includes(p.status)) {
        itens.push({ ...base, tipo: 'parado_pos_aceite', horas_parado: horasDesde(p.created_at) });
      }
    });

    // Clientes reativáveis: já fecharam algo antes, sem pedido novo há 30+ dias.
    const porCliente = {};
    (pedidos || []).forEach(p => {
      if (!p.cliente_id) return;
      const c = (porCliente[p.cliente_id] ||= { concluiu: false, ultimoPedidoEm: null });
      if (p.status === 'concluido') c.concluiu = true;
      if (!c.ultimoPedidoEm || new Date(p.created_at) > new Date(c.ultimoPedidoEm)) c.ultimoPedidoEm = p.created_at;
    });
    const reativaveis = Object.entries(porCliente)
      .filter(([, c]) => c.concluiu && horasDesde(c.ultimoPedidoEm) >= 30 * 24)
      .map(([email, c]) => ({
        cliente_email: email,
        cliente_nome: usuarioPorEmail[email]?.name || 'Sem nome',
        cliente_whatsapp: usuarioPorEmail[email]?.whatsapp || null,
        dias_parado: Math.round(horasDesde(c.ultimoPedidoEm) / 24),
      }));

    const resumoTipo = (tipo) => {
      const doTipo = itens.filter(i => i.tipo === tipo);
      return { count: doTipo.length, valor: doTipo.reduce((s, i) => s + i.valor, 0) };
    };
    const semProposta = resumoTipo('sem_proposta');
    const propostaSemResposta = resumoTipo('proposta_sem_resposta');
    const paradoPosAceite = resumoTipo('parado_pos_aceite');

    res.json({
      resumo: {
        sem_proposta: semProposta,
        proposta_sem_resposta: propostaSemResposta,
        parado_pos_aceite: paradoPosAceite,
        clientes_reativaveis: { count: reativaveis.length },
        dinheiro_na_mesa: semProposta.valor + propostaSemResposta.valor + paradoPosAceite.valor,
      },
      itens,
      reativaveis,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN — FUNIL DE SERVIÇOS ─────────────────────────────────────────────
// Fase 1 do plano de CRM. Funil com os status REAIS de "pedidos" nesse
// projeto (aberto/confirmado/em_andamento/executando/concluido/cancelado/
// em_disputa) — a spec original descrevia um funil mais granular
// (solicitado→aguardando profissional→proposta recebida→proposta aceita→
// pagamento pendente→confirmado→agendado→andamento→concluído→avaliação)
// que não bate com o que o app grava de verdade hoje; refletir o funil
// idealizado exigiria mudar o fluxo do app inteiro, fora de escopo.
// Tempos médios usam os marcos reais que já existem: created_at (criado),
// aceite_formal_cliente_em/aceite_formal_profissional_em (aceite formal
// dos dois lados — só conta quando os DOIS estão preenchidos), concluido_em.
app.get('/api/admin/funil', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data: pedidos, error } = await supabase
      .from('pedidos')
      .select('status,created_at,aceite_formal_cliente_em,aceite_formal_profissional_em,concluido_em');
    if (error) return res.status(500).json({ error: error.message });

    const STATUS_LABELS = {
      aberto: 'Aberto', confirmado: 'Confirmado', em_andamento: 'Em andamento',
      executando: 'Executando', concluido: 'Concluído', cancelado: 'Cancelado', em_disputa: 'Em disputa',
    };
    const funilMap = {};
    (pedidos || []).forEach(p => { funilMap[p.status] = (funilMap[p.status] || 0) + 1; });
    const funil = Object.entries(STATUS_LABELS).map(([status, label]) => ({ status, label, count: funilMap[status] || 0 }));

    const horas = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3600000;
    const criadoAteAceite = [];
    const aceiteAteConcluido = [];
    const criadoAteConcluido = [];
    (pedidos || []).forEach(p => {
      const aceiteCompleto = p.aceite_formal_cliente_em && p.aceite_formal_profissional_em
        ? (new Date(p.aceite_formal_cliente_em) > new Date(p.aceite_formal_profissional_em) ? p.aceite_formal_cliente_em : p.aceite_formal_profissional_em)
        : null;
      if (aceiteCompleto && p.created_at) criadoAteAceite.push(horas(p.created_at, aceiteCompleto));
      if (aceiteCompleto && p.concluido_em) aceiteAteConcluido.push(horas(aceiteCompleto, p.concluido_em));
      if (p.created_at && p.concluido_em) criadoAteConcluido.push(horas(p.created_at, p.concluido_em));
    });
    const media = (arr) => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;

    res.json({
      funil,
      tempos_medios_horas: {
        criado_ate_aceite: media(criadoAteAceite),
        aceite_ate_concluido: media(aceiteAteConcluido),
        criado_ate_concluido: media(criadoAteConcluido),
      },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN — RELATÓRIO POR PERÍODO ─────────────────────────────────────────
// Fase 1 do plano de CRM. ?dias=7|30|90 (ou qualquer inteiro). Compara o
// período pedido com o período imediatamente anterior de mesmo tamanho,
// pra dar uma noção de crescimento/queda sem precisar de mais infra.
app.get('/api/admin/relatorio', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const dias = Math.max(1, Math.min(365, parseInt(req.query.dias, 10) || 30));
  try {
    const agora = new Date();
    const inicioAtual = new Date(agora.getTime() - dias * 86400000);
    const inicioAnterior = new Date(agora.getTime() - 2 * dias * 86400000);

    const [{ data: usuarios }, { data: pedidos }] = await Promise.all([
      supabase.from('usuarios').select('role,created_at').gte('created_at', inicioAnterior.toISOString()),
      supabase.from('pedidos').select('status,valor,created_at,concluido_em').gte('created_at', inicioAnterior.toISOString()),
    ]);

    const emPeriodo = (iso, desde, ate) => iso && new Date(iso) >= desde && new Date(iso) < ate;
    const contarUsuarios = (desde, ate) => {
      const doPeriodo = (usuarios || []).filter(u => emPeriodo(u.created_at, desde, ate));
      return {
        clientes: doPeriodo.filter(u => u.role === 'client').length,
        profissionais: doPeriodo.filter(u => u.role === 'professional').length,
        empresas: doPeriodo.filter(u => u.role === 'empresa').length,
        total: doPeriodo.length,
      };
    };
    const contarPedidos = (desde, ate) => {
      const doPeriodo = (pedidos || []).filter(p => emPeriodo(p.created_at, desde, ate));
      const concluidos = doPeriodo.filter(p => p.status === 'concluido');
      const cancelados = doPeriodo.filter(p => p.status === 'cancelado');
      return {
        solicitacoes: doPeriodo.length,
        concluidos: concluidos.length,
        cancelados: cancelados.length,
        taxa_conversao: doPeriodo.length ? Math.round((concluidos.length / doPeriodo.length) * 100) : 0,
        valor_movimentado: concluidos.reduce((s, p) => s + (Number(p.valor) || 0), 0),
      };
    };

    res.json({
      periodo_dias: dias,
      atual: { usuarios: contarUsuarios(inicioAtual, agora), pedidos: contarPedidos(inicioAtual, agora) },
      anterior: { usuarios: contarUsuarios(inicioAnterior, inicioAtual), pedidos: contarPedidos(inicioAnterior, inicioAtual) },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN — CUPONS (mês grátis pra quem divulga a plataforma) ───────────────
// Ver supabase_cupons_migration.sql / buscarCupomValido() / registrarUsoCupom()
// acima. Criação e ativação/desativação são as únicas mudanças de cupom que
// o admin faz por aqui — não existe edição de código/tipo (trocar o código de
// um cupom já divulgado quebraria quem já tem o texto salvo; desativar e
// criar um novo é o caminho certo).
app.get('/api/admin/cupons', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data, error } = await supabase.from('cupons').select('*').order('criado_em', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ cupons: data || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/cupons', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { codigo, tipo, expiraEm, usosMaximos } = req.body || {};
  if (!codigo || !codigo.trim()) return res.status(400).json({ error: 'Código obrigatório' });
  try {
    const { data, error } = await supabase.from('cupons').insert({
      codigo: codigo.trim().toUpperCase(),
      tipo: tipo || 'mes_gratis_autonomo',
      expira_em: expiraEm || null,
      usos_maximos: usosMaximos === '' || usosMaximos == null ? null : Number(usosMaximos),
    }).select().maybeSingle();
    if (error) {
      // 23505 = unique violation (código já existe)
      return res.status(400).json({ error: error.code === '23505' ? 'Já existe um cupom com esse código' : error.message });
    }
    res.json({ cupom: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Único campo editável por aqui é "ativo" — ligar/desligar o cupom sem
// apagar o histórico de quem já usou (cupons_usados referencia cupom_id).
app.patch('/api/admin/cupons/:id', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { ativo } = req.body || {};
  if (typeof ativo !== 'boolean') return res.status(400).json({ error: "Campo 'ativo' (boolean) obrigatório" });
  try {
    const { data, error } = await supabase.from('cupons').update({ ativo }).eq('id', req.params.id).select().maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Cupom não encontrado' });
    res.json({ cupom: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/cupons/:id/usos', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data, error } = await supabase
      .from('cupons_usados').select('*').eq('cupom_id', req.params.id).order('usado_em', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ usos: data || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN - PROFISSIONAIS (lista + aprovação) ────────────────
// "approved" (ver supabase_aprovacao_profissional_ia_migration.sql) agora é
// o único gate real de verdade — default false pra cadastro novo, reforçado
// nos triggers trg_block_online_sem_docs/trg_block_proposta_sem_docs no
// Postgres. approve-professional/reject-professional abaixo são a ÚNICA via
// legítima de mudar isso (trigger trg_lock_approved bloqueia escrita direta
// do client). doc_rg_url + analise_ia_status/observacoes (pré-checagem por
// IA, ver /api/documentos/analisar-ia) vão junto pro painel mostrar o
// documento e o parecer da IA antes do admin decidir.
app.get('/api/admin/professionals', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    // role='professional' sozinho deixava de fora quem passou pelo cadastro
    // profissional (aceitou o termo de autonomia, enviou documentos) mas
    // teve o passo final que grava role interrompido — achado real 2026-08-20
    // (casos Fábio/Junior/Adilson): a conta ficava presa em role='client' e,
    // por causa desse filtro, literalmente invisível aqui, mesmo com docs em
    // análise — só dava pra aprovar mexendo direto no banco. autonomia_aceita_em
    // é setado nesse mesmo passo do cadastro (RegisterScreen/
    // VirarProfissionalScreen em App.jsx), então serve de sinal independente
    // de "entrou no fluxo profissional" mesmo quando role não bateu.
    const { data: pros, error } = await supabase
      .from('usuarios')
      .select('id,email,name,whatsapp,city,cep,status,pro_plan,categoria_servico,approved,role,autonomia_aceita_em,created_at')
      .or('role.eq.professional,autonomia_aceita_em.not.is.null')
      .order('created_at', { ascending: false });
    // DEBUG TEMPORÁRIO 2026-08-20 — remover depois de confirmar o filtro
    // acima ao vivo (achado testando role Thiago/anacristinal1401@gmail.com).
    log('DEBUG professionals', { erro: error?.message || null, total: pros?.length || 0, temThiago: !!(pros || []).find(p => p.id === '7e6a2ff8-0abd-4fea-b02f-5113b5a49b5d') });
    if (error) return res.status(500).json({ error: error.message });

    const emails = (pros || []).map(p => p.email).filter(Boolean);

    // doc_rg_url/doc_rg_url_verso/analise_ia_* são colunas mais novas e já
    // sumiram sozinhas uma vez nesse projeto Supabase (bug de durabilidade
    // documentado — ver supabase_multifuncao_project na memória). Busca à
    // parte, best-effort: se falhar (coluna sumiu de novo), a lista de
    // profissionais e o botão Aprovar/Reprovar continuam funcionando, só
    // sem foto/parecer da IA no card — não pode a lista inteira cair por
    // causa de um campo informativo.
    let docMap = {};
    if (emails.length) {
      const { data: docs, error: docsErr } = await supabase
        .from('usuarios')
        .select('email,doc_rg_url,doc_rg_url_verso,analise_ia_status,analise_ia_observacoes')
        .in('email', emails);
      if (docsErr) {
        console.error('[admin/professionals] doc/IA indisponível (segue sem):', docsErr.message);
      } else {
        docMap = Object.fromEntries((docs || []).map(d => [d.email, d]));
      }
    }

    const [{ data: pedidos }, { data: avaliacoes }, { data: assinaturas }] = await Promise.all([
      emails.length
        ? supabase.from('pedidos').select('profissional_aceito,status,valor').in('profissional_aceito', emails)
        : Promise.resolve({ data: [] }),
      emails.length
        ? supabase.from('avaliacoes').select('avaliado_email,estrelas').in('avaliado_email', emails)
        : Promise.resolve({ data: [] }),
      // 2026-08-13: usuarios.pro_plan é coluna morta (nunca setada pelo fluxo
      // atual — ver [[supabase_multifuncao_project]]). O plano/pagamento real
      // do profissional mora em "assinaturas" (titular_tipo='usuario'),
      // nunca consultada aqui antes — o painel achava que ninguém era PRO.
      emails.length
        ? supabase.from('assinaturas')
            .select('titular_email,plano,status,inicio,expira_em,proxima_cobranca,cortesia,asaas_customer_id')
            .eq('titular_tipo', 'usuario').in('titular_email', emails)
        : Promise.resolve({ data: [] }),
    ]);
    const assinaturaMap = Object.fromEntries((assinaturas || []).map(a => [a.titular_email, a]));

    const professionals = (pros || []).map(p => {
      const docInfo = docMap[p.email] || {};
      const seus = (pedidos || []).filter(x => x.profissional_aceito === p.email);
      const suasAvaliacoes = (avaliacoes || []).filter(x => x.avaliado_email === p.email);
      const rating = suasAvaliacoes.length
        ? (suasAvaliacoes.reduce((s, a) => s + (a.estrelas || 0), 0) / suasAvaliacoes.length)
        : null;

      // paymentStatus: "inadimplente" é setado de verdade pelo webhook
      // (PAYMENT_OVERDUE, ver /api/webhook-asaas) a partir de agora (valor real
      // da constraint — "vencida", usado até 2026-08-15, nunca foi válido, ver
      // nota no handler do webhook). O fallback por data cobre assinaturas que
      // já estavam vencidas ANTES desse handler existir (nunca vão receber o
      // webhook de novo pra corrigir status sozinhas).
      //
      // 2026-08-13, achado real (Teste Categoria QA, thyago_santos86 etc.
      // aparecendo "Pago em dia" sem nunca terem pago nada): status='ativa'
      // sozinho NÃO é prova de pagamento real — várias linhas em
      // "assinaturas" foram gravadas direto por SQL/scripts de teste,
      // pulando ativarAssinatura() (que só roda depois de confirmar o
      // pagamento na Asaas de verdade). asaas_customer_id só existe quando
      // passou pelo fluxo real (buscarOuCriarClienteAsaas, chamado de dentro
      // de ativarAssinatura). "ativa" sem asaas_customer_id E sem cortesia
      // explícita = nunca teve pagamento nenhum por trás, mesmo "ativa" no
      // banco — não pode aparecer como "Pago em dia".
      const assinatura = assinaturaMap[p.email] || null;
      let plano = null, paymentStatus = 'sem_plano';
      if (assinatura) {
        plano = assinatura.plano || null;
        const proximaCobranca = assinatura.proxima_cobranca ? new Date(assinatura.proxima_cobranca).getTime() : null;
        const temVinculoReal = !!assinatura.asaas_customer_id || !!assinatura.cortesia;
        if (assinatura.status === 'cancelada') paymentStatus = 'cancelado';
        else if (assinatura.status === 'inadimplente') paymentStatus = 'vencido';
        else if (assinatura.status === 'ativa' || assinatura.status === 'trial') {
          if (!temVinculoReal) paymentStatus = 'sem_confirmacao';
          else paymentStatus = (proximaCobranca && proximaCobranca < Date.now()) ? 'vencido' : 'pago';
        } else {
          paymentStatus = 'cancelado'; // status desconhecido/futuro — fail-safe, não mostra como "pago"
        }
      }

      return {
        id: p.id,
        email: p.email,
        name: p.name,
        whatsapp: p.whatsapp,
        city: p.city,
        cep: p.cep,
        categories: p.categoria_servico || [],
        approved: p.approved !== false, // undefined (coluna sumiu por bug de durabilidade) -> fail-open, não trata como reprovado
        docRgUrl: docInfo.doc_rg_url || null,
        docRgUrlVerso: docInfo.doc_rg_url_verso || null,
        iaStatus: docInfo.analise_ia_status || null,
        iaObservacoes: docInfo.analise_ia_observacoes || null,
        plano,
        paymentStatus,
        cortesia: !!assinatura?.cortesia,
        proximaCobranca: assinatura?.proxima_cobranca || null,
        pro_since: assinatura?.inicio || null,
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

// ── ADMIN — Extrato de pagamentos de um profissional ──────────────────────
// 2026-08-13: "assinaturas" só guarda o ESTADO ATUAL (upsert por
// titular_tipo+titular_email, 1 linha só — toda renovação sobrescreve a
// anterior). Não existe ledger de pagamentos passados no Supabase, então
// reconstruir um "extrato" local é impossível pra quem já renovou antes de
// hoje. A Asaas já tem o histórico completo de verdade (é o processador
// real) — busca direto de lá em vez de tentar montar isso no banco.
// ── ADMIN — Busca direta na Asaas por email (fora do Supabase) ────────────
// 2026-08-13: achado real — RENATO (renatofonseca794@gmail.com) pagou de
// verdade (log "ASSINATURA ATIVADA" confirma que ativarAssinatura() gravou
// com sucesso na hora), mas a linha em "assinaturas" sumiu depois sozinha
// (bug de durabilidade do Supabase desse projeto, já documentado — ver
// memória — agora confirmado batendo numa tabela de receita, não só
// cosmética). Esse endpoint existe pra reconstruir a assinatura de alguém
// usando a Asaas como fonte de verdade, sem depender do Supabase pra achar
// os IDs (customerId/subscriptionId) — útil tanto pra restaurar o Renato
// agora quanto pra auditar futuros casos do mesmo bug.
app.get('/api/admin/asaas-lookup', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email é obrigatório' });
  try {
    const { data: busca } = await asaas.get(`/customers?email=${encodeURIComponent(email)}`);
    const customer = busca?.data?.[0] || null;
    if (!customer) return res.json({ customer: null, subscriptions: [], payments: [] });

    const [{ data: subs }, { data: pays }] = await Promise.all([
      asaas.get(`/subscriptions?customer=${customer.id}`),
      asaas.get(`/payments?customer=${customer.id}&limit=50`),
    ]);

    res.json({
      customer: { id: customer.id, name: customer.name, email: customer.email, cpfCnpj: customer.cpfCnpj },
      subscriptions: (subs?.data || []).map(s => ({ id: s.id, status: s.status, value: s.value, cycle: s.cycle, nextDueDate: s.nextDueDate, description: s.description })),
      payments: (pays?.data || []).map(p => ({ id: p.id, subscription: p.subscription || null, value: p.value, status: p.status, dueDate: p.dueDate, paymentDate: p.paymentDate || p.clientPaymentDate || null, billingType: p.billingType })),
    });
  } catch (e) {
    console.error('[admin/asaas-lookup] erro:', e.response?.data || e.message || e);
    res.status(500).json({ error: 'Erro ao buscar na Asaas' });
  }
});

// ── ADMIN — Reconciliação Asaas × Supabase ─────────────────────────────────
// 2026-08-13: nasceu do caso do RENATO — pagamento real confirmado na Asaas,
// linha em "assinaturas" sumiu sozinha depois (bug de durabilidade do
// Supabase desse projeto, já documentado, agora confirmado numa tabela de
// receita). Isso é só AUDITORIA — nunca escreve nada, só relata. Corrigir um
// caso encontrado é decisão manual (mesmo processo de hoje: buscar os dados
// reais via /api/admin/asaas-lookup, confirmar com o usuário, só então
// gravar).
//
// Ponto de partida é a ASAAS (não o Supabase) de propósito — um caso como o
// do Renato é invisível se você só olha o que já está no banco; a única
// forma de achar "sumiu" é comparar contra quem realmente pagou.
//
// Limitação conhecida: só olha os últimos `dias` dias (default 90) e até
// 100 pagamentos por status — auditoria pontual pra hoje, não pensada pra
// escala; se o volume crescer bastante, precisa de paginação de verdade.
//
// Auth de escopo mínimo: além do token de admin normal (painel), aceita
// também RECONCILIACAO_API_KEY via header x-reconciliacao-key — pensado pra
// rotina agendada (Claude Code cloud routine) rodar isso sozinha 1x/semana
// sem precisar guardar a senha mestra do Admin Panel numa config de terceiro
// (2026-08-13). Essa chave só abre ESSE endpoint — nunca aprova
// profissional, nunca mexe em dado nenhum, é estritamente leitura.
function checkReconciliacaoAuth(req, res) {
  const chaveEscopo = req.headers['x-reconciliacao-key'];
  if (chaveEscopo && process.env.RECONCILIACAO_API_KEY && chaveEscopo === process.env.RECONCILIACAO_API_KEY) {
    return true;
  }
  return checkAdminKey(req, res);
}

app.get('/api/admin/reconciliacao-assinaturas', async (req, res) => {
  if (!checkReconciliacaoAuth(req, res)) return;
  const dias = Math.max(1, Number(req.query.dias) || 90);
  try {
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [{ data: recebidos }, { data: confirmados }] = await Promise.all([
      asaas.get(`/payments?status=RECEIVED&dateCreated[ge]=${desde}&limit=100`),
      asaas.get(`/payments?status=CONFIRMED&dateCreated[ge]=${desde}&limit=100`),
    ]);
    const pagamentosPorId = new Map();
    for (const p of [...(recebidos?.data || []), ...(confirmados?.data || [])]) pagamentosPorId.set(p.id, p);
    const pagamentos = [...pagamentosPorId.values()];

    const customerIds = [...new Set(pagamentos.map(p => p.customer).filter(Boolean))];
    if (!customerIds.length) return res.json({ periodo_dias: dias, pagamentos_verificados: 0, problemas: [] });

    // Sequencial de propósito (não Promise.all) — evita estourar rate limit
    // da Asaas se o volume crescer; é auditoria manual, não caminho quente.
    const clientes = [];
    for (const id of customerIds) {
      try {
        const { data } = await asaas.get(`/customers/${id}`);
        clientes.push({ id, email: data?.email || null, name: data?.name || null });
      } catch (e) {
        clientes.push({ id, email: null, name: null, erro: true });
      }
    }

    const emails = clientes.map(c => c.email).filter(Boolean);
    const { data: assinaturasEncontradas } = emails.length
      ? await supabase.from('assinaturas').select('titular_email,status,asaas_customer_id').in('titular_email', emails)
      : { data: [] };
    const assinaturaPorEmail = Object.fromEntries((assinaturasEncontradas || []).map(a => [a.titular_email, a]));

    const problemas = [];
    for (const cliente of clientes) {
      if (!cliente.email) {
        problemas.push({ tipo: 'cliente_sem_email', asaasCustomerId: cliente.id });
        continue;
      }
      const assinatura = assinaturaPorEmail[cliente.email];
      const pagamentosDoCliente = pagamentos.filter(p => p.customer === cliente.id)
        .map(p => ({ id: p.id, value: p.value, status: p.status, paymentDate: p.paymentDate || p.clientPaymentDate || null }));
      if (!assinatura) {
        problemas.push({ tipo: 'assinatura_ausente', email: cliente.email, nome: cliente.name, asaasCustomerId: cliente.id, pagamentos: pagamentosDoCliente });
      } else if (assinatura.asaas_customer_id !== cliente.id) {
        problemas.push({ tipo: 'customer_id_divergente', email: cliente.email, nome: cliente.name, asaasCustomerId: cliente.id, supabaseCustomerId: assinatura.asaas_customer_id, supabaseStatus: assinatura.status, pagamentos: pagamentosDoCliente });
      } else if (!['ativa', 'trial', 'pendente', 'inadimplente', 'cancelada', 'expirada'].includes(assinatura.status)) {
        problemas.push({ tipo: 'status_desconhecido', email: cliente.email, nome: cliente.name, supabaseStatus: assinatura.status, pagamentos: pagamentosDoCliente });
      }
    }

    res.json({ periodo_dias: dias, pagamentos_verificados: pagamentos.length, clientes_verificados: customerIds.length, problemas });
  } catch (e) {
    console.error('[admin/reconciliacao-assinaturas] erro:', e.response?.data || e.message || e);
    res.status(500).json({ error: 'Erro ao reconciliar com a Asaas' });
  }
});

app.get('/api/admin/professional-payments', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email é obrigatório' });
  try {
    const { data: assinatura } = await supabase
      .from('assinaturas')
      .select('asaas_customer_id')
      .eq('titular_tipo', 'usuario').eq('titular_email', email).maybeSingle();

    if (!assinatura?.asaas_customer_id) {
      // Nunca teve assinatura registrada -> nunca virou cliente Asaas de
      // verdade -> nunca pagou nada. Lista vazia é a resposta correta, não
      // um erro.
      return res.json({ payments: [] });
    }

    const { data } = await asaas.get(`/payments?customer=${assinatura.asaas_customer_id}&limit=50`);
    const payments = (data?.data || []).map(p => ({
      id: p.id,
      value: p.value,
      status: p.status,
      billingType: p.billingType,
      dueDate: p.dueDate,
      paymentDate: p.paymentDate || p.clientPaymentDate || null,
      description: p.description || null,
      invoiceUrl: p.invoiceUrl || null,
    }));
    res.json({ payments });
  } catch (e) {
    console.error('[admin/professional-payments] erro:', e.response?.data || e.message || e);
    res.status(500).json({ error: 'Erro ao buscar pagamentos na Asaas' });
  }
});

// Crédito manual de moeda — não existia nenhum jeito de repor saldo sem um
// pagamento PIX real de novo (achado ao testar o motor de precificação/gasto
// de moeda ao vivo em produção: gastar 2 moedas de teste deixou a conta de
// review zerada, sem trilha oficial pra repor). Mesma RPC creditar_moedas já
// usada por /api/moedas/confirmar-pix e pelo webhook, só que aqui quem
// autoriza é o admin (x-admin-key), não a Asaas confirmando um pagamento —
// por isso tipo:'credito_admin' em vez de 'compra' (coluna já previa esse
// tipo desde a Fase 1, só nunca tinha endpoint que usasse).
app.post('/api/admin/moedas/creditar-manual', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { email, quantidade, descricao } = req.body || {};
  const qtd = Number(quantidade);
  if (!email || !Number.isInteger(qtd) || qtd <= 0)
    return res.status(400).json({ error: 'email e quantidade (inteiro positivo) são obrigatórios' });

  try {
    const { data: saldo, error } = await supabase.rpc('creditar_moedas', {
      p_email: email,
      p_quantidade: qtd,
      p_tipo: 'credito_admin',
      p_descricao: descricao || 'Crédito manual via admin',
    });
    if (error) throw error;

    log('MOEDAS CRÉDITO ADMIN', { email, quantidade: qtd, saldo });
    res.json({ success: true, saldo });
  } catch (e) {
    log('ERRO admin/moedas/creditar-manual', e.message || e);
    res.status(500).json({ error: e.message || 'Erro ao creditar moeda' });
  }
});

// Reconfere depois do write se os campos realmente gravaram — mitigação pro
// bug de durabilidade recorrente desse projeto Supabase (write responde
// sucesso, mas reverte sozinho segundos depois; um retry imediato costuma
// "pegar" na 2ª tentativa, achado ao vivo com o caso Adilson Ribeiro
// 2026-08-24). Não resolve a causa raiz (infra do Supabase, ticket aberto
// com o suporte), só evita a aprovação "fantasma" que o admin via até agora.
async function updateComVerificacao(tabela, id, campos, camposEsperados, tentativas = 3) {
  let data = null, error = null;
  for (let i = 0; i < tentativas; i++) {
    ({ data, error } = await supabase.from(tabela).update(campos).eq('id', id).select(Object.keys(camposEsperados).join(',')));
    if (error) break;
    const linha = data?.[0];
    const bateu = linha && Object.entries(camposEsperados).every(([k, v]) => linha[k] === v);
    if (bateu) return { data, error: null, tentativasGastas: i + 1, confirmado: true };
    if (i + 1 < tentativas) await new Promise(r => setTimeout(r, 700));
  }
  return { data, error, tentativasGastas: tentativas, confirmado: false };
}

app.post('/api/admin/approve-professional', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id é obrigatório' });
  // doc_rg_status junto com approved: mantém o badge que o profissional vê
  // no próprio Perfil (Pendente/Em análise/Verificado) coerente com a
  // decisão real do admin, sem precisar de UI nova pra isso. Se a coluna
  // sumir de novo (bug de durabilidade já visto nesse projeto), não pode
  // travar a aprovação em si — approved é o gate real, doc_rg_status é só
  // sincronização de badge.
  //
  // role: gravado junto a partir de 2026-08-20 — achado real (casos
  // Fábio/Junior/Adilson) de contas com approved=true sem nunca ter tido
  // role='professional' gravado de verdade (cadastro interrompido antes do
  // passo final que grava isso, ver App.jsx RegisterScreen/
  // VirarProfissionalScreen), o que deixa a conta invisível pro próprio
  // /api/admin/professionals (filtra role='professional') mesmo já
  // aprovada — precisou de 3 correções manuais via SQL Editor até agora.
  // Redundante pro caso normal (role já certo), mas fecha esse buraco pro
  // caso quebrado; seguro porque esse endpoint só é chamado com o id de
  // quem já está no fluxo de aprovação de profissional, nunca de conta
  // empresa.
  let { data, error, tentativasGastas, confirmado } = await updateComVerificacao(
    'usuarios', id,
    { approved: true, role: 'professional', doc_rg_status: 'verified' },
    { approved: true, role: 'professional', doc_rg_status: 'verified' }
  );
  if (error) {
    console.error('[approve-professional] doc_rg_status indisponível, gravando só approved+role:', error.message);
    ({ data, error, tentativasGastas, confirmado } = await updateComVerificacao(
      'usuarios', id,
      { approved: true, role: 'professional' },
      { approved: true, role: 'professional' }
    ));
  }
  if (error) return res.status(500).json({ error: error.message });
  log('PROFISSIONAL APROVADO', { id, linhasAfetadas: data?.length || 0, tentativasGastas, confirmado });
  if (!confirmado) {
    // Reconfirmação pós-write não bateu em nenhuma das tentativas — não é
    // seguro dizer "aprovado" pro admin. Reporta erro em vez de sucesso
    // fantasma; o front deve deixar o botão disponível pra tentar de novo.
    return res.status(502).json({
      error: 'A escrita não foi confirmada após ' + tentativasGastas + ' tentativa(s) — provável instabilidade do Supabase. Tente novamente.',
      debugLinhasAfetadas: data?.length || 0,
      debugLinha: data?.[0] || null,
    });
  }
  // DEBUG TEMPORÁRIO 2026-08-20 — devolve a linha realmente afetada (ou
  // vazio, se 0 linhas bateram no .eq('id', id) — RLS/permissão silenciosa
  // dão exatamente isso, sem erro) pra inspecionar direto no DevTools sem
  // depender dos logs do Render. Remover depois de confirmado.
  res.json({ success: true, debugLinhasAfetadas: data?.length || 0, debugLinha: data?.[0] || null, tentativasGastas });
});

app.post('/api/admin/reject-professional', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id é obrigatório' });
  let { data, error, tentativasGastas, confirmado } = await updateComVerificacao(
    'usuarios', id,
    { approved: false, doc_rg_status: 'rejected' },
    { approved: false, doc_rg_status: 'rejected' }
  );
  if (error) {
    console.error('[reject-professional] doc_rg_status indisponível, gravando só approved:', error.message);
    ({ data, error, tentativasGastas, confirmado } = await updateComVerificacao(
      'usuarios', id,
      { approved: false },
      { approved: false }
    ));
  }
  if (error) return res.status(500).json({ error: error.message });
  log('PROFISSIONAL REPROVADO', { id, tentativasGastas, confirmado });
  if (!confirmado) {
    return res.status(502).json({
      error: 'A escrita não foi confirmada após ' + tentativasGastas + ' tentativa(s) — provável instabilidade do Supabase. Tente novamente.',
    });
  }
  res.json({ success: true, tentativasGastas });
});

// Cancela uma assinatura manualmente — criada pra limpar as duas linhas
// "hacker.teste.claude@"/"hacker2.teste.claude@" achadas na investigação de
// 2026-08-07 (assinaturas "ativa" sem nenhum vínculo com a Asaas, resíduo do
// teste que provou a vulnerabilidade de RLS já corrigida — ver
// [[multi_admin_dashboard_endpoint_mismatch]]). Só cancela quem está "ativa"
// pra não mexer em trial/já cancelada por engano.
app.post('/api/admin/cancel-subscription', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email é obrigatório' });
  const { data, error } = await supabase
    .from('assinaturas')
    .update({ status: 'cancelada' })
    .eq('titular_email', email)
    .eq('status', 'ativa')
    .select('titular_email,status');
  if (error) return res.status(500).json({ error: error.message });
  log('ASSINATURA CANCELADA (admin)', { email, linhasAfetadas: data?.length || 0 });
  res.json({ success: true, updated: data?.length || 0 });
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
    const [{ data: ativas }, { data: pedidosAbertos, count: pendingPayments }, { data: despesas }] = await Promise.all([
      supabase.from('assinaturas').select('plano,titular_email,inicio').eq('status', 'ativa'),
      supabase.from('pedidos').select('id', { count: 'exact', head: true }).eq('status', 'aberto'),
      supabase.from('despesas').select('valor'),
    ]);
    const activeSubscriptions = ativas?.length || 0;
    const proRevenue = activeSubscriptions * 29.90;
    const totalDespesas = (despesas || []).reduce((s, d) => s + (Number(d.valor) || 0), 0);
    res.json({
      totalRevenue: proRevenue.toFixed(2),
      totalWallets: '0,00',
      totalWithdrawals: '0,00',
      proRevenue: proRevenue.toFixed(2),
      pendingPayments: pendingPayments || 0,
      activeSubscriptions,
      totalDespesas: totalDespesas.toFixed(2),
      lucroLiquido: (proRevenue - totalDespesas).toFixed(2),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN — Despesas do negócio (tráfego pago, ferramentas, outros custos) ─
// Ver supabase_despesas_migration.sql. Só entra aqui, admin lança manual —
// não existe integração automática com nenhuma plataforma de anúncio ainda.
app.get('/api/admin/despesas', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { data, error } = await supabase.from('despesas').select('*').order('data', { ascending: false });
    if (error) throw error;
    res.json({ despesas: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/despesas', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  const { data: dataDespesa, categoria, descricao, valor } = req.body || {};
  const valorNum = Number(valor);
  if (!categoria || !valorNum || valorNum <= 0) {
    return res.status(400).json({ error: 'categoria e valor (> 0) são obrigatórios' });
  }
  try {
    const { data, error } = await supabase
      .from('despesas')
      .insert({ categoria, descricao: descricao || null, valor: valorNum, ...(dataDespesa ? { data: dataDespesa } : {}) })
      .select().single();
    if (error) throw error;
    log('DESPESA LANÇADA', { categoria, valor: valorNum });
    res.json({ despesa: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/despesas/:id', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const { error } = await supabase.from('despesas').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
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

    // ── Automação Fase 2 do CRM (multi_admin_crm_plano na memória):
    // lembrete de proposta pendente. Gatilho: pedido aberto com proposta
    // 'pendente' há mais de 3h, cliente ainda não decidiu. Ação: push pro
    // cliente. Reaproveita esse mesmo cron/hora (já existe, roda no
    // Render) em vez de precisar de outro Render Cron Job — mesmo padrão
    // idempotente de coluna *_enviado_em (dispara uma vez só por pedido,
    // não reavisa se depois chegar proposta nova pro mesmo pedido).
    try {
      const { data: abertos } = await supabase
        .from("pedidos")
        .select("id,categoria,cliente_id")
        .eq("status", "aberto")
        .is("lembrete_proposta_enviado_em", null);

      const idsAbertos = (abertos || []).map(p => p.id);
      const { data: propostasPendentes } = idsAbertos.length
        ? await supabase.from("propostas").select("pedido_id,created_at").in("pedido_id", idsAbertos).eq("status", "pendente")
        : { data: [] };
      const maisAntigaPorPedido = {};
      (propostasPendentes || []).forEach(pr => {
        const atual = maisAntigaPorPedido[pr.pedido_id];
        if (!atual || new Date(pr.created_at) < new Date(atual)) maisAntigaPorPedido[pr.pedido_id] = pr.created_at;
      });

      for (const p of (abertos || [])) {
        const propostaEm = maisAntigaPorPedido[p.id];
        if (!propostaEm) continue; // sem proposta nenhuma ainda — não é esse gatilho
        const horasParada = (Date.now() - new Date(propostaEm).getTime()) / 3600000;
        if (horasParada < 3) continue;
        resumo.processados++;
        try {
          const [{ data: usuarios }, { data: empresas }] = await Promise.all([
            supabase.from("usuarios").select("onesignal_player_id").eq("email", p.cliente_id).not("onesignal_player_id", "is", null),
            supabase.from("empresas").select("onesignal_player_id").eq("email", p.cliente_id).not("onesignal_player_id", "is", null),
          ]);
          const playerIds = [...new Set([...(usuarios || []), ...(empresas || [])].map(u => u.onesignal_player_id).filter(Boolean))];

          let oneSignalResp = null;
          if (playerIds.length) {
            const r = await fetch("https://onesignal.com/api/v1/notifications", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.ONESIGNAL_API_KEY },
              body: JSON.stringify({
                app_id: process.env.ONESIGNAL_APP_ID,
                include_player_ids: playerIds,
                headings: { pt: "Multi" },
                contents: { pt: `💰 Você recebeu uma proposta pro seu pedido de ${p.categoria}! Responda antes que o profissional desista.` },
              }),
            });
            oneSignalResp = await r.json();
            resumo.notificados += playerIds.length;
          }

          await supabase.from("pedidos").update({ lembrete_proposta_enviado_em: new Date().toISOString() }).eq("id", p.id);
          console.log(`[LEMBRETES] pedido ${p.id} — proposta_pendente — players: ${playerIds.length}`, oneSignalResp?.id || oneSignalResp?.errors || "");
        } catch (e) {
          resumo.erros.push({ pedido: p.id, erro: e.message });
        }
      }
    } catch (e) {
      resumo.erros.push({ geral: "proposta_pendente", erro: e.message });
    }

    res.json(resumo);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
