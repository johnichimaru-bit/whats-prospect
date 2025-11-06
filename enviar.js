// === enviar.js (horário comercial + dias úteis + keep-alive) ===
import fs from "fs";
import { setTimeout as wait } from "timers/promises";
import fetch from "node-fetch";
import mensagens from "./mensagens.js";
import dotenv from "dotenv";
import express from "express"; // 👈 keep-alive
dotenv.config();

// === CONFIGURAÇÕES DE ARQUIVOS ===
const CONTACTS_FILE = "./contacts.json";
const LOG_FILE = "./enviar.log";
const PROGRESS_FILE = "./progress.json";

// === VARIÁVEIS DE AMBIENTE ===
const WHATSGW_TOKEN = process.env.WHATSGW_TOKEN;
const WHATSGW_URL =
  process.env.WHATSGW_URL || "https://app.whatsgw.com.br/api/WhatsGw/Send";
const FROM_NUMBER = process.env.FROM_NUMBER || "";

if (!WHATSGW_TOKEN) {
  console.error("ERRO: coloque WHATSGW_TOKEN no .env");
  process.exit(1);
}

// === LEITURA DE CONTATOS ===
let contatos;
try {
  contatos = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8"));
  if (!Array.isArray(contatos)) {
    throw new Error("contacts.json deve ser um array de objetos { nome, numero }");
  }
} catch (err) {
  console.error("ERRO lendo contacts.json:", err.message);
  process.exit(1);
}

// === CONFIGURAÇÕES DE INTERVALO ===
const INTERVALO_MIN_MINUTOS = 15; // mínimo entre mensagens
const INTERVALO_MAX_MINUTOS = 35; // máximo entre mensagens
const TAMANHO_LOTE = 8;           // após 8 mensagens, pausa longa
const PAUSA_LOTE_MIN_MINUTOS = 60; // 1h
const PAUSA_LOTE_MAX_MINUTOS = 120; // 2h

// === HORÁRIO COMERCIAL / DIAS ÚTEIS ===
const BUSINESS_TZ = process.env.BUSINESS_TZ || "America/Sao_Paulo";
const BUSINESS_START = process.env.BUSINESS_START || "08:00"; // HH:mm
const BUSINESS_END = process.env.BUSINESS_END || "21:00";     // HH:mm
const BUSINESS_DAYS = (process.env.BUSINESS_DAYS || "1,2,3,4,5,6")
  .split(",")
  .map(n => Number(n.trim()))
  .filter(n => !Number.isNaN(n)); // 0=Dom ... 6=Sáb

function nowInTZ() {
  const s = new Date().toLocaleString("en-US", { timeZone: BUSINESS_TZ });
  return new Date(s);
}
function parseHM(hm) {
  const [h, m] = hm.split(":").map(Number);
  return { h, m };
}
function isBusinessDay(d = nowInTZ()) {
  return BUSINESS_DAYS.includes(d.getDay());
}
function isWithinBusinessHours() {
  const now = nowInTZ();
  if (!isBusinessDay(now)) return false;
  const { h: sh, m: sm } = parseHM(BUSINESS_START);
  const { h: eh, m: em } = parseHM(BUSINESS_END);
  const start = new Date(now); start.setHours(sh, sm, 0, 0);
  const end   = new Date(now); end.setHours(eh, em, 0, 0);
  return now >= start && now < end;
}
function nextAllowedStartFrom(d) {
  const { h: sh, m: sm } = parseHM(BUSINESS_START);
  let cur = new Date(d);
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(cur);
    candidate.setHours(sh, sm, 0, 0);
    if (isBusinessDay(candidate) && candidate > d) return candidate;
    cur.setDate(cur.getDate() + 1);
  }
  return null;
}
function msUntilNextStart() {
  const now = nowInTZ();
  const { h: sh, m: sm } = parseHM(BUSINESS_START);
  const todayStart = new Date(now); todayStart.setHours(sh, sm, 0, 0);
  if (now < todayStart && isBusinessDay(now)) return todayStart - now;
  const next = nextAllowedStartFrom(now);
  return next ? next - now : 12 * 60 * 60 * 1000; // fallback 12h
}
async function waitForBusinessWindow() {
  if (isWithinBusinessHours()) return;
  const ms = msUntilNextStart();
  const min = Math.ceil(ms / 60000);
  console.log(
    `[scheduler] Fora do horário/dia (${BUSINESS_START}-${BUSINESS_END} ${BUSINESS_TZ} | dias ${BUSINESS_DAYS.join(",")}). Aguardando ~${min} min.`
  );
  await wait(Math.min(ms, 60 * 60 * 1000)); // reavalia a cada 1h
  return waitForBusinessWindow();
}

