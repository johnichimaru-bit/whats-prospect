// === enviar.js (versão final, sem horário comercial e com pausa reduzida) ===
import fs from "fs";
import { setTimeout as wait } from "timers/promises";
import fetch from "node-fetch";
import mensagens from "./mensagens.js";
import dotenv from "dotenv";
dotenv.config();

// === CONFIGURAÇÕES DE ARQUIVOS ===
const CONTACTS_FILE = "./contacts.json";
const LOG_FILE = "./enviar.log";
const PROGRESS_FILE = "./progress.json";

// === VARIÁVEIS DE AMBIENTE ===
const WHATSGW_TOKEN = process.env.WHATSGW_TOKEN;
const WHATSGW_URL = process.env.WHATSGW_URL || "https://app.whatsgw.com.br/api/WhatsGw/Send";
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

const TAMANHO_LOTE = 8; // após 8 mensagens, pausa longa
const PAUSA_LOTE_MIN_MINUTOS = 60; // 1h00
const PAUSA_LOTE_MAX_MINUTOS = 120; // 2h

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
  const resultado = await tentarEnviarFormato(contato, text);
  return resultado;
}

// === MAIN ===
async function main() {
  log("=== INÍCIO DO ROTEIRO ===");
  let enviosNesteLote = 0;

  for (const [index, contato] of contatos.entries()) {
    // Pula contatos inválidos ou já enviados
    if (!contato.numero || !contato.nome) {
      log(`Pulando contato inválido: ${JSON.stringify(contato)}`);
      continue;
    }
    if (progresso.enviados.includes(contato.numero)) {
      log(`Pulando ${contato.nome} (${contato.numero}) - já enviado anteriormente.`);
      continue;
    }

    // Envia mensagem
    const resultado = await enviarParaContato(contato);
    if (resultado.success) {
      progresso.enviados.push(contato.numero);
      progresso.ultimoIndex = index;
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progresso, null, 2));
    }

    enviosNesteLote++;

    // Se for o último contato, não espera
    if (index === contatos.length - 1) {
      log("Último contato da lista enviado.");
      break;
    }

    // Pausa curta ou longa
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
