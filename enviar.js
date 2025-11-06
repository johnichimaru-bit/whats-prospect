// === enviar.js ===
// Execução com janela de horário comercial + keep-alive Railway (Express)

import fs from "fs";
import { setTimeout as wait } from "timers/promises";
import fetch from "node-fetch";
import mensagens from "./mensagens.js";
import dotenv from "dotenv";
import express from "express";
dotenv.config();

// ============ ARQUIVOS ============
const CONTACTS_FILE = "./contacts.json";
const LOG_FILE = "./enviar.log";
const PROGRESS_FILE = "./progress.json";

// ============ ENV ============
const WHATSGW_TOKEN = process.env.WHATSGW_TOKEN;
const WHATSGW_URL =
  process.env.WHATSGW_URL || "https://app.whatsgw.com.br/api/WhatsGw/Send";
const FROM_NUMBER = process.env.FROM_NUMBER || "";

// janela comercial (personalizável por env)
const BUSINESS_TZ = process.env.BUSINESS_TZ || "America/Sao_Paulo";
const BUSINESS_START = process.env.BUSINESS_START || "08:00"; // HH:mm
const BUSINESS_END = process.env.BUSINESS_END || "21:00";     // HH:mm

if (!WHATSGW_TOKEN) {
  console.error("ERRO: coloque WHATSGW_TOKEN no .env / Railway Variables");
  process.exit(1);
}

// ============ HORÁRIO COMERCIAL ============
function nowInTZ() {
  // cria Date “convertida” para o fuso alvo
  const s = new Date().toLocaleString("en-US", { timeZone: BUSINESS_TZ });
  return new Date(s);
}
function parseHM(hm) {
  const [h, m] = hm.split(":").map(Number);
  return { h, m };
}
function isWithinBusinessHours() {
  const now = nowInTZ();
  const { h: sh, m: sm } = parseHM(BUSINESS_START);
  const { h: eh, m: em } = parseHM(BUSINESS_END);
  const start = new Date(now);
  start.setHours(sh, sm, 0, 0);
  const end = new Date(now);
  end.setHours(eh, em, 0, 0);
  return now >= start && now < end;
}
function msUntilNextStart() {
  const now = nowInTZ();
  const { h: sh, m: sm } = parseHM(BUSINESS_START);
  const startToday = new Date(now);
  startToday.setHours(sh, sm, 0, 0);
  const startTomorrow = new Date(startToday);
  startTomorrow.setDate(startTomorrow.getDate() + 1);
  if (now < startToday) return startToday - now;
  return startTomorrow - now;
}
async function waitForBusinessWindow() {
  if (isWithinBusinessHours()) return;
  const ms = msUntilNextStart();
  const min = Math.ceil(ms / 60000);
  log(
    `[scheduler] Fora do horário (${BUSINESS_START}-${BUSINESS_END} ${BUSINESS_TZ}). Aguardando ~${min} min para reabrir.`
  );
  // dorme no máximo 1h por vez e re-checa (para permitir reimplantação suave)
  await wait(Math.min(ms, 60 * 60 * 1000));
  return waitForBusinessWindow();
}

// ============ LEITURA DE CONTATOS ============
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

// ============ INTERVALOS ============
const INTERVALO_MIN_MINUTOS = 15;
const INTERVALO_MAX_MINUTOS = 35;

const TAMANHO_LOTE = 8;
const PAUSA_LOTE_MIN_MINUTOS = 60;
const PAUSA_LOTE_MAX_MINUTOS = 120;

// ============ UTILS ============
function log(msg) {
  const linha = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, linha); } catch {}
  console.log(linha.trim());
}
function escolherMensagem(nome) {
  const template = mensagens[Math.floor(Math.random() * mensagens.length)];
  return template.replace(/\[nome\]/g, nome);
}
function getPausaAleatoriaMs(minMinutos, maxMinutos) {
  const minutos =
    Math.floor(Math.random() * (maxMinutos - minMinutos + 1)) + minMinutos;
  return minutos * 60 * 1000;
}

// ============ PROGRESSO ============
let progresso = { enviados: [], ultimoIndex: -1 };
try {
  if (fs.existsSync(PROGRESS_FILE)) {
    progresso = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  }
} catch {
  log("progress.json não encontrado, criando novo...");
}

// ============ ENVIO ============
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

// ============ MAIN ============
async function main() {
  log("=== INÍCIO DO ROTEIRO ===");

  // espera abrir janela comercial antes de começar
  await waitForBusinessWindow();

  let enviosNesteLote = 0;

  for (const [index, contato] of contatos.entries()) {
    // Se sair do horário no meio do processo, pausa até reabrir
    if (!isWithinBusinessHours()) {
      await waitForBusinessWindow();
    }

    // Pula contatos inválidos ou já enviados
    if (!contato.numero || !contato.nome) {
      log(`Pulando contato inválido: ${JSON.stringify(contato)}`);
      continue;
    }
    if (progresso.enviados.includes(contato.numero)) {
      log(`Pulando ${contato.nome} (${contato.numero}) - já enviado anteriormente.`);
      continue;
    }

    // Envia
    const resultado = await enviarParaContato(contato);
    if (resultado.success) {
      progresso.enviados.push(contato.numero);
      progresso.ultimoIndex = index;
      try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progresso, null, 2)); } catch {}
    }

    enviosNesteLote++;

    if (index === contatos.length - 1) {
      log("Último contato da lista enviado.");
      break;
    }

    // Pausa
    let msPausa;
    let tipoPausa;
    if (enviosNesteLote >= TAMANHO_LOTE) {
      msPausa = getPausaAleatoriaMs(PAUSA_LOTE_MIN_MINUTOS, PAUSA_LOTE_MAX_MINUTOS);
      tipoPausa = `LONGA (lote de ${TAMANHO_LOTE})`;
      enviosNesteLote = 0;
    } else {
      msPausa = getPausaAleatoriaMs(INTERVALO_MIN_MINUTOS, INTERVALO_MAX_MINUTOS);
      tipoPausa = "curta";
    }

    const minutos = Math.round(msPausa / 60000);
    log(`Aguardando ${minutos} minutos (pausa ${tipoPausa})...`);

    // Durante a pausa curta/longa, se virar fora de horário, interrompe espera longa
    const step = 60 * 1000; // checa a cada 1 min
    let restante = msPausa;
    while (restante > 0) {
      // se saiu da janela, aguarda até reabrir
      if (!isWithinBusinessHours()) {
        await waitForBusinessWindow();
      }
      const s = Math.min(step, restante);
      await wait(s);
      restante -= s;
    }
  }

  log("=== ROTEIRO FINALIZADO ===");
}

// encerra limpo
process.on("SIGINT", () => {
  log("Recebido SIGINT (Ctrl+C). Encerrando...");
  process.exit(0);
});

// keep-alive Railway (evita “hibernar”)
const app = express();
app.get("/", (_req, res) => res.send("whats-prospect ativo"));
app.listen(process.env.PORT || 3000);

main().catch((e) => {
  log("Erro fatal no main: " + e.message);
  process.exit(1);
});