// === FUNÇÕES AUXILIARES ===
function log(msg) {
  const linha = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, linha);
  console.log(linha.trim());
}
function escolherMensagem(nome) {
  const template = mensagens[Math.floor(Math.random() * mensagens.length)];
  return template.replace(/\[nome\]/g, nome);
}
function getPausaAleatoriaMs(minMinutos, maxMinutos) {
  const minutos = Math.floor(Math.random() * (maxMinutos - minMinutos + 1)) + minMinutos;
  return minutos * 60 * 1000;
}

// === PERSISTÊNCIA DE PROGRESSO ===
let progresso = { enviados: [], ultimoIndex: -1 };
try {
  if (fs.existsSync(PROGRESS_FILE)) {
    progresso = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  }
} catch {
  log("progress.json não encontrado, criando novo...");
}

// === ENVIO PARA A API ===
async function tentarEnviarFormato(contato, mensagem) {
  try {
    const body = {
      apikey: WHATSGW_TOKEN,
      phone_number: FROM_NUMBER,
      contact_phone_number: contato.numero,
      message_custom_id: `msg_${Date.now()}`,
      message_type: "text",
      message_body: mensagem
    };

    const res = await fetch(WHATSGW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    if (res.ok) {
      log(`OK (${res.status}) -> ${text.slice(0, 200)}`);
      return { success: true, status: res.status, body: text };
    } else {
      log(`Erro HTTP ${res.status} - ${text}`);
      return { success: false, status: res.status, body: text };
    }
  } catch (err) {
    log(`Falha ao enviar: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function enviarParaContato(contato) {
  const text = escolherMensagem(contato.nome);
  log(`Enviando para ${contato.nome} (${contato.numero}) - msg: "${text}"`);
  return await tentarEnviarFormato(contato, text);
}

// === MAIN ===
async function main() {
  log("=== INÍCIO DO ROTEIRO ===");
  let enviosNesteLote = 0;

  for (const [index, contato] of contatos.entries()) {
    await waitForBusinessWindow(); // pausa fora do horário/dia

    if (!contato.numero || !contato.nome) {
      log(`Pulando contato inválido: ${JSON.stringify(contato)}`);
      continue;
    }
    if (progresso.enviados.includes(contato.numero)) {
      log(`Pulando ${contato.nome} (${contato.numero}) - já enviado anteriormente.`);
      continue;
    }

    const resultado = await enviarParaContato(contato);
    if (resultado.success) {
      progresso.enviados.push(contato.numero);
      progresso.ultimoIndex = index;
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progresso, null, 2));
    }

    enviosNesteLote++;
    if (index === contatos.length - 1) {
      log("Último contato da lista enviado.");
      break;
    }

    let msPausa, tipoPausa;
    if (enviosNesteLote >= TAMANHO_LOTE) {
      msPausa = getPausaAleatoriaMs(PAUSA_LOTE_MIN_MINUTOS, PAUSA_LOTE_MAX_MINUTOS);
      tipoPausa = `LONGA (lote de ${TAMANHO_LOTE})`;
      enviosNesteLote = 0;
    } else {
      msPausa = getPausaAleatoriaMs(INTERVALO_MIN_MINUTOS, INTERVALO_MAX_MINUTOS);
      tipoPausa = "curta";
    }

    const minutos = Math.round(msPausa / (60 * 1000));
    log(`Aguardando ${minutos} minutos (pausa ${tipoPausa})...`);
    await wait(msPausa);
  }

  log("=== ROTEIRO FINALIZADO ===");
}

process.on("SIGINT", () => {
  log("Recebido SIGINT (Ctrl+C). Encerrando...");
  process.exit(0);
});

main();

// === KEEP-ALIVE SERVER (Railway) ===
const app = express();
app.get("/", (_req, res) => res.send("✅ Whats-Prospect ativo!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Servidor keep-alive rodando na porta ${PORT}`);
});
