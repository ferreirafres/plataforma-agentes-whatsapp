import 'dotenv/config';
import { registerConnectionManagement } from './connection-management.js';
import { registerAgentTools } from './agent-tools.js';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidRequestError, InvalidTokenError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import pkg from 'whatsapp-web.js';
import {WhatsAppSession,registerSessionRoutes} from './whatsapp-session.js';
import fs from 'node:fs';
import { DATA_ROOT, OAUTH_DATA_DIR } from './data-paths.js';
import { initialPassword, provisionPlatform } from './bootstrap.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { parseBuffer as parseAudioMetadata } from 'music-metadata';
import crypto from 'node:crypto';
import { IdentityStore, verifySecret, ALL_SCOPES } from './identity-store.js';
import { TranscriptionCache, transcribeAudio, transcriptionConfigSummary } from './transcription.js';
import { TempFileStore, sha256Hex, fetchUrlWithSsrfProtection, SsrfBlockedError } from './temp-files.js';
import {
  DriveConnectionStore,
  publicConnectionFields,
  encryptToken,
  decryptToken,
  maskEmail,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  revokeGoogleToken,
  fetchGoogleUserEmail,
  driveSearchByText,
  driveListFolderChildren,
  driveGetFileMetadata,
  driveDownloadFileContent,
  isUnderAllowedRoot,
  isGoogleNativeMimetype,
  DRIVE_READONLY_SCOPE,
} from './google-drive.js';
import multer from 'multer';

const { Client, LocalAuth, MessageMedia } = pkg;

function log(...args) {
  console.log('[MCP]', ...args);
}

process.umask(0o077);
fs.mkdirSync(OAUTH_DATA_DIR, { recursive: true });

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
if (!PUBLIC_URL) {
  console.error('PUBLIC_URL não definido no ambiente (.env). Abortando.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// WhatsApp MCP BASE V1 - identidade da instância e feature flags.
//
// Este servidor é pensado para ser clonado (1 codebase, N instâncias - cada
// uma com seu próprio .env/volumes/sessão/tokens/domínio). INSTANCE_NAME e
// WHATSAPP_MCP_VERSION identificam qual instância/versão está rodando (só
// aparecem no /health autenticado, nunca no público).
//
// Feature flags: GLOBAL DEFAULT (o valor abaixo) + INSTANCE OVERRIDE (a
// variável FEATURE_* no .env desta instância, se definida). Toda nova
// funcionalidade deve, por padrão, ficar disponível para todas as
// instâncias (true) - uma instância só desativa algo setando
// FEATURE_X=false no PRÓPRIO .env, sem fork de código.
// ---------------------------------------------------------------------------
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'default';
// O identificador técnico é estável; o nome exibido pode ser personalizado.
const INSTANCE_DISPLAY_NAME = process.env.INSTANCE_DISPLAY_NAME || INSTANCE_NAME;
const WHATSAPP_MCP_VERSION = process.env.WHATSAPP_MCP_VERSION || '1.0.0';

const FEATURE_DEFAULTS = {
  FEATURE_AGENT_TAGS: true,
  FEATURE_SEND_MESSAGES: true,
  FEATURE_MEDIA_READING: true,
  FEATURE_TRANSCRIPTION: true,
  FEATURE_DEEP_SEARCH: true,
  FEATURE_UNREAD_REPORT: true,
  FEATURE_FILE_DOWNLOAD: true,
  FEATURE_FILE_SEND: true,
  FEATURE_MULTI_FILE_SEND: true,
  FEATURE_TEMP_FILE_UPLOAD: true,
  FEATURE_FORWARD_MESSAGE: true,
  FEATURE_FORWARD_ATTACHMENT: true,
  FEATURE_FIND_AND_FORWARD: true,
  FEATURE_GOOGLE_DRIVE: true,
  FEATURE_DRIVE_READ: true,
  FEATURE_DRIVE_SEND: true,
};

function featureEnabled(name) {
  const raw = process.env[name];
  if (raw === undefined) return FEATURE_DEFAULTS[name] ?? true;
  return raw.toLowerCase() === 'true';
}

// Cada início de container é um processo Chromium novo: qualquer lock
// "Singleton*" deixado por um Chromium anterior (ex: container derrubado
// sem tempo de encerrar graciosamente) é necessariamente obsoleto e trava
// o novo Chromium ("profile in use"). Não apaga a sessão em si (cookies,
// IndexedDB etc.), só esses arquivos de lock do processo.
for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
  const lockPath = path.join(DATA_ROOT, '.wwebjs_auth', 'session', lock);
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // ignora
  }
}

// ---------------------------------------------------------------------------
// Cliente WhatsApp
// ---------------------------------------------------------------------------
const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(DATA_ROOT, '.wwebjs_auth') }),
  webVersionCache: { type: 'local', path: path.join(DATA_ROOT, '.wwebjs_cache') },
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

let waReady = false;

const whatsappSession=new WhatsAppSession({
  client:waClient,getReady:()=>waReady,setNotReady:()=>{waReady=false;},
  restartProcess:()=>setTimeout(()=>{
    setTimeout(()=>process.exit(0),8000);
    waClient.destroy().catch(()=>{}).finally(()=>process.exit(0));
  },300),
});
waClient.on('qr',()=>console.log('[whatsapp] QR Code disponível no painel autenticado.'));


// Bug conhecido do whatsapp-web.js (atualização do servidor WhatsApp Web de
// ~2026-09-17 em diante - https://github.com/wwebjs/whatsapp-web.js):
// o objeto interno de mídia retornado por WWebJS.processMediaData() carrega
// uma propriedade própria "__x_id" que, ao ser espalhada (...mediaOptions) na
// construção da mensagem de saída, sobrescreve o id real da mensagem,
// quebrando getValidatedSender() internamente com "Data passed to getter must
// include an id property... but got undefined" - TODO envio de mídia falhava
// (texto puro não é afetado, pois não passa por processMediaData). Removemos
// "__x_id" do resultado antes que ele chegue a ser espalhado. Precisa ser
// reaplicado a cada novo carregamento de página (login inicial e cada
// reconexão), por isso fica numa função chamada nos dois pontos que detectam
// "pronto" abaixo.
async function applyMediaSendPatch() {
  try {
    await waClient.pupPage.evaluate(() => {
      if (window.__whatsappMcpMediaPatchApplied) return;
      const original = window.WWebJS.processMediaData;
      window.WWebJS.processMediaData = async function (...args) {
        const result = await original.apply(this, args);
        if (result && Object.prototype.hasOwnProperty.call(result, '__x_id')) {
          delete result.__x_id;
        }
        return result;
      };
      window.__whatsappMcpMediaPatchApplied = true;
    });
    log('[WHATSAPP-MCP][FILE] patch __x_id aplicado (envio de mídia)');
  } catch (e) {
    console.error('[whatsapp] falha ao aplicar patch de envio de mídia:', e.message);
  }
}

waClient.on('ready', async () => {
  waReady = true;
  console.log('[whatsapp] cliente pronto.');
  await applyMediaSendPatch();
  try {
    const v = await waClient.getWWebVersion();
    console.log('[whatsapp] versão do WhatsApp Web servida:', v);
  } catch (e) {
    console.error('[whatsapp] não consegui checar a versão:', e.message);
  }
});

waClient.on('auth_failure', (msg) => {
  waReady=false;
  console.error('[whatsapp] falha de autenticação:', msg);
});

waClient.on('disconnected', (reason) => {
  waReady = false;
  console.error('[whatsapp] desconectado:', reason);
});

// Keep checking the live renderer after 'ready': Chromium can exit without
// emitting whatsapp-web.js's 'disconnected' event. The same check can restore
// readiness when the library does not emit 'ready' after reconnecting.
const readyPoll = setInterval(() => {
  void whatsappSession.monitor(
    page=>page.evaluate(() => {
      try {
        return window.require('WAWebSocketModel').Socket.state==='CONNECTED' && typeof window.WWebJS !== 'undefined' && !!window.require('WAWebCollections').Chat;
      } catch {
        return false;
      }
    }),
    ()=>{
      waReady = true;
      console.log('[whatsapp] cliente pronto (verificado pelo Store).');
      void applyMediaSendPatch();
    }
  ).catch(error=>console.error('[whatsapp] falha no monitor da sessão:',error.message));
}, 3000);

whatsappSession.start();

function normalizeChatId(to) {
  const trimmed = String(to).trim();
  if (trimmed.endsWith('@c.us') || trimmed.endsWith('@g.us')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return `${digits}@c.us`;
}

function requireWhatsappReady() {
  if (!whatsappSession.isReady()) {
    throw new Error('Sessão do WhatsApp indisponível. Aguarde a reconexão e tente novamente. Se persistir, confira o pareamento no painel.');
  }
}

// Checa se o token usado tem o escopo necessário para a tool. Devolve um
// CallToolResult de erro pronto para `return` se faltar escopo, ou null se
// pode prosseguir. (Implementação real de escopos/identidades é instalada
// mais abaixo, junto com o provider OAuth - aqui só a função utilitária.)
function requireScope(extra, scope) {
  const scopes = extra?.authInfo?.scopes || [];
  if (!scopes.includes(scope)) {
    const label = extra?.authInfo?.extra?.label || extra?.authInfo?.clientId || 'desconhecido';
    log('scope negado:', label, 'precisa de', scope, 'tem', JSON.stringify(scopes));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: false, error: 'insufficient_scope', required_scope: scope }, null, 2),
        },
      ],
      isError: true,
    };
  }
  return null;
}

// Como requireScope, mas para feature flags (liga/desliga por instância via
// FEATURE_* no .env, sem precisar de token/scope diferente).
function requireFeature(name) {
  if (featureEnabled(name)) return null;
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'feature_disabled', feature: name }, null, 2) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Servidor MCP e ferramentas
// (fábrica: no modo stateless do Streamable HTTP, cada requisição HTTP recebe
// uma instância nova de McpServer + transport, conforme o padrão oficial do
// SDK. O waClient acima é singleton e compartilhado entre todas elas.)
// ---------------------------------------------------------------------------
function createMcpServer() {
  // name/instructions aqui são metadados do protocolo MCP (devolvidos na
  // resposta do "initialize") - ajudam o MODELO a entender que este conector
  // inteiro = o WhatsApp de UMA pessoa só, então "meu WhatsApp"/"my WhatsApp"
  // é interpretado naturalmente. NÃO é garantia de que Claude.ai/ChatGPT
  // troquem o nome exibido na lista de conectores por isso - esse nome, hoje,
  // é definido manualmente por quem adiciona/edita o conector em cada
  // plataforma (confirmado via documentação pública de ambas - ver AGENTS.md).
  const mcpServer = new McpServer(
    { name: INSTANCE_DISPLAY_NAME, version: WHATSAPP_MCP_VERSION },
    {
      instructions:
        `This MCP server (${INSTANCE_DISPLAY_NAME}) provides access to a single person's personal WhatsApp ` +
        'account. When the user refers to "my WhatsApp"/"meu WhatsApp" in a conversation where this is the only ' +
        'WhatsApp connector available, they mean this one. All tools operate on this single WhatsApp session only ' +
        '- there is no cross-instance access to any other WhatsApp account.',
    }
  );

  // WRITE (não é read-only, de propósito). Auditoria confirmada no código-
  // fonte da lib (whatsapp-web.js 1.34.7, Client.js): waClient.sendMessage()
  // tem `options.sendSeen` default `true`, e quando true chama
  // window.WWebJS.sendSeen(chatId) logo depois de enviar a mensagem - ou
  // seja, RESPONDER uma conversa não lida marca ela como lida (zera
  // unreadCount e manda confirmação de leitura ao remetente), igual
  // aconteceria respondendo pelo WhatsApp normal. Esse é o comportamento
  // nativo esperado ao enviar uma resposta - não alteramos isso (ver pedido
  // explícito de não mudar send_message sem entender o efeito primeiro).
  // Todas as ferramentas de CONSULTA abaixo (get_recent_chats, search_*,
  // get_chat_history, get_chat_context, get_unread_chats, get_message_*)
  // são estritamente read-only e nunca chamam sendSeen.
  mcpServer.registerTool(
    'send_message',
    {
      title: `Enviar mensagem no ${INSTANCE_DISPLAY_NAME}`,
      description:
        `Envia uma mensagem de texto no ${INSTANCE_DISPLAY_NAME}. Use "to" para um número de telefone individual (ex: DDIDDDNUMERO), ` +
        'ou "chat_id" com o ID real do WhatsApp (obtido via get_recent_chats ou search_chats) para enviar a um contato ' +
        'ou GRUPO específico. Para grupos, "chat_id" é obrigatório - nunca invente ou deduza um chat_id de grupo a ' +
        'partir do nome; sempre localize-o antes com search_chats.',
      inputSchema: {
        to: z.string().optional().describe('Número completo com DDI e DDD, ex: DDIDDDNUMERO (somente contato individual).'),
        chat_id: z
          .string()
          .optional()
          .describe(
            'ID real do WhatsApp, ex: "DDIDDDNUMERO@c.us" (individual) ou "ID_DO_GRUPO@g.us" (grupo). ' +
              'Obtenha com get_recent_chats ou search_chats - nunca invente este valor.'
          ),
        body: z.string().describe('Texto da mensagem a enviar'),
      },
    },
    async ({ to, chat_id, body }, extra) => {
      try {
        const featureError = requireFeature('FEATURE_SEND_MESSAGES');
        if (featureError) return featureError;
        const scopeError = requireScope(extra, 'whatsapp:send');
        if (scopeError) return scopeError;
        requireWhatsappReady();
        let targetId;
        if (chat_id) {
          if (!chat_id.endsWith('@c.us') && !chat_id.endsWith('@g.us') && !chat_id.endsWith('@lid')) {
            return {
              content: [{ type: 'text', text: `chat_id inválido: "${chat_id}". Use um ID real retornado por get_recent_chats ou search_chats.` }],
              isError: true,
            };
          }
          targetId = chat_id;
        } else if (to) {
          targetId = normalizeChatId(to);
        } else {
          return { content: [{ type: 'text', text: 'Informe "to" (número) ou "chat_id" (ID do WhatsApp).' }], isError: true };
        }
        await waClient.sendMessage(targetId, body);
        auditLog({ action: 'send_message', ok: true, identityId: extra?.authInfo?.extra?.identityId, label: extra?.authInfo?.extra?.label, to: targetId });
        return { content: [{ type: 'text', text: `Mensagem enviada para ${targetId}.` }] };
      } catch (err) {
        auditLog({ action: 'send_message', ok: false, identityId: extra?.authInfo?.extra?.identityId, error: err.message });
        return { content: [{ type: 'text', text: `Falha ao enviar mensagem: ${err.message}` }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'get_recent_chats',
    {
      title: 'Listar conversas recentes',
      description:
        'Retorna as últimas conversas ativas no WhatsApp em JSON, uma por linha do array, com o chat_id REAL de cada ' +
        'uma (use esse chat_id em send_message para enviar a grupos).',
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const scopeError = requireScope(extra, 'whatsapp:read');
        if (scopeError) return scopeError;
        requireWhatsappReady();
        log('[READ_ONLY] get_recent_chats');
        const chats = await evaluateChats();
        const recent = chats
          .slice()
          .sort((a, b) => (b.last_message_timestamp || 0) - (a.last_message_timestamp || 0))
          .slice(0, 15)
          .map(formatChatSummary);
        return { content: [{ type: 'text', text: JSON.stringify(recent, null, 2) }] };
      } catch (err) {
        console.error('[get_recent_chats] erro detalhado:', err);
        return { content: [{ type: 'text', text: `Falha ao obter conversas: ${err.message}` }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'get_unread_chats',
    {
      title: 'Listar conversas não lidas (com mensagens, para relatório)',
      description:
        'READ-ONLY: retorna as conversas com mensagens não lidas (unread_count > 0), opcionalmente já com as últimas ' +
        'mensagens de cada uma - útil para pedidos como "faça um relatório das minhas conversas não lidas". ' +
        'Consultar esta tool NUNCA marca as conversas como lidas nem envia confirmação de leitura ao remetente ' +
        '(não chama sendSeen) - o unread_count antes e depois da consulta é sempre o mesmo.',
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe('Quantas conversas não lidas retornar, ordenadas pela mais recente (padrão 20).'),
        include_messages: z.boolean().optional().describe('true (padrão) para incluir as últimas mensagens de cada conversa; false para só a lista/contadores.'),
        messages_per_chat: z.number().int().positive().max(200).optional().describe('Quantas mensagens recentes incluir por conversa quando include_messages=true (padrão 10).'),
        transcribe_audio: z.boolean().optional().describe('true para incluir a transcrição de mensagens de áudio dentre as retornadas (requer escopo whatsapp:transcribe).'),
      },
    },
    async ({ limit, include_messages, messages_per_chat, transcribe_audio }, extra) => {
      try {
        const featureError = requireFeature('FEATURE_UNREAD_REPORT');
        if (featureError) return featureError;
        const scopeError = requireScope(extra, 'whatsapp:read');
        if (scopeError) return scopeError;
        requireWhatsappReady();
        log('[READ_ONLY] get_unread_chats');
        const wantMessages = include_messages !== false;
        const perChat = messages_per_chat || 10;
        const take = limit || 20;
        const transcribeFlag = !!transcribe_audio && featureEnabled('FEATURE_TRANSCRIPTION');
        const canTranscribe = (extra?.authInfo?.scopes || []).includes('whatsapp:transcribe');

        const allChats = await evaluateChats();
        const unread = allChats
          .filter((c) => (c.unread_count || 0) > 0)
          .sort((a, b) => (b.last_message_timestamp || 0) - (a.last_message_timestamp || 0));
        const selected = unread.slice(0, take);

        const chats = [];
        for (const chat of selected) {
          const entry = {
            chat_id: chat.chat_id,
            name: chat.name,
            is_group: chat.is_group,
            unread_count: chat.unread_count,
            last_message_timestamp: chat.last_message_timestamp ? new Date(chat.last_message_timestamp * 1000).toISOString() : null,
          };
          if (wantMessages) {
            const page = await fetchChatHistory(chat.chat_id, { targetCount: perChat });
            let messages = page.error ? [] : page.messages.map(formatMessage);
            if (transcribe_audio) {
              const enriched = [];
              for (const m of messages) enriched.push(await transcribeMessageIfAudio(m, { transcribeFlag, canTranscribe }));
              messages = enriched;
            }
            entry.messages = messages;
          }
          chats.push(entry);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ total_unread_chats: unread.length, returned: chats.length, chats }, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error('[get_unread_chats] erro detalhado:', err);
        return { content: [{ type: 'text', text: `Falha ao listar conversas não lidas: ${err.message}` }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'search_chats',
    {
      title: 'Buscar contatos e grupos por nome',
      description:
        'Procura TODAS as conversas e contatos do WhatsApp cujo nome contenha "query" (busca parcial, sem diferenciar ' +
        'maiúsculas) - percorre todos os chats disponíveis via client.getChats(), sem limite de 15. Retorna o chat_id ' +
        'REAL de cada resultado, com última mensagem/timestamp/não lidas. Se vier mais de um resultado parecido, NÃO ' +
        'escolha um sozinho: liste as opções e peça para o usuário confirmar qual chat_id usar. Se vier vazio, o nome ' +
        'não foi encontrado - não tente adivinhar ou construir um chat_id manualmente.',
      inputSchema: {
        query: z.string().describe('Trecho do nome do contato ou grupo a procurar, ex: "baba treinamento"'),
      },
    },
    async ({ query }, extra) => {
      try {
        const scopeError = requireScope(extra, 'whatsapp:read');
        if (scopeError) return scopeError;
        requireWhatsappReady();
        log('search_chats', query);
        const results = await findChatsByName(query);
        log('search_chats resultados:', results.length);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        console.error('[search_chats] erro detalhado:', err);
        return { content: [{ type: 'text', text: `Falha ao buscar contatos/grupos: ${err.message}` }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'search_contacts',
    {
      title: 'Buscar contatos por nome, pushname ou número',
      description:
        'Procura contatos salvos do WhatsApp (não grupos) por nome, pushname ou número de telefone (busca parcial). ' +
        'Use quando quiser só contatos individuais, não conversas/grupos.',
      inputSchema: {
        query: z.string().describe('Nome, pushname ou número (completo ou parcial) a procurar'),
      },
    },
    async ({ query }, extra) => {
      try {
        const scopeError = requireScope(extra, 'whatsapp:read');
        if (scopeError) return scopeError;
        requireWhatsappReady();
        log('search_contacts', query);
        const needle = query.trim().toLowerCase();
        if (!needle) return { content: [{ type: 'text', text: JSON.stringify([]) }] };
        const results = await evaluateContacts(needle);
        log('search_contacts resultados:', results.length);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        console.error('[search_contacts] erro detalhado:', err);
        return { content: [{ type: 'text', text: `Falha ao buscar contatos: ${err.message}` }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'get_chat_history',
    {
      title: 'Buscar histórico de mensagens de uma conversa',
      description:
        'Busca o histórico real de mensagens de UM chat específico, independente de ele estar entre as 15 conversas ' +
        'mais recentes. Informe "chat_id" (se já souber, via get_recent_chats/search_chats) OU "contact" (nome/número - ' +
        'resolvido automaticamente; se ambíguo, retorna "candidates" para você escolher, sem adivinhar). Usa ' +
        'chat.fetchMessages()/loadEarlierMsgs() do whatsapp-web.js para paginar mensagens mais antigas quando "limit" ' +
        'excede o que já está carregado na sessão. "before" (ISO 8601) busca mensagens anteriores a essa data - use o ' +
        '"oldest_timestamp" retornado numa chamada anterior para continuar buscando mensagens mais antigas ainda ' +
        '("continue buscando mensagens anteriores"). NUNCA inventa mensagens: se o WhatsApp Web não tiver mais ' +
        'histórico sincronizado, "history_availability" vem "exhausted" e "has_more" vem false.',
      inputSchema: {
        chat_id: z.string().optional().describe('ID real do chat (ex: "DDIDDDNUMERO@c.us" ou "...@g.us"). Use isto OU contact.'),
        contact: z.string().optional().describe('Nome ou número do contato/grupo, para resolução automática. Use isto OU chat_id.'),
        limit: z.number().int().positive().max(2000).optional().describe('Quantas mensagens retornar (padrão 50, sugestão 100-200 para análise maior).'),
        before: z.string().optional().describe('ISO 8601: só mensagens anteriores a esta data/hora (para paginar mais para trás).'),
        after: z.string().optional().describe('ISO 8601: só mensagens depois desta data/hora.'),
      },
    },
    async ({ chat_id, contact, limit, before, after }, extra) => {
      try {
        const scopeError = requireScope(extra, 'whatsapp:read');
        if (scopeError) return scopeError;
        requireWhatsappReady();
        const resolved = await resolveTargetChat({ chat_id, contact });
        if (!resolved.ok) return resolvedFailureResponse(resolved);
        log('[READ_ONLY] get_chat_history', resolved.chat_id);
        const targetCount = limit || 50;
        const beforeTs = before ? isoToEpoch(before) : undefined;
        const afterTs = after ? isoToEpoch(after) : undefined;
        const page = await fetchChatHistory(resolved.chat_id, { targetCount, beforeTs, afterTs });
        if (page.error) {
          return { content: [{ type: 'text', text: `Não consegui acessar essa conversa (${page.error}).` }], isError: true };
        }
        log('messages returned:', page.messages.length);
        const formatted = page.messages.map(formatMessage);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  chat_id: resolved.chat_id,
                  messages_returned: formatted.length,
                  has_more: page.hasMoreOlder,
                  oldest_timestamp: page.oldestLoadedTimestamp ? new Date(page.oldestLoadedTimestamp * 1000).toISOString() : null,
                  history_availability: page.hasMoreOlder ? 'partial' : 'exhausted',
                  messages: formatted,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        console.error('[get_chat_history] erro detalhado:', err);
        return { content: [{ type: 'text', text: `Falha ao buscar histórico: ${err.message}` }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'get_chat_context',
    {
      title: 'Ver histórico formatado para análise (resumo, pendências, etc.)',
      description:
        'Como get_chat_history, mas devolve o histórico já formatado em texto cronológico limpo ' +
        '("[DD/MM/AAAA HH:MM] Nome: mensagem"), pronto para responder perguntas como "ele mandou o contrato?", ' +
        '"faça um resumo dessa conversa" ou "o que ficou pendente?". Use "contact" para resolver pelo nome.',
      inputSchema: {
        chat_id: z.string().optional().describe('ID real do chat. Use isto OU contact.'),
        contact: z.string().optional().describe('Nome ou número do contato/grupo, para resolução automática.'),
        limit: z.number().int().positive().max(2000).optional().describe('Quantas mensagens incluir (padrão 50).'),
        start_date: z.string().optional().describe('ISO 8601: início do intervalo desejado.'),
        end_date: z.string().optional().describe('ISO 8601: fim do intervalo desejado.'),
        transcribe_audio: z.boolean().optional().describe('true para incluir a transcrição das mensagens de áudio no texto cronológico (requer escopo whatsapp:transcribe).'),
      },
    },
    async ({ chat_id, contact, limit, start_date, end_date, transcribe_audio }, extra) => {
      try {
        const scopeError = requireScope(extra, 'whatsapp:read');
        if (scopeError) return scopeError;
        requireWhatsappReady();
        const resolved = await resolveTargetChat({ chat_id, contact });
        if (!resolved.ok) return resolvedFailureResponse(resolved);
        log('[READ_ONLY] get_chat_context', resolved.chat_id);
        const targetCount = limit || 50;
        const beforeTs = end_date ? isoToEpoch(end_date) : undefined;
        const afterTs = start_date ? isoToEpoch(start_date) : undefined;
        const page = await fetchChatHistory(resolved.chat_id, { targetCount, beforeTs, afterTs });
        if (page.error) {
          return { content: [{ type: 'text', text: `Não consegui acessar essa conversa (${page.error}).` }], isError: true };
        }
        const displayInfo = await getChatDisplayInfo(resolved.chat_id);
        const transcribeFlag = !!transcribe_audio && featureEnabled('FEATURE_TRANSCRIPTION');
        const canTranscribe = (extra?.authInfo?.scopes || []).includes('whatsapp:transcribe');
        const lines = [];
        for (const raw of page.messages) {
          let m = formatMessage(raw);
          if (transcribe_audio) m = await transcribeMessageIfAudio(m, { transcribeFlag, canTranscribe });
          lines.push(buildContextLine(m, displayInfo || {}));
        }
        const header =
          `Conversa: ${(displayInfo && displayInfo.chatName) || resolved.chat_id}\n` +
          `${page.messages.length} mensagens (${page.hasMoreOlder ? 'histórico parcial, há mais mensagens antigas disponíveis' : 'início do histórico sincronizado alcançado'})\n` +
          '---\n';
        return { content: [{ type: 'text', text: header + lines.join('\n\n') }] };
      } catch (err) {
        console.error('[get_chat_context] erro detalhado:', err);
        return { content: [{ type: 'text', text: `Falha ao montar contexto: ${err.message}` }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'search_messages',
    {
      title: `Pesquisar texto dentro das mensagens do ${INSTANCE_DISPLAY_NAME}`,
      description:
        `Procura "query" dentro do conteúdo das mensagens do ${INSTANCE_DISPLAY_NAME} (texto, legenda de mídia, nome de arquivo). Se "chat_id" ou ` +
        '"contact" forem informados, procura só naquela conversa, paginando mensagens mais antigas conforme ' +
        'necessário. Sem chat/contato, procura nas mensagens JÁ CARREGADAS de todas as conversas (mais rápido, mas não ' +
        'pagina histórico antigo de cada uma - para isso especifique o chat). Use deep_search=true para continuar ' +
        'paginando mensagens antigas DE UM CHAT ESPECÍFICO até achar resultados, alcançar start_date, esgotar o ' +
        'histórico ou atingir o teto de segurança.',
      inputSchema: {
        query: z.string().describe('Texto a procurar, ex: "pix", "comprovante", "contrato"'),
        chat_id: z.string().optional().describe('Restringe a busca a este chat (ID real).'),
        contact: z.string().optional().describe('Restringe a busca a este contato/grupo (nome ou número, resolvido automaticamente).'),
        start_date: z.string().optional().describe('ISO 8601: não considerar mensagens antes desta data.'),
        end_date: z.string().optional().describe('ISO 8601: não considerar mensagens depois desta data.'),
        limit: z.number().int().positive().max(500).optional().describe('Máximo de resultados a retornar (padrão 50).'),
        deep_search: z.boolean().optional().describe('true = continuar paginando mensagens antigas do chat até achar/esgotar/atingir teto de segurança (só funciona com chat_id ou contact).'),
        deep_audio_search: z
          .boolean()
          .optional()
          .describe(
            'true = além do texto, transcreve (e cacheia) áudios ainda não transcritos dentro do intervalo pesquisado para incluí-los na busca (requer escopo whatsapp:transcribe e chat_id/contact). Sem isso, a busca só considera transcrições JÁ cacheadas - nunca transcreve em massa sozinha, por custo.'
          ),
      },
    },
    async ({ query, chat_id, contact, start_date, end_date, limit, deep_search, deep_audio_search }, extra) => {
      try {
        const scopeError = requireScope(extra, 'whatsapp:read');
        if (scopeError) return scopeError;
        requireWhatsappReady();
        const needle = query.trim().toLowerCase();
        if (!needle) return { content: [{ type: 'text', text: JSON.stringify({ matches: [] }) }], isError: true };
        const startTs = start_date ? isoToEpoch(start_date) : undefined;
        const endTs = end_date ? isoToEpoch(end_date) : undefined;
        const limitMatches = limit || 50;
        const canTranscribe = (extra?.authInfo?.scopes || []).includes('whatsapp:transcribe');

        if (chat_id || contact) {
          const resolved = await resolveTargetChat({ chat_id, contact });
          if (!resolved.ok) return resolvedFailureResponse(resolved);
          log('deep search iniciando em', resolved.chat_id, 'deepSearch:', !!deep_search);
          const result = await scanChatForMatches({
            chatId: resolved.chat_id,
            needle,
            startTs,
            endTs,
            limitMatches,
            deepSearch: !!deep_search && featureEnabled('FEATURE_DEEP_SEARCH'),
            deepAudioSearch: !!deep_audio_search && featureEnabled('FEATURE_TRANSCRIPTION'),
            canTranscribe,
          });
          if (result.error) {
            return { content: [{ type: 'text', text: `Não consegui acessar essa conversa (${result.error}).` }], isError: true };
          }
          log('deep search scanned:', result.scanned);
          log('matches found:', result.matches.length);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    query,
                    chat_id: resolved.chat_id,
                    messages_scanned: result.scanned,
                    matches: result.matches.map(formatMessage),
                    history_exhausted: result.exhausted,
                    oldest_message_scanned: result.oldestScannedTs ? new Date(result.oldestScannedTs * 1000).toISOString() : null,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Sem chat/contato: varre só o que já está carregado em memória de
        // TODAS as conversas (não pagina histórico antigo de cada uma - isso
        // seria uma varredura completa de centenas de chats, inviável aqui).
        const allChats = await evaluateChats();
        const transcriptionsById = transcriptionCache.allByMessageId();
        let scanned = 0;
        const matches = [];
        for (const chat of allChats) {
          const loaded = await getLoadedMessages(chat.chat_id, { beforeTs: endTs });
          if (loaded.error) continue;
          for (const raw of loaded.messages) {
            scanned++;
            if (startTs && raw.t < startTs) continue;
            if (matchesQuery(raw, needle, transcriptionsById)) matches.push(formatMessage(raw));
            if (matches.length >= limitMatches) break;
          }
          if (matches.length >= limitMatches) break;
        }
        log('busca rápida (sem deep search) scanned:', scanned, 'matches:', matches.length);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  query,
                  scope: 'todas as conversas (só mensagens já carregadas na sessão, sem paginar histórico antigo)',
                  messages_scanned: scanned,
                  matches,
                  history_exhausted: false,
                  note: 'Para uma busca profunda no histórico antigo, informe chat_id ou contact junto com deep_search=true.',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        console.error('[search_messages] erro detalhado:', err);
        return { content: [{ type: 'text', text: `Falha ao pesquisar mensagens: ${err.message}` }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'get_message_media_info',
    {
      title: 'Ver informações de mídia/documento de uma mensagem',
      description:
        'Dado um messageId (obtido via get_chat_history ou search_messages), retorna metadados da mídia/documento ' +
        '(tipo, nome de arquivo, mimetype, tamanho) e indica se dá para LER o conteúdo direto pelo MCP. ' +
        'Para ler o conteúdo de verdade (texto de PDF/DOCX/TXT, ou ver a imagem), use read_message_attachment - ' +
        'não é preciso (nem recomendado) acessar a URL /media diretamente.',
      inputSchema: {
        message_id: z.string().describe('ID real da mensagem (campo message_id retornado por get_chat_history/search_messages).'),
        download: z
          .boolean()
          .optional()
          .describe('Avançado/administrativo: true gera um link temporário autenticado em /media (debug). Use read_message_attachment para leitura normal.'),
      },
    },
    async ({ message_id, download }, extra) => {
      try {
        const scopeError = requireScope(extra, 'whatsapp:read');
        if (scopeError) return scopeError;
        requireWhatsappReady();
        const raw = await fetchRawMessage(message_id);
        if (!raw) {
          return { content: [{ type: 'text', text: `Mensagem não encontrada (message_id: ${message_id}). Ela pode não estar mais carregada na sessão - busque de novo via get_chat_history.` }], isError: true };
        }
        const info = formatMessage(raw);
        if (!info.has_media) {
          return { content: [{ type: 'text', text: JSON.stringify({ message_id, has_media: false, note: 'Esta mensagem não tem mídia/documento.' }, null, 2) }] };
        }
        const result = {
          message_id,
          has_media: true,
          filename: info.filename,
          mimetype: info.mimetype,
          size: raw.size ?? null,
          duration: raw.duration ?? null,
          caption: info.caption,
          readable_by_mcp: isReadableByMcp(info.mimetype),
          recommended_tool: 'read_message_attachment',
        };
        if (download) {
          const scopeError = requireScope(extra, 'whatsapp:media');
          if (scopeError) return scopeError;
          const media = await downloadMessageMedia(message_id);
          if (!media) {
            return { content: [{ type: 'text', text: JSON.stringify({ ...result, download: 'falhou (mídia indisponível para download)' }, null, 2) }], isError: true };
          }
          const id = randomUUID();
          const ext = extensionForMimetype(media.mimetype);
          const storedFilename = `${id}${ext}`;
          cleanupOldMedia();
          fs.writeFileSync(path.join(MEDIA_DIR, storedFilename), Buffer.from(media.data, 'base64'));
          mediaRegistry.set(id, {
            storedFilename,
            mimetype: media.mimetype,
            filename: media.filename || storedFilename,
            ownerIdentityId: extra?.authInfo?.extra?.identityId || null,
            createdAt: Date.now(),
          });
          result.download_url = `${PUBLIC_URL}/media/${id}`;
          result.download_note = 'Link administrativo/debug, requer escopo whatsapp:media e o mesmo identity que o gerou. Prefira read_message_attachment para leitura normal.';
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[get_message_media_info] erro detalhado:', err);
        return { content: [{ type: 'text', text: `Falha ao obter mídia: ${err.message}` }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'read_message_attachment',
    {
      title: 'Ler o conteúdo de um anexo (PDF, DOCX, TXT, CSV, JSON, XML, imagem, áudio)',
      description:
        'Lê o CONTEÚDO de um anexo de mensagem diretamente pelo MCP (sem precisar acessar nenhuma URL externa): ' +
        'baixa a mídia do WhatsApp no servidor, identifica o tipo e extrai o texto (PDF/DOCX/TXT/CSV/JSON/XML), ' +
        'devolve a imagem direto na resposta (JPEG/PNG/WEBP, até um tamanho limite) ou transcreve áudio (requer ' +
        'escopo whatsapp:transcribe; resultado fica em cache - a mesma mensagem não é transcrita duas vezes). Para ' +
        'vídeo, devolve só metadados. Nunca inventa conteúdo: se o PDF não tiver texto embutido (ex: documento ' +
        'escaneado) ou a transcrição falhar, avisa isso explicitamente em vez de inventar.',
      inputSchema: {
        message_id: z.string().describe('ID real da mensagem (campo message_id retornado por get_chat_history/search_messages).'),
        mode: z.literal('auto').optional().describe('Reservado para o futuro (ex: forçar modo texto/metadados). Hoje só existe "auto".'),
      },
    },
    async ({ message_id }, extra) => {
      try {
        const featureError = requireFeature('FEATURE_MEDIA_READING');
        if (featureError) return featureError;
        requireWhatsappReady();
        const scopeError = requireScope(extra, 'whatsapp:media');
        if (scopeError) return scopeError;

        const raw = await fetchRawMessage(message_id);
        if (!raw) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'message_not_found' }, null, 2) }], isError: true };
        }
        const info = formatMessage(raw);
        if (!info.has_media) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'no_media' }, null, 2) }], isError: true };
        }

        const media = await downloadMessageMedia(message_id);
        if (!media) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'download_failed' }, null, 2) }], isError: true };
        }
        const buffer = Buffer.from(media.data, 'base64');
        const mimetype = media.mimetype || info.mimetype || 'application/octet-stream';
        const filename = media.filename || info.filename || null;
        const size = media.filesize || buffer.length;

        const base = { message_id, filename, mimetype, size };
        const canTranscribe = (extra?.authInfo?.scopes || []).includes('whatsapp:transcribe');
        const processed = await processAttachment({
          buffer,
          mimetype,
          filename,
          size,
          messageId: message_id,
          rawDurationSeconds: raw.duration ?? null,
          canTranscribe,
        });
        log('read_message_attachment', message_id, mimetype, size, 'bytes');

        const structured = { success: true, ...base, ...processed.fields };
        const contentBlocks = [{ type: 'text', text: JSON.stringify(structured, null, 2) }];
        if (processed.imageBlock) contentBlocks.push(processed.imageBlock);
        return { content: contentBlocks };
      } catch (err) {
        console.error('[read_message_attachment] erro detalhado:', err);
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'internal_error', message: err.message }, null, 2) }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'transcribe_message_audio',
    {
      title: 'Transcrever um áudio do WhatsApp',
      description:
        'Transcreve o áudio de uma mensagem (requer escopo whatsapp:transcribe). READ-ONLY: baixar e transcrever o ' +
        'áudio não reproduz, não marca como ouvido/lido, não envia confirmação de leitura. Resultado fica em cache ' +
        '(por message_id e por hash do áudio) - chamar de novo para a mesma mensagem não gera novo custo de API.',
      inputSchema: {
        message_id: z.string().describe('ID real da mensagem de áudio (campo message_id retornado por get_chat_history/search_messages/get_unread_chats).'),
      },
    },
    async ({ message_id }, extra) => {
      try {
        const featureError = requireFeature('FEATURE_TRANSCRIPTION');
        if (featureError) return featureError;
        const scopeError = requireScope(extra, 'whatsapp:transcribe');
        if (scopeError) return scopeError;
        requireWhatsappReady();

        const raw = await fetchRawMessage(message_id);
        if (!raw) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'message_not_found' }, null, 2) }], isError: true };
        }
        const info = formatMessage(raw);
        if (!info.has_media || !(info.mimetype || '').startsWith('audio/')) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'not_audio' }, null, 2) }], isError: true };
        }
        const media = await downloadMessageMedia(message_id);
        if (!media) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'download_failed' }, null, 2) }], isError: true };
        }
        const result = await transcribeAudio({
          messageId: message_id,
          buffer: Buffer.from(media.data, 'base64'),
          mimetype: media.mimetype || info.mimetype,
          filename: media.filename || info.filename,
          durationSeconds: raw.duration ?? null,
          cache: transcriptionCache,
          log,
        });
        if (!result.success) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, ...result }, null, 2) }], isError: true };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message_id,
                  mimetype: media.mimetype || info.mimetype,
                  duration_seconds: result.duration_seconds,
                  transcription: result.transcription,
                  transcription_source: result.transcription_source,
                  model: result.model,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        console.error('[transcribe_message_audio] erro detalhado:', err);
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'internal_error', message: err.message }, null, 2) }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'download_message_attachment',
    {
      title: 'Baixar um anexo recebido e guardar com storage_id',
      description:
        'READ-ONLY em relação ao WhatsApp (só baixa, não marca como lida/ouvida). Baixa o anexo de uma mensagem e ' +
        'guarda no armazenamento controlado do servidor, retornando um storage_id - use esse storage_id depois em ' +
        'send_file/send_document/send_media para reenviar o MESMO arquivo (ex: "pegue o PDF que o João mandou e ' +
        'envie pro grupo X"). destination="temporary" expira em 24h; "persistent" fica guardado até ser apagado.',
      inputSchema: {
        message_id: z.string().describe('ID real da mensagem com anexo (de get_chat_history/search_messages/get_unread_chats).'),
        destination: z.enum(['temporary', 'persistent']).optional().describe('Padrão "temporary" (expira em 24h). "persistent" fica guardado indefinidamente.'),
      },
    },
    async ({ message_id, destination }, extra) => {
      try {
        const featureError = requireFeature('FEATURE_FILE_DOWNLOAD');
        if (featureError) return featureError;
        const scopeError = requireScope(extra, 'whatsapp:media');
        if (scopeError) return scopeError;
        requireWhatsappReady();
        log('[WHATSAPP-MCP][FILE] download', message_id);

        const raw = await fetchRawMessage(message_id);
        if (!raw) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'message_not_found' }, null, 2) }], isError: true };
        }
        const info = formatMessage(raw);
        if (!info.has_media) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'no_media' }, null, 2) }], isError: true };
        }
        const media = await downloadMessageMedia(message_id);
        if (!media) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'download_failed' }, null, 2) }], isError: true };
        }
        const buffer = Buffer.from(media.data, 'base64');
        if (buffer.length > MAX_FILE_SIZE_BYTES) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'file_too_large' }, null, 2) }], isError: true };
        }
        const storageId = `file_${randomUUID().replace(/-/g, '')}`;
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        fs.writeFileSync(path.join(FILES_BLOBS_DIR, storageId), buffer);
        const isPersistent = destination === 'persistent';
        const entry = fileRegistry.put({
          storage_id: storageId,
          filename: media.filename || info.filename || sanitizeFilename(storageId),
          mimetype: media.mimetype || info.mimetype || 'application/octet-stream',
          size: buffer.length,
          hash,
          created_at: new Date().toISOString(),
          expires_at: isPersistent ? null : new Date(Date.now() + FILES_TMP_TTL_MS).toISOString(),
          source: 'whatsapp_download',
          source_message_id: message_id,
        });
        fileRegistry.cleanupExpired();
        log('[WHATSAPP-MCP][FILE] download ok', storageId, entry.mimetype, entry.size, 'bytes');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message_id,
                  filename: entry.filename,
                  mimetype: entry.mimetype,
                  size: entry.size,
                  hash: entry.hash,
                  storage_id: entry.storage_id,
                  local_reference: `storage_id:${entry.storage_id}`,
                  destination: isPersistent ? 'persistent' : 'temporary',
                  expires_at: entry.expires_at,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        console.error('[download_message_attachment] erro detalhado:', err);
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, message_id, error: 'internal_error', message: err.message }, null, 2) }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'import_file',
    {
      title: 'Importar um arquivo já autorizado no servidor para o armazenamento do WhatsApp MCP',
      description:
        'Copia um arquivo de um diretório EXPLICITAMENTE AUTORIZADO nesta instância (configurado via ' +
        'FILE_ALLOWED_PATHS no .env - ex: exports de outro sistema seu) para o armazenamento controlado do WhatsApp MCP, ' +
        'retornando um storage_id para usar em send_file/send_document/send_media. NÃO aceita paths fora da ' +
        'allowlist, nem ".." nem symlinks que apontem pra fora dela.',
      inputSchema: {
        source_path: z.string().describe('Caminho absoluto do arquivo, dentro de um diretório autorizado (FILE_ALLOWED_PATHS).'),
        filename: z.string().optional().describe('Nome a usar ao enviar depois (padrão: nome original do arquivo).'),
      },
    },
    async ({ source_path, filename }, extra) => {
      try {
        const scopeError = requireScope(extra, 'whatsapp:media');
        if (scopeError) return scopeError;
        log('[WHATSAPP-MCP][FILE] import', source_path ? path.basename(source_path) : null);

        const resolved = resolveAllowedPath(source_path);
        if (!resolved.ok) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: resolved.error }, null, 2) }], isError: true };
        }
        if (resolved.size > MAX_FILE_SIZE_BYTES) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'file_too_large' }, null, 2) }], isError: true };
        }
        const buffer = fs.readFileSync(resolved.path);
        const mimetype = mimetypeFromExtension(resolved.path) || 'application/octet-stream';
        const storageId = `file_${randomUUID().replace(/-/g, '')}`;
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        fs.writeFileSync(path.join(FILES_BLOBS_DIR, storageId), buffer);
        const entry = fileRegistry.put({
          storage_id: storageId,
          filename: sanitizeFilename(filename || path.basename(resolved.path)),
          mimetype,
          size: buffer.length,
          hash,
          created_at: new Date().toISOString(),
          expires_at: null,
          source: 'import',
          source_path: resolved.path,
        });
        log('[WHATSAPP-MCP][FILE] import ok', storageId, entry.mimetype, entry.size, 'bytes');
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...entry }, null, 2) }] };
      } catch (err) {
        console.error('[import_file] erro detalhado:', err);
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'internal_error', message: err.message }, null, 2) }], isError: true };
      }
    }
  );

  mcpServer.registerTool(
    'upload_temp_file',
    {
      title: 'Enviar um arquivo temporário para o WhatsApp MCP (ingestão remota)',
      description:
        'Entrega ao WhatsApp MCP um arquivo que existe SÓ no SEU ambiente (não na VPS) - ex: um documento que você ' +
        '(Claude/ChatGPT) tem disponível na conversa. Retorna um temp_file_id para usar em send_file/send_document/' +
        'send_media/send_files. O arquivo é APAGADO automaticamente assim que o envio pelo WhatsApp for confirmado ' +
        `(ou expira em ${TEMP_FILE_TTL_MINUTES} minutos se nunca for usado) - não é armazenamento permanente. Use ` +
        `content_base64 SÓ para arquivos pequenos (até ${TEMP_BASE64_MAX_MB}MB decodificado - não é prático para ` +
        'fotos/PDFs de tamanho normal) ou source_url (HTTPS pública) para arquivos maiores que você já hospeda. ' +
        'Para um arquivo de tamanho comum que o USUÁRIO tem no PC/celular dele (não você), NÃO peça para ele mandar ' +
        'em base64 - oriente a usar a página de upload no navegador (rota /upload desta instância) e depois use ' +
        'list_temp_files/get_temp_batch para achar o temp_file_id gerado lá. NÃO tente enviar um caminho do SEU ' +
        'ambiente (ex: "C:\\Users\\...", "/mnt/user-data/...") - esse caminho não existe no servidor.',
      inputSchema: {
        filename: z.string().describe('Nome do arquivo (usado para inferir o tipo e no envio depois).'),
        content_base64: z.string().optional().describe(`Conteúdo em base64 - só para arquivos pequenos (até ${TEMP_BASE64_MAX_MB}MB decodificado). Use isto OU source_url.`),
        source_url: z.string().optional().describe('URL HTTPS pública de onde baixar o arquivo (para arquivos maiores que o limite de base64). Use isto OU content_base64.'),
        mimetype: z.string().optional().describe('Mimetype explícito (padrão: inferido pela extensão do filename).'),
      },
    },
    async ({ filename, content_base64, source_url, mimetype }, extra) => {
      const featureError = requireFeature('FEATURE_TEMP_FILE_UPLOAD');
      if (featureError) return featureError;
      const scopeError = requireScope(extra, 'whatsapp:file_upload');
      if (scopeError) return scopeError;

      const errResp = (error, message) => ({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error, message }, null, 2) }],
        isError: true,
      });

      const providedSources = [content_base64, source_url].filter((v) => v !== undefined && v !== '');
      if (providedSources.length !== 1) {
        return errResp('exactly_one_source_required', 'Informe exatamente um entre content_base64 ou source_url.');
      }
      const safeFilename = sanitizeFilename(filename);
      if (!safeFilename) {
        return errResp('invalid_filename', 'Nome de arquivo inválido.');
      }

      let buffer;
      let sourceType;
      try {
        if (content_base64 !== undefined) {
          sourceType = 'base64';
          // Checa o tamanho aproximado ANTES de decodificar (base64 ~4/3 do
          // tamanho real) - evita alocar um buffer gigante só para rejeitar
          // em seguida.
          const approxBytes = Math.floor((content_base64.length * 3) / 4);
          if (approxBytes > TEMP_BASE64_MAX_BYTES) {
            return errResp('file_too_large_for_base64', `Arquivo muito grande para base64 (~${approxBytes} bytes > limite de ${TEMP_BASE64_MAX_BYTES} bytes / ${TEMP_BASE64_MAX_MB}MB). Use source_url.`);
          }
          buffer = Buffer.from(content_base64, 'base64');
          if (buffer.length > TEMP_BASE64_MAX_BYTES) {
            return errResp('file_too_large_for_base64', `Arquivo decodificado tem ${buffer.length} bytes, acima do limite de ${TEMP_BASE64_MAX_BYTES} bytes (${TEMP_BASE64_MAX_MB}MB) para base64. Use source_url.`);
          }
        } else {
          sourceType = 'source_url';
          buffer = await fetchUrlWithSsrfProtection(source_url, { maxBytes: MAX_FILE_SIZE_BYTES });
        }
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          log('[WHATSAPP-MCP][TEMP] source_url bloqueada', err.message);
          return errResp('source_url_blocked', err.message);
        }
        return errResp('download_failed', err.message);
      }

      if (buffer.length === 0) {
        return errResp('empty_file', 'Arquivo vazio.');
      }
      if (buffer.length > MAX_FILE_SIZE_BYTES) {
        return errResp('file_too_large', `Arquivo de ${buffer.length} bytes excede o limite de ${MAX_FILE_SIZE_BYTES} bytes.`);
      }

      const resolvedMimetype = mimetype || mimetypeFromExtension(safeFilename) || 'application/octet-stream';
      const tempFileId = `tmp_${randomUUID().replace(/-/g, '')}`;
      const hash = sha256Hex(buffer);
      fs.writeFileSync(tempFileStore.blobPath(tempFileId), buffer);
      const expiresAt = new Date(Date.now() + TEMP_FILE_TTL_MINUTES * 60 * 1000).toISOString();
      const entry = tempFileStore.put({
        temp_file_id: tempFileId,
        filename: safeFilename,
        mimetype: resolvedMimetype,
        size: buffer.length,
        hash,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        status: 'uploaded',
        source: sourceType,
      });
      auditLog({ action: 'upload_temp_file', ok: true, identityId: extra?.authInfo?.extra?.identityId, temp_file_id: tempFileId, mimetype: resolvedMimetype, size: buffer.length, source: sourceType });
      log('[WHATSAPP-MCP][TEMP] upload ok', tempFileId, resolvedMimetype, buffer.length, 'bytes via', sourceType);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                instance_display_name: INSTANCE_DISPLAY_NAME,
                temp_file_id: entry.temp_file_id,
                filename: entry.filename,
                mimetype: entry.mimetype,
                size: entry.size,
                expires_at: entry.expires_at,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  mcpServer.registerTool(
    'list_temp_files',
    {
      title: 'Listar arquivos temporários disponíveis (upload_temp_file ou página de upload)',
      description:
        'Lista arquivos AINDA disponíveis (não enviados, não expirados) na área temporária desta instância - vindos ' +
        'de upload_temp_file OU da página de upload no navegador (/upload). Use query para filtrar por referência/' +
        'label ou nome de arquivo (ex: "Renato" encontra tudo com esse texto no label ou no filename, case-' +
        'insensitive). Sem query, lista tudo. Use isto quando o usuário mencionar "os arquivos que eu subi", um ' +
        'nome/referência de lote, ou "os documentos temporários" - NUNCA tente adivinhar um caminho local do ' +
        'ambiente do usuário (ex: "C:\\Users\\...", "/mnt/user-data/...") - esses não existem no servidor.',
      inputSchema: {
        query: z.string().optional().describe('Texto livre - filtra por label ou filename (substring, sem diferenciar maiúsculas/minúsculas).'),
      },
    },
    async ({ query }, extra) => {
      const featureError = requireFeature('FEATURE_TEMP_FILE_UPLOAD');
      if (featureError) return featureError;
      const scopeError = requireScope(extra, 'whatsapp:file_upload');
      if (scopeError) return scopeError;

      const all = tempFileStore.list();
      const needle = (query || '').trim().toLowerCase();
      const filtered = needle
        ? all.filter((e) => (e.label || '').toLowerCase().includes(needle) || (e.filename || '').toLowerCase().includes(needle))
        : all;
      filtered.sort((a, b) => {
        if (a.batch_id && b.batch_id && a.batch_id === b.batch_id) return (a.batch_order ?? 0) - (b.batch_order ?? 0);
        return new Date(b.created_at) - new Date(a.created_at);
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                instance_display_name: INSTANCE_DISPLAY_NAME,
                count: filtered.length,
                files: filtered.map((e) => ({
                  temp_file_id: e.temp_file_id,
                  filename: e.filename,
                  batch_id: e.batch_id || null,
                  label: e.label || null,
                  mimetype: e.mimetype,
                  size: e.size,
                  created_at: e.created_at,
                  expires_at: e.expires_at,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  mcpServer.registerTool(
    'get_temp_batch',
    {
      title: 'Obter os arquivos de um lote de upload temporário (na ordem original)',
      description:
        'Busca um lote de arquivos enviado de uma vez pela página de upload (/upload) - por batch_id (exato) OU ' +
        'label/referência (exato, case-insensitive). Devolve os arquivos NA ORDEM original de upload, prontos para ' +
        'usar em send_files. Se mais de um lote tiver a mesma label, NÃO escolhe sozinho - lista os candidatos para ' +
        'você (ou o usuário) decidir por batch_id.',
      inputSchema: {
        batch_id: z.string().optional().describe('ID do lote (retornado pela página de upload ou por list_temp_files). Use isto OU label.'),
        label: z.string().optional().describe('Referência/label informada no upload (ex: "Renato Silva do Nascimento"). Use isto OU batch_id.'),
      },
    },
    async ({ batch_id, label }, extra) => {
      const featureError = requireFeature('FEATURE_TEMP_FILE_UPLOAD');
      if (featureError) return featureError;
      const scopeError = requireScope(extra, 'whatsapp:file_upload');
      if (scopeError) return scopeError;

      const errResp = (error, message, extraFields) => ({
        content: [{ type: 'text', text: JSON.stringify({ success: false, error, message, ...extraFields }, null, 2) }],
        isError: true,
      });

      if (!batch_id && !label) {
        return errResp('missing_query', 'Informe batch_id ou label.');
      }

      const all = tempFileStore.list();
      let targetBatchId = batch_id;

      if (!targetBatchId) {
        const needle = label.trim().toLowerCase();
        const batchIds = [...new Set(all.filter((e) => e.batch_id && (e.label || '').toLowerCase() === needle).map((e) => e.batch_id))];
        if (batchIds.length === 0) {
          return errResp('batch_not_found', `Nenhum lote encontrado com label "${label}" (pode já ter sido todo enviado, expirado, ou a label não bate exatamente - tente list_temp_files para conferir).`);
        }
        if (batchIds.length > 1) {
          const candidates = batchIds.map((id) => {
            const entries = all.filter((e) => e.batch_id === id);
            return {
              batch_id: id,
              label: entries[0].label,
              files: entries.length,
              created_at: entries.reduce((min, e) => (e.created_at < min ? e.created_at : min), entries[0].created_at),
            };
          });
          return errResp('ambiguous_label', 'Mais de um lote com essa label - especifique batch_id.', { candidates });
        }
        targetBatchId = batchIds[0];
      }

      const files = all.filter((e) => e.batch_id === targetBatchId).sort((a, b) => (a.batch_order ?? 0) - (b.batch_order ?? 0));
      if (!files.length) {
        return errResp('batch_not_found', `Lote "${targetBatchId}" não encontrado (pode já ter sido todo enviado/expirado).`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                instance_display_name: INSTANCE_DISPLAY_NAME,
                batch_id: targetBatchId,
                label: files[0].label || null,
                files: files.map((e) => ({ temp_file_id: e.temp_file_id, filename: e.filename, mimetype: e.mimetype, size: e.size })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  mcpServer.registerTool(
    'forward_message',
    {
      title: `Encaminhar uma mensagem de texto do ${INSTANCE_DISPLAY_NAME} para outro contato/grupo`,
      description:
        `WRITE: encaminha uma mensagem de TEXTO já existente no ${INSTANCE_DISPLAY_NAME} para outro contato/grupo ` +
        'da MESMA instância, sem reescrever o conteúdo. Tenta encaminhamento nativo do WhatsApp primeiro ' +
        '(forward_mode="native" no resultado); se não disponível nesta versão do WhatsApp Web, copia o texto ' +
        'original via send_message (forward_mode="copied") - nunca afirma "native" quando não foi. Localizar a ' +
        'mensagem (get_chat_history/search_messages) é READ-ONLY; só este encaminhamento é WRITE. Para mensagem ' +
        'com anexo, use forward_attachment.',
      inputSchema: {
        message_id: z.string().describe('ID real da mensagem de texto a encaminhar (de get_chat_history/search_messages).'),
        destination: z.string().describe('Nome do contato/grupo de destino (resolvido automaticamente) ou chat_id.'),
        request_id: z.string().optional().describe('Chave de idempotência opcional - repetir com o mesmo request_id não reenvia.'),
      },
    },
    async ({ message_id, destination, request_id }, extra) => {
      const featureError = requireFeature('FEATURE_FORWARD_MESSAGE');
      if (featureError) return featureError;
      const scopeError = requireScope(extra, 'whatsapp:forward') || requireScope(extra, 'whatsapp:read');
      if (scopeError) return scopeError;
      requireWhatsappReady();

      if (request_id) {
        const cached = idempotencyStore.get(request_id);
        if (cached) return { content: [{ type: 'text', text: JSON.stringify({ ...cached, idempotent: true }, null, 2) }] };
      }

      try {
        const raw = await fetchRawMessage(message_id);
        if (!raw) return toolErrorResponse('message_not_found', `Mensagem ${message_id} não encontrada (pode não estar mais carregada na sessão).`);
        const info = formatMessage(raw);
        if (info.has_media) {
          return toolErrorResponse('use_forward_attachment', 'Esta mensagem tem anexo - use forward_attachment em vez de forward_message.');
        }

        const resolved = await resolveTargetChat({ chat_id: destination, contact: destination });
        if (!resolved.ok) return resolvedFailureResponse(resolved);

        const native = await tryNativeForward(message_id, resolved.chat_id);
        let forwardMode = 'native';
        let sentMessageId = null;
        if (!native.ok) {
          forwardMode = 'copied';
          log('[WHATSAPP-MCP][FORWARD] native indisponível (', native.reason, ') - usando fallback de cópia');
          const sent = await waClient.sendMessage(resolved.chat_id, info.body || '');
          sentMessageId = sent?.id?._serialized || null;
        }

        const result = {
          success: true,
          source_message_id: message_id,
          destination_chat_id: resolved.chat_id,
          type: 'text',
          body_preview: (info.body || '').slice(0, 200),
          forward_mode: forwardMode,
          sent_message_id: sentMessageId,
        };
        auditLog({ action: 'forward_message', ok: true, identityId: extra?.authInfo?.extra?.identityId, destination: maskChatId(resolved.chat_id), forward_mode: forwardMode });
        log('[WHATSAPP-MCP][FORWARD] forward_message ok', maskChatId(resolved.chat_id), forwardMode);
        if (request_id) idempotencyStore.put(request_id, result);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[forward_message] erro detalhado:', err);
        auditLog({ action: 'forward_message', ok: false, identityId: extra?.authInfo?.extra?.identityId, error: err.message });
        return toolErrorResponse('forward_failed', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'forward_attachment',
    {
      title: `Encaminhar um anexo do ${INSTANCE_DISPLAY_NAME} para outro contato/grupo`,
      description:
        `WRITE: encaminha o ANEXO ORIGINAL (documento/imagem/áudio/vídeo) de uma mensagem já existente no ` +
        `${INSTANCE_DISPLAY_NAME} para outro contato/grupo - fluxo inteiramente WHATSAPP → VPS → WHATSAPP, o ` +
        'arquivo NUNCA passa pelo cliente MCP (sem base64, sem /upload manual). Tenta encaminhamento nativo ' +
        'primeiro (forward_mode="native"); se não disponível, baixa internamente e reenvia preservando bytes/' +
        'mimetype/filename originais, sem recomprimir (forward_mode="copied"). Para encontrar a mensagem certa a ' +
        'partir de uma descrição (ex: "o RG do Renato"), use find_and_forward_file antes.',
      inputSchema: {
        message_id: z.string().describe('ID real da mensagem com anexo a encaminhar.'),
        destination: z.string().describe('Nome do contato/grupo de destino (resolvido automaticamente) ou chat_id.'),
        caption: z.string().optional().describe('Legenda opcional - só é usada se cair no fallback de cópia (native preserva a legenda original automaticamente).'),
        request_id: z.string().optional().describe('Chave de idempotência opcional.'),
      },
    },
    async ({ message_id, destination, caption, request_id }, extra) => {
      const featureError = requireFeature('FEATURE_FORWARD_ATTACHMENT');
      if (featureError) return featureError;
      const scopeError = requireScope(extra, 'whatsapp:forward') || requireScope(extra, 'whatsapp:media');
      if (scopeError) return scopeError;
      requireWhatsappReady();

      if (request_id) {
        const cached = idempotencyStore.get(request_id);
        if (cached) return { content: [{ type: 'text', text: JSON.stringify({ ...cached, idempotent: true }, null, 2) }] };
      }

      try {
        const raw = await fetchRawMessage(message_id);
        if (!raw) return toolErrorResponse('message_not_found', `Mensagem ${message_id} não encontrada (pode não estar mais carregada na sessão).`);
        const info = formatMessage(raw);
        if (!info.has_media) {
          return toolErrorResponse('no_media', 'Esta mensagem não tem anexo - use forward_message para texto.');
        }

        const resolved = await resolveTargetChat({ chat_id: destination, contact: destination });
        if (!resolved.ok) return resolvedFailureResponse(resolved);

        const native = await tryNativeForward(message_id, resolved.chat_id);
        let forwardMode = 'native';
        let sentMessageId = null;
        let filename = info.filename;
        let mimetype = info.mimetype;
        let size = null;

        if (!native.ok) {
          forwardMode = 'copied';
          log('[WHATSAPP-MCP][FORWARD] native indisponível (', native.reason, ') - usando fallback de download+reenvio');
          const media = await downloadMessageMedia(message_id);
          if (!media) return toolErrorResponse('download_failed', 'Não consegui baixar o anexo original desta mensagem.');
          const buffer = Buffer.from(media.data, 'base64');
          if (buffer.length > MAX_FILE_SIZE_BYTES) {
            return toolErrorResponse('file_too_large', `Anexo de ${buffer.length} bytes excede o limite de ${MAX_FILE_SIZE_BYTES} bytes.`);
          }
          mimetype = media.mimetype || info.mimetype || 'application/octet-stream';
          filename = media.filename || info.filename;
          size = buffer.length;
          const sent = await sendFileCore({
            targetId: resolved.chat_id,
            buffer,
            mimetype,
            filename,
            caption: caption ?? info.caption ?? undefined,
            mode: 'auto',
          });
          sentMessageId = sent.message_id;
        }

        const result = {
          success: true,
          source_message_id: message_id,
          destination_chat_id: resolved.chat_id,
          type: 'attachment',
          filename,
          mimetype,
          size,
          forward_mode: forwardMode,
          sent_message_id: sentMessageId,
        };
        auditLog({ action: 'forward_attachment', ok: true, identityId: extra?.authInfo?.extra?.identityId, destination: maskChatId(resolved.chat_id), forward_mode: forwardMode, mimetype, size });
        log('[WHATSAPP-MCP][FORWARD] forward_attachment ok', maskChatId(resolved.chat_id), forwardMode, mimetype);
        if (request_id) idempotencyStore.put(request_id, result);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[forward_attachment] erro detalhado:', err);
        auditLog({ action: 'forward_attachment', ok: false, identityId: extra?.authInfo?.extra?.identityId, error: err.message });
        return toolErrorResponse('forward_failed', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'find_and_forward_file',
    {
      title: `Procurar um anexo no ${INSTANCE_DISPLAY_NAME} por descrição e encaminhar`,
      description:
        `READ para a busca + WRITE só no encaminhamento final. Procura em um chat de ORIGEM do ${INSTANCE_DISPLAY_NAME} ` +
        '(por nome/filename/legenda/transcrição) um anexo que bata com a descrição e, se encontrar EXATAMENTE UM, ' +
        'encaminha para o destino (WHATSAPP → VPS → WHATSAPP, sem passar pelo cliente MCP). Se houver MAIS DE UM ' +
        'candidato plausível, NÃO escolhe sozinho - devolve a lista de candidatos (message_id, filename, data) para ' +
        'você decidir, e você chama forward_attachment diretamente com o message_id certo. Exemplo: ' +
        '"Procure no grupo DOCUMENTOS o RG do Renato e envie para OPERACIONAL."',
      inputSchema: {
        source_chat: z.string().describe('Nome do chat/grupo de origem (resolvido automaticamente) ou chat_id.'),
        query: z.string().describe('Descrição livre do arquivo (ex: "CNIS Renato", "RG do Renato").'),
        destination: z.string().describe('Nome do contato/grupo de destino ou chat_id.'),
        caption: z.string().optional().describe('Legenda opcional (só usada no fallback de cópia).'),
        request_id: z.string().optional().describe('Chave de idempotência opcional.'),
      },
    },
    async ({ source_chat, query, destination, caption, request_id }, extra) => {
      const featureError = requireFeature('FEATURE_FIND_AND_FORWARD');
      if (featureError) return featureError;
      const scopeError = requireScope(extra, 'whatsapp:forward') || requireScope(extra, 'whatsapp:read') || requireScope(extra, 'whatsapp:media');
      if (scopeError) return scopeError;
      requireWhatsappReady();

      if (request_id) {
        const cached = idempotencyStore.get(request_id);
        if (cached) return { content: [{ type: 'text', text: JSON.stringify({ ...cached, idempotent: true }, null, 2) }] };
      }

      try {
        const resolvedSource = await resolveTargetChat({ chat_id: source_chat, contact: source_chat });
        if (!resolvedSource.ok) return resolvedFailureResponse(resolvedSource);
        const resolvedDest = await resolveTargetChat({ chat_id: destination, contact: destination });
        if (!resolvedDest.ok) return resolvedFailureResponse(resolvedDest);

        const canTranscribe = (extra?.authInfo?.scopes || []).includes('whatsapp:transcribe');
        const found = await findAttachmentCandidates({ chatId: resolvedSource.chat_id, query, canTranscribe });
        if (!found.ok) return toolErrorResponse(found.error, 'Falha ao procurar no chat de origem.');

        if (found.candidates.length === 0) {
          return toolErrorResponse('not_found', `Nenhum anexo encontrado em "${source_chat}" batendo com "${query}" (vasculhadas ${found.scanned} mensagens).`);
        }
        if (found.candidates.length > 1) {
          return toolErrorResponse('ambiguous', 'Mais de um arquivo plausível - escolha um message_id e use forward_attachment diretamente.', { candidates: found.candidates });
        }

        const picked = found.candidates[0];
        const native = await tryNativeForward(picked.message_id, resolvedDest.chat_id);
        let forwardMode = 'native';
        let sentMessageId = null;
        let filename = picked.filename;
        let mimetype = picked.mimetype;
        let size = null;

        if (!native.ok) {
          forwardMode = 'copied';
          const media = await downloadMessageMedia(picked.message_id);
          if (!media) return toolErrorResponse('download_failed', 'Não consegui baixar o anexo encontrado.');
          const buffer = Buffer.from(media.data, 'base64');
          if (buffer.length > MAX_FILE_SIZE_BYTES) {
            return toolErrorResponse('file_too_large', `Anexo de ${buffer.length} bytes excede o limite de ${MAX_FILE_SIZE_BYTES} bytes.`);
          }
          mimetype = media.mimetype || picked.mimetype || 'application/octet-stream';
          filename = media.filename || picked.filename;
          size = buffer.length;
          const sent = await sendFileCore({ targetId: resolvedDest.chat_id, buffer, mimetype, filename, caption: caption ?? picked.caption ?? undefined, mode: 'auto' });
          sentMessageId = sent.message_id;
        }

        const result = {
          success: true,
          source_chat_id: resolvedSource.chat_id,
          source_message_id: picked.message_id,
          destination_chat_id: resolvedDest.chat_id,
          filename,
          mimetype,
          size,
          forward_mode: forwardMode,
          sent_message_id: sentMessageId,
        };
        auditLog({ action: 'find_and_forward_file', ok: true, identityId: extra?.authInfo?.extra?.identityId, source: maskChatId(resolvedSource.chat_id), destination: maskChatId(resolvedDest.chat_id), forward_mode: forwardMode });
        log('[WHATSAPP-MCP][FORWARD] find_and_forward_file ok', maskChatId(resolvedSource.chat_id), '->', maskChatId(resolvedDest.chat_id), forwardMode);
        if (request_id) idempotencyStore.put(request_id, result);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[find_and_forward_file] erro detalhado:', err);
        auditLog({ action: 'find_and_forward_file', ok: false, identityId: extra?.authInfo?.extra?.identityId, error: err.message });
        return toolErrorResponse('forward_failed', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'find_and_forward_files',
    {
      title: `Procurar vários anexos no ${INSTANCE_DISPLAY_NAME} e encaminhar (lote)`,
      description:
        'Igual a find_and_forward_file, mas para várias descrições de uma vez - processa `queries` NA ORDEM ' +
        'informada, continua mesmo se uma falhar/for ambígua, e informa o resultado individual de cada uma (não ' +
        'esconde falhas parciais). Exemplo: queries=["CNIS Renato","RG Renato","comprovante Renato"].',
      inputSchema: {
        source_chat: z.string().describe('Nome do chat/grupo de origem ou chat_id.'),
        queries: z.array(z.string()).min(1).describe('Descrições, NA ORDEM em que devem ser processadas/encaminhadas.'),
        destination: z.string().describe('Nome do contato/grupo de destino ou chat_id.'),
        request_id: z.string().optional().describe('Chave de idempotência opcional para o lote inteiro.'),
      },
    },
    async ({ source_chat, queries, destination, request_id }, extra) => {
      const featureError = requireFeature('FEATURE_FIND_AND_FORWARD');
      if (featureError) return featureError;
      const scopeError = requireScope(extra, 'whatsapp:forward') || requireScope(extra, 'whatsapp:read') || requireScope(extra, 'whatsapp:media');
      if (scopeError) return scopeError;
      requireWhatsappReady();

      if (request_id) {
        const cached = idempotencyStore.get(request_id);
        if (cached) return { content: [{ type: 'text', text: JSON.stringify({ ...cached, idempotent: true }, null, 2) }] };
      }

      try {
        const resolvedSource = await resolveTargetChat({ chat_id: source_chat, contact: source_chat });
        if (!resolvedSource.ok) return resolvedFailureResponse(resolvedSource);
        const resolvedDest = await resolveTargetChat({ chat_id: destination, contact: destination });
        if (!resolvedDest.ok) return resolvedFailureResponse(resolvedDest);

        const canTranscribe = (extra?.authInfo?.scopes || []).includes('whatsapp:transcribe');
        const results = [];
        for (const query of queries) {
          const found = await findAttachmentCandidates({ chatId: resolvedSource.chat_id, query, canTranscribe });
          if (!found.ok) {
            results.push({ query, success: false, error: found.error });
            continue;
          }
          if (found.candidates.length === 0) {
            results.push({ query, success: false, error: 'not_found' });
            continue;
          }
          if (found.candidates.length > 1) {
            results.push({ query, success: false, error: 'ambiguous', candidates: found.candidates });
            continue;
          }
          const picked = found.candidates[0];
          try {
            const native = await tryNativeForward(picked.message_id, resolvedDest.chat_id);
            let forwardMode = 'native';
            let sentMessageId = null;
            let filename = picked.filename;
            let mimetype = picked.mimetype;
            let size = null;
            if (!native.ok) {
              forwardMode = 'copied';
              const media = await downloadMessageMedia(picked.message_id);
              if (!media) {
                results.push({ query, success: false, error: 'download_failed' });
                continue;
              }
              const buffer = Buffer.from(media.data, 'base64');
              if (buffer.length > MAX_FILE_SIZE_BYTES) {
                results.push({ query, success: false, error: 'file_too_large' });
                continue;
              }
              mimetype = media.mimetype || picked.mimetype || 'application/octet-stream';
              filename = media.filename || picked.filename;
              size = buffer.length;
              const sent = await sendFileCore({ targetId: resolvedDest.chat_id, buffer, mimetype, filename, caption: picked.caption ?? undefined, mode: 'auto' });
              sentMessageId = sent.message_id;
            }
            results.push({ query, success: true, source_message_id: picked.message_id, filename, mimetype, size, forward_mode: forwardMode, sent_message_id: sentMessageId });
            log('[WHATSAPP-MCP][FORWARD] find_and_forward_files item ok', query, forwardMode);
          } catch (err) {
            results.push({ query, success: false, error: 'forward_failed', message: err.message });
          }
        }

        const sentCount = results.filter((r) => r.success).length;
        const result = {
          success: sentCount === queries.length,
          source_chat_id: resolvedSource.chat_id,
          destination_chat_id: resolvedDest.chat_id,
          requested: queries.length,
          sent: sentCount,
          failed: queries.length - sentCount,
          results,
        };
        auditLog({ action: 'find_and_forward_files', ok: result.success, identityId: extra?.authInfo?.extra?.identityId, source: maskChatId(resolvedSource.chat_id), destination: maskChatId(resolvedDest.chat_id), sent: sentCount, failed: result.failed });
        if (request_id) idempotencyStore.put(request_id, result);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result.failed > 0 && sentCount === 0 };
      } catch (err) {
        console.error('[find_and_forward_files] erro detalhado:', err);
        return toolErrorResponse('internal_error', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'list_drive_connections',
    {
      title: 'Listar conexões Google Drive disponíveis',
      description:
        'READ-ONLY. Lista as conexões Google Drive já autorizadas nesta instância (nunca mostra tokens). Use para ' +
        'conferir o connection_id/display_name antes de uma busca, ou qual é a conexão padrão ("meu Drive").',
      inputSchema: {},
    },
    async (_args, extra) => {
      const featureError = requireFeature('FEATURE_GOOGLE_DRIVE');
      if (featureError) return featureError;
      const scopeError = requireScope(extra, 'drive:read');
      if (scopeError) return scopeError;
      if (!driveOAuthConfigured()) {
        return toolErrorResponse('drive_oauth_not_configured', 'Integração com Google Drive ainda não configurada nesta instância.');
      }
      const connections = driveConnectionStore.list().map(publicConnectionFields);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, instance_display_name: INSTANCE_DISPLAY_NAME, connections }, null, 2) }],
      };
    }
  );

  mcpServer.registerTool(
    'search_drive_files',
    {
      title: `Pesquisar arquivos no Google Drive do ${INSTANCE_DISPLAY_NAME}`,
      description:
        'READ-ONLY. Procura arquivos/pastas no Google Drive conectado (nome e conteúdo), respeitando a allowlist de ' +
        'pastas (root_folder_ids) quando configurada na conexão. NUNCA baixa o arquivo - só localiza. Use ' +
        'import_drive_file/send_drive_file depois para baixar/enviar. Sem drive_connection, usa a conexão padrão ' +
        '("meu Drive").',
      inputSchema: {
        query: z.string().describe('Texto a procurar (nome e conteúdo indexado pelo Drive).'),
        drive_connection: z.string().optional().describe('connection_id ou display_name - padrão usa a conexão default desta instância.'),
        folder_id: z.string().optional().describe('Restringe a busca a dentro desta pasta.'),
        mime_type: z.string().optional().describe('Filtra por mimetype exato.'),
        limit: z.number().optional().describe('Padrão 20.'),
      },
    },
    async ({ query, drive_connection, folder_id, mime_type, limit }, extra) => {
      const scopeError = requireScope(extra, 'drive:read');
      if (scopeError) return scopeError;
      const access = await resolveDriveAccess({ connectionRef: drive_connection, requiredFeature: 'FEATURE_DRIVE_READ' });
      if (!access.ok) return access.response;

      try {
        const result = await driveSearchByText({ accessToken: access.accessToken, text: query, folderId: folder_id, mimeType: mime_type, pageSize: limit || 20 });
        let files = result.files || [];
        if (access.connection.root_folder_ids?.length) {
          const filtered = [];
          for (const f of files) {
            if (await isUnderAllowedRoot({ accessToken: access.accessToken, fileId: f.id, rootFolderIds: access.connection.root_folder_ids })) filtered.push(f);
          }
          files = filtered;
        }
        const shaped = files.map((f) => ({
          file_id: f.id,
          name: f.name,
          mime_type: f.mimeType,
          size: f.size ? Number(f.size) : null,
          parent: (f.parents || [])[0] || null,
          modified_time: f.modifiedTime,
          drive_connection: access.connection.connection_id,
          is_folder: f.mimeType === 'application/vnd.google-apps.folder',
        }));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, instance_display_name: INSTANCE_DISPLAY_NAME, drive_connection: access.connection.connection_id, count: shaped.length, files: shaped }, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error('[search_drive_files] erro detalhado:', err);
        return toolErrorResponse('drive_api_error', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'list_drive_folder',
    {
      title: 'Listar o conteúdo de uma pasta do Google Drive',
      description: 'READ-ONLY. Lista os arquivos/subpastas dentro de uma pasta específica do Google Drive, com paginação (next_page_token).',
      inputSchema: {
        folder_id: z.string().describe('ID da pasta (de search_drive_files ou de uma URL do Drive).'),
        drive_connection: z.string().optional(),
        page_token: z.string().optional().describe('Para buscar a próxima página.'),
        limit: z.number().optional().describe('Padrão 50.'),
      },
    },
    async ({ folder_id, drive_connection, page_token, limit }, extra) => {
      const scopeError = requireScope(extra, 'drive:read');
      if (scopeError) return scopeError;
      const access = await resolveDriveAccess({ connectionRef: drive_connection, requiredFeature: 'FEATURE_DRIVE_READ' });
      if (!access.ok) return access.response;
      try {
        if (access.connection.root_folder_ids?.length) {
          const allowed = await isUnderAllowedRoot({ accessToken: access.accessToken, fileId: folder_id, rootFolderIds: access.connection.root_folder_ids });
          if (!allowed) return toolErrorResponse('path_not_allowed', 'Esta pasta está fora das root_folder_ids autorizadas para esta conexão.');
        }
        const result = await driveListFolderChildren({ accessToken: access.accessToken, folderId: folder_id, pageToken: page_token, pageSize: limit || 50 });
        const files = (result.files || []).map((f) => ({
          file_id: f.id,
          name: f.name,
          mime_type: f.mimeType,
          size: f.size ? Number(f.size) : null,
          modified_time: f.modifiedTime,
          is_folder: f.mimeType === 'application/vnd.google-apps.folder',
        }));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, folder_id, drive_connection: access.connection.connection_id, files, next_page_token: result.nextPageToken || null }, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error('[list_drive_folder] erro detalhado:', err);
        return toolErrorResponse('drive_api_error', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'read_drive_file',
    {
      title: 'Ler o conteúdo de um arquivo do Google Drive',
      description:
        'READ-ONLY. Baixa TEMPORARIAMENTE um arquivo do Drive (não fica salvo em lugar nenhum) e extrai o conteúdo ' +
        '(texto de PDF/DOCX/TXT/CSV, ou metadados de imagem) usando o mesmo pipeline de read_message_attachment - ' +
        'para você CONFIRMAR o que é um documento antes de decidir enviar (ex: "RG da Irene" vs "RG do curador da ' +
        'Irene"). Google Docs/Sheets/Slides são exportados automaticamente (texto/CSV).',
      inputSchema: {
        file_id: z.string().describe('ID do arquivo (de search_drive_files/list_drive_folder).'),
        drive_connection: z.string().optional(),
      },
    },
    async ({ file_id, drive_connection }, extra) => {
      const scopeError = requireScope(extra, 'drive:read');
      if (scopeError) return scopeError;
      const access = await resolveDriveAccess({ connectionRef: drive_connection, requiredFeature: 'FEATURE_DRIVE_READ' });
      if (!access.ok) return access.response;
      try {
        const meta = await driveGetFileMetadata({ accessToken: access.accessToken, fileId: file_id });
        if (access.connection.root_folder_ids?.length) {
          const allowed = await isUnderAllowedRoot({ accessToken: access.accessToken, fileId: file_id, rootFolderIds: access.connection.root_folder_ids });
          if (!allowed) return toolErrorResponse('path_not_allowed', 'Este arquivo está fora das root_folder_ids autorizadas para esta conexão.');
        }
        const { buffer, mimetype } = await driveDownloadFileContent({ accessToken: access.accessToken, fileId: file_id, mimeType: meta.mimeType, purpose: 'analyze' });
        if (buffer.length > MAX_FILE_SIZE_BYTES) {
          return toolErrorResponse('file_too_large', `Arquivo de ${buffer.length} bytes excede o limite de ${MAX_FILE_SIZE_BYTES} bytes.`);
        }
        const canTranscribe = (extra?.authInfo?.scopes || []).includes('whatsapp:transcribe');
        const processed = await processAttachment({
          buffer,
          mimetype,
          filename: meta.name,
          size: buffer.length,
          messageId: `drive:${file_id}`,
          rawDurationSeconds: null,
          canTranscribe,
        });
        const content = [
          { type: 'text', text: JSON.stringify({ success: true, file_id, name: meta.name, mime_type: mimetype, size: buffer.length, ...processed.fields }, null, 2) },
        ];
        if (processed.imageBlock) content.push(processed.imageBlock);
        return { content };
      } catch (err) {
        console.error('[read_drive_file] erro detalhado:', err);
        return toolErrorResponse('drive_api_error', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'import_drive_file',
    {
      title: 'Importar um arquivo do Google Drive para a área temporária',
      description:
        'Baixa um arquivo do Google Drive (preservando bytes/mimetype originais; Google Docs/Sheets/Slides são ' +
        'exportados como PDF) para a MESMA área temporária de upload_temp_file, devolvendo um temp_file_id - use ' +
        'depois em send_file/send_document/send_media/send_files. Prefira send_drive_file quando já souber o ' +
        'destino (faz tudo em uma chamada só).',
      inputSchema: {
        file_id: z.string().describe('ID do arquivo no Google Drive.'),
        drive_connection: z.string().optional(),
      },
    },
    async ({ file_id, drive_connection }, extra) => {
      const scopeError = requireScope(extra, 'drive:download');
      if (scopeError) return scopeError;
      const access = await resolveDriveAccess({ connectionRef: drive_connection, requiredFeature: 'FEATURE_DRIVE_READ' });
      if (!access.ok) return access.response;
      try {
        const result = await importDriveFileToTempStore({ access, fileId: file_id });
        if (!result.ok) return toolErrorResponse(result.error, result.message);
        auditLog({
          action: 'import_drive_file',
          ok: true,
          identityId: extra?.authInfo?.extra?.identityId,
          drive_connection: access.connection.connection_id,
          temp_file_id: result.entry.temp_file_id,
          size: result.entry.size,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  instance_display_name: INSTANCE_DISPLAY_NAME,
                  temp_file_id: result.entry.temp_file_id,
                  filename: result.entry.filename,
                  mimetype: result.entry.mimetype,
                  size: result.entry.size,
                  expires_at: result.entry.expires_at,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        console.error('[import_drive_file] erro detalhado:', err);
        return toolErrorResponse('drive_api_error', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'send_drive_file',
    {
      title: `Enviar um arquivo do Google Drive pelo ${INSTANCE_DISPLAY_NAME}`,
      description:
        'WRITE: baixa um arquivo do Google Drive e envia direto pelo WhatsApp (GOOGLE DRIVE → VPS → WHATSAPP - o ' +
        'binário nunca passa pelo cliente MCP, sem base64, sem /upload manual). Apaga o temporário após confirmar o ' +
        'envio; mantém para retry se falhar. Para encontrar o arquivo certo a partir de uma descrição, use ' +
        'find_and_send_drive_file antes (ou search_drive_files + read_drive_file para conferir qual é).',
      inputSchema: {
        file_id: z.string().describe('ID do arquivo no Google Drive.'),
        drive_connection: z.string().optional(),
        destination: z.string().describe('Nome do contato/grupo de destino (resolvido automaticamente) ou chat_id.'),
        caption: z.string().optional(),
        request_id: z.string().optional().describe('Chave de idempotência opcional.'),
      },
    },
    async ({ file_id, drive_connection, destination, caption, request_id }, extra) => {
      const scopeError = requireScope(extra, 'drive:download') || requireScope(extra, 'whatsapp:send_file');
      if (scopeError) return scopeError;
      const featureError = requireFeature('FEATURE_DRIVE_SEND');
      if (featureError) return featureError;
      requireWhatsappReady();

      if (request_id) {
        const cached = idempotencyStore.get(request_id);
        if (cached) return { content: [{ type: 'text', text: JSON.stringify({ ...cached, idempotent: true }, null, 2) }] };
      }

      const access = await resolveDriveAccess({ connectionRef: drive_connection });
      if (!access.ok) return access.response;
      const resolvedDest = await resolveTargetChat({ chat_id: destination, contact: destination });
      if (!resolvedDest.ok) return resolvedFailureResponse(resolvedDest);

      try {
        const imported = await importDriveFileToTempStore({ access, fileId: file_id });
        if (!imported.ok) return toolErrorResponse(imported.error, imported.message);

        const source = await resolveFileSource({ temp_file_id: imported.entry.temp_file_id });
        if (!source.ok) return toolErrorResponse(source.error, source.message);

        const sent = await sendFileCore({ targetId: resolvedDest.chat_id, buffer: source.buffer, mimetype: source.mimetype, filename: source.filename, caption, mode: 'auto' });
        tempFileStore.remove(imported.entry.temp_file_id);

        const result = {
          success: true,
          drive_connection: access.connection.connection_id,
          source_file_id: file_id,
          destination_chat_id: resolvedDest.chat_id,
          filename: source.filename,
          mimetype: source.mimetype,
          size: source.size,
          sent_message_id: sent.message_id,
        };
        auditLog({
          action: 'send_drive_file',
          ok: true,
          identityId: extra?.authInfo?.extra?.identityId,
          drive_connection: access.connection.connection_id,
          destination: maskChatId(resolvedDest.chat_id),
          mimetype: source.mimetype,
          size: source.size,
        });
        if (request_id) idempotencyStore.put(request_id, result);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[send_drive_file] erro detalhado:', err);
        auditLog({ action: 'send_drive_file', ok: false, identityId: extra?.authInfo?.extra?.identityId, error: err.message });
        return toolErrorResponse('send_failed', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'send_drive_files',
    {
      title: `Enviar vários arquivos do Google Drive pelo ${INSTANCE_DISPLAY_NAME} (lote)`,
      description:
        'WRITE: baixa e envia uma lista de arquivos do Google Drive NA ORDEM INFORMADA, com texto opcional antes e ' +
        'depois. Continua mesmo se um arquivo falhar e informa o resultado individual de cada um.',
      inputSchema: {
        drive_connection: z.string().optional(),
        files: z.array(z.object({ file_id: z.string(), caption: z.string().optional() })).min(1).describe('Lista de arquivos, NA ORDEM em que devem ser enviados.'),
        destination: z.string().describe('Nome do contato/grupo de destino ou chat_id.'),
        text_before: z.string().optional(),
        text_after: z.string().optional(),
        request_id: z.string().optional().describe('Chave de idempotência opcional para o lote inteiro.'),
      },
    },
    async ({ drive_connection, files, destination, text_before, text_after, request_id }, extra) => {
      const scopeError = requireScope(extra, 'drive:download') || requireScope(extra, 'whatsapp:send_file');
      if (scopeError) return scopeError;
      const featureError = requireFeature('FEATURE_DRIVE_SEND');
      if (featureError) return featureError;
      requireWhatsappReady();

      if (request_id) {
        const cached = idempotencyStore.get(request_id);
        if (cached) return { content: [{ type: 'text', text: JSON.stringify({ ...cached, idempotent: true }, null, 2) }] };
      }

      const access = await resolveDriveAccess({ connectionRef: drive_connection });
      if (!access.ok) return access.response;
      const resolvedDest = await resolveTargetChat({ chat_id: destination, contact: destination });
      if (!resolvedDest.ok) return resolvedFailureResponse(resolvedDest);

      try {
        if (text_before) await waClient.sendMessage(resolvedDest.chat_id, text_before);

        const results = [];
        for (const f of files) {
          try {
            const imported = await importDriveFileToTempStore({ access, fileId: f.file_id });
            if (!imported.ok) {
              results.push({ file_id: f.file_id, success: false, error: imported.error });
              continue;
            }
            const source = await resolveFileSource({ temp_file_id: imported.entry.temp_file_id });
            if (!source.ok) {
              results.push({ file_id: f.file_id, success: false, error: source.error });
              continue;
            }
            const sent = await sendFileCore({ targetId: resolvedDest.chat_id, buffer: source.buffer, mimetype: source.mimetype, filename: source.filename, caption: f.caption, mode: 'auto' });
            tempFileStore.remove(imported.entry.temp_file_id);
            results.push({ file_id: f.file_id, success: true, filename: source.filename, mimetype: source.mimetype, size: source.size, message_id: sent.message_id });
          } catch (err) {
            results.push({ file_id: f.file_id, success: false, error: 'send_failed', message: err.message });
          }
        }

        if (text_after) await waClient.sendMessage(resolvedDest.chat_id, text_after);

        const sentCount = results.filter((r) => r.success).length;
        const result = {
          success: sentCount === files.length,
          drive_connection: access.connection.connection_id,
          destination_chat_id: resolvedDest.chat_id,
          requested: files.length,
          sent: sentCount,
          failed: files.length - sentCount,
          results,
        };
        auditLog({
          action: 'send_drive_files',
          ok: result.success,
          identityId: extra?.authInfo?.extra?.identityId,
          drive_connection: access.connection.connection_id,
          destination: maskChatId(resolvedDest.chat_id),
          sent: sentCount,
          failed: result.failed,
        });
        if (request_id) idempotencyStore.put(request_id, result);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result.failed > 0 && sentCount === 0 };
      } catch (err) {
        console.error('[send_drive_files] erro detalhado:', err);
        return toolErrorResponse('internal_error', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'find_and_send_drive_file',
    {
      title: `Procurar um arquivo no Google Drive por descrição e enviar pelo ${INSTANCE_DISPLAY_NAME}`,
      description:
        'Procura no Google Drive (nome/conteúdo, opcionalmente dentro de uma pasta) um arquivo que bata com a ' +
        'descrição e, se achar EXATAMENTE UM, baixa e envia pelo WhatsApp. Se houver mais de um candidato ' +
        'plausível, NÃO escolhe sozinho - devolve os candidatos (file_id/name/modified_time) para você decidir, ou ' +
        'use read_drive_file pra conferir qual é antes de chamar send_drive_file diretamente.',
      inputSchema: {
        query: z.string().describe('Descrição livre do arquivo (ex: "RG Irene").'),
        folder_id: z.string().optional().describe('Restringe a busca a dentro desta pasta.'),
        drive_connection: z.string().optional(),
        destination: z.string().describe('Nome do contato/grupo de destino ou chat_id.'),
        caption: z.string().optional(),
        request_id: z.string().optional(),
      },
    },
    async ({ query, folder_id, drive_connection, destination, caption, request_id }, extra) => {
      const scopeError = requireScope(extra, 'drive:read') || requireScope(extra, 'drive:download') || requireScope(extra, 'whatsapp:send_file');
      if (scopeError) return scopeError;
      const featureError = requireFeature('FEATURE_DRIVE_SEND') || requireFeature('FEATURE_DRIVE_READ');
      if (featureError) return featureError;
      requireWhatsappReady();

      if (request_id) {
        const cached = idempotencyStore.get(request_id);
        if (cached) return { content: [{ type: 'text', text: JSON.stringify({ ...cached, idempotent: true }, null, 2) }] };
      }

      const access = await resolveDriveAccess({ connectionRef: drive_connection });
      if (!access.ok) return access.response;
      const resolvedDest = await resolveTargetChat({ chat_id: destination, contact: destination });
      if (!resolvedDest.ok) return resolvedFailureResponse(resolvedDest);

      try {
        const found = await driveSearchByText({ accessToken: access.accessToken, text: query, folderId: folder_id, pageSize: 10 });
        let files = (found.files || []).filter((f) => f.mimeType !== 'application/vnd.google-apps.folder');
        if (access.connection.root_folder_ids?.length) {
          const filtered = [];
          for (const f of files) {
            if (await isUnderAllowedRoot({ accessToken: access.accessToken, fileId: f.id, rootFolderIds: access.connection.root_folder_ids })) filtered.push(f);
          }
          files = filtered;
        }

        if (files.length === 0) return toolErrorResponse('not_found', `Nenhum arquivo encontrado no Drive batendo com "${query}".`);
        if (files.length > 1) {
          return toolErrorResponse('ambiguous', 'Mais de um arquivo plausível - escolha um file_id (use read_drive_file para conferir) e chame send_drive_file diretamente.', {
            candidates: files.map((f) => ({ file_id: f.id, name: f.name, mime_type: f.mimeType, modified_time: f.modifiedTime })),
          });
        }

        const picked = files[0];
        const imported = await importDriveFileToTempStore({ access, fileId: picked.id });
        if (!imported.ok) return toolErrorResponse(imported.error, imported.message);
        const source = await resolveFileSource({ temp_file_id: imported.entry.temp_file_id });
        if (!source.ok) return toolErrorResponse(source.error, source.message);
        const sent = await sendFileCore({ targetId: resolvedDest.chat_id, buffer: source.buffer, mimetype: source.mimetype, filename: source.filename, caption, mode: 'auto' });
        tempFileStore.remove(imported.entry.temp_file_id);

        const result = {
          success: true,
          drive_connection: access.connection.connection_id,
          source_file_id: picked.id,
          source_filename: picked.name,
          destination_chat_id: resolvedDest.chat_id,
          filename: source.filename,
          mimetype: source.mimetype,
          size: source.size,
          sent_message_id: sent.message_id,
        };
        auditLog({
          action: 'find_and_send_drive_file',
          ok: true,
          identityId: extra?.authInfo?.extra?.identityId,
          drive_connection: access.connection.connection_id,
          destination: maskChatId(resolvedDest.chat_id),
        });
        if (request_id) idempotencyStore.put(request_id, result);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[find_and_send_drive_file] erro detalhado:', err);
        return toolErrorResponse('drive_api_error', err.message);
      }
    }
  );

  mcpServer.registerTool(
    'find_and_send_drive_files',
    {
      title: `Procurar vários arquivos no Google Drive e enviar pelo ${INSTANCE_DISPLAY_NAME} (lote)`,
      description:
        'Igual a find_and_send_drive_file, mas para várias descrições de uma vez - processa `queries` NA ORDEM ' +
        'informada, continua mesmo se uma falhar/for ambígua, e informa o resultado individual de cada uma. Se ' +
        'alguma for ambígua, PARA antes de enviar aquele arquivo específico e explica os candidatos - não escolhe ' +
        'sozinho.',
      inputSchema: {
        folder_id: z.string().optional().describe('Restringe a busca a dentro desta pasta (ex: a pasta do cliente).'),
        queries: z.array(z.string()).min(1).describe('Descrições, NA ORDEM em que devem ser processadas/enviadas.'),
        drive_connection: z.string().optional(),
        destination: z.string().describe('Nome do contato/grupo de destino ou chat_id.'),
        request_id: z.string().optional(),
      },
    },
    async ({ folder_id, queries, drive_connection, destination, request_id }, extra) => {
      const scopeError = requireScope(extra, 'drive:read') || requireScope(extra, 'drive:download') || requireScope(extra, 'whatsapp:send_file');
      if (scopeError) return scopeError;
      const featureError = requireFeature('FEATURE_DRIVE_SEND') || requireFeature('FEATURE_DRIVE_READ');
      if (featureError) return featureError;
      requireWhatsappReady();

      if (request_id) {
        const cached = idempotencyStore.get(request_id);
        if (cached) return { content: [{ type: 'text', text: JSON.stringify({ ...cached, idempotent: true }, null, 2) }] };
      }

      const access = await resolveDriveAccess({ connectionRef: drive_connection });
      if (!access.ok) return access.response;
      const resolvedDest = await resolveTargetChat({ chat_id: destination, contact: destination });
      if (!resolvedDest.ok) return resolvedFailureResponse(resolvedDest);

      try {
        const results = [];
        for (const query of queries) {
          const found = await driveSearchByText({ accessToken: access.accessToken, text: query, folderId: folder_id, pageSize: 10 });
          let candidates = (found.files || []).filter((f) => f.mimeType !== 'application/vnd.google-apps.folder');
          if (access.connection.root_folder_ids?.length) {
            const filtered = [];
            for (const f of candidates) {
              if (await isUnderAllowedRoot({ accessToken: access.accessToken, fileId: f.id, rootFolderIds: access.connection.root_folder_ids })) filtered.push(f);
            }
            candidates = filtered;
          }
          if (candidates.length === 0) {
            results.push({ query, success: false, error: 'not_found' });
            continue;
          }
          if (candidates.length > 1) {
            results.push({ query, success: false, error: 'ambiguous', candidates: candidates.map((f) => ({ file_id: f.id, name: f.name, mime_type: f.mimeType, modified_time: f.modifiedTime })) });
            continue;
          }
          const picked = candidates[0];
          try {
            const imported = await importDriveFileToTempStore({ access, fileId: picked.id });
            if (!imported.ok) {
              results.push({ query, success: false, error: imported.error });
              continue;
            }
            const source = await resolveFileSource({ temp_file_id: imported.entry.temp_file_id });
            if (!source.ok) {
              results.push({ query, success: false, error: source.error });
              continue;
            }
            const sent = await sendFileCore({ targetId: resolvedDest.chat_id, buffer: source.buffer, mimetype: source.mimetype, filename: source.filename, mode: 'auto' });
            tempFileStore.remove(imported.entry.temp_file_id);
            results.push({ query, success: true, source_file_id: picked.id, filename: source.filename, mimetype: source.mimetype, size: source.size, sent_message_id: sent.message_id });
          } catch (err) {
            results.push({ query, success: false, error: 'send_failed', message: err.message });
          }
        }

        const sentCount = results.filter((r) => r.success).length;
        const result = {
          success: sentCount === queries.length,
          drive_connection: access.connection.connection_id,
          destination_chat_id: resolvedDest.chat_id,
          requested: queries.length,
          sent: sentCount,
          failed: queries.length - sentCount,
          results,
        };
        auditLog({
          action: 'find_and_send_drive_files',
          ok: result.success,
          identityId: extra?.authInfo?.extra?.identityId,
          drive_connection: access.connection.connection_id,
          destination: maskChatId(resolvedDest.chat_id),
          sent: sentCount,
          failed: result.failed,
        });
        if (request_id) idempotencyStore.put(request_id, result);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result.failed > 0 && sentCount === 0 };
      } catch (err) {
        console.error('[find_and_send_drive_files] erro detalhado:', err);
        return toolErrorResponse('internal_error', err.message);
      }
    }
  );

  const fileSendInputSchema = {
    chat: z.string().optional().describe('Nome do contato/grupo (resolvido automaticamente) - alias de "contact".'),
    chat_id: z.string().optional().describe('ID real do chat, se já souber.'),
    contact: z.string().optional().describe('Nome ou número do contato/grupo.'),
    storage_id: z.string().optional().describe('ID de um arquivo já baixado/importado (download_message_attachment ou import_file). Use isto OU file_path OU temp_file_id.'),
    file_path: z.string().optional().describe('Caminho absoluto dentro de um diretório autorizado (FILE_ALLOWED_PATHS). Use isto OU storage_id OU temp_file_id.'),
    temp_file_id: z.string().optional().describe('ID de um arquivo enviado via upload_temp_file (ingestão remota) - ver essa tool. Use isto OU storage_id OU file_path. Apagado automaticamente após o envio ter sucesso.'),
    caption: z.string().optional().describe('Legenda (funciona para imagem/vídeo/documento quando o WhatsApp suporta).'),
    filename: z.string().optional().describe('Nome do arquivo a usar no envio (padrão: nome original).'),
    request_id: z.string().optional().describe('Chave de idempotência opcional - repetir a mesma chamada com o mesmo request_id não reenvia, devolve o resultado anterior.'),
  };

  async function handleFileSend({ chat, chat_id, contact, storage_id, file_path, temp_file_id, caption, filename, mode, request_id }, extra, toolName) {
    const featureError = requireFeature('FEATURE_FILE_SEND');
    if (featureError) return featureError;
    const scopeError = requireScope(extra, 'whatsapp:send_file');
    if (scopeError) return scopeError;
    requireWhatsappReady();

    if (request_id) {
      const cached = idempotencyStore.get(request_id);
      if (cached) {
        log(`[WHATSAPP-MCP][FILE] ${toolName} idempotent_hit`, request_id);
        return { content: [{ type: 'text', text: JSON.stringify({ ...cached, idempotent: true }, null, 2) }] };
      }
    }

    const resolved = await resolveSendTarget({ chat_id, contact, chat });
    if (!resolved.ok) return resolvedFailureResponse(resolved);

    const source = await resolveFileSource({ storage_id, file_path, temp_file_id, filename });
    if (!source.ok) {
      const result = { success: false, error: source.error, message: source.message };
      log(`[WHATSAPP-MCP][FILE] ${toolName}_failed`, maskChatId(resolved.chat_id), source.error);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
    }

    try {
      const sent = await sendFileCore({
        targetId: resolved.chat_id,
        buffer: source.buffer,
        mimetype: source.mimetype,
        filename: source.filename,
        caption,
        mode,
      });
      const result = {
        success: true,
        chat_id: resolved.chat_id,
        message_id: sent.message_id,
        filename: source.filename,
        mimetype: source.mimetype,
        size: source.size,
        timestamp: sent.timestamp,
      };
      // Arquivo temporário só é apagado DEPOIS de confirmado o envio (nunca
      // antes) - se sendFileCore tivesse lançado, o arquivo continuaria
      // disponível para retry com o mesmo temp_file_id.
      if (source.tempFileId) {
        tempFileStore.remove(source.tempFileId);
        auditLog({ action: 'temp_file_sent', temp_file_id: source.tempFileId, filename: source.filename, size: source.size });
        log('[WHATSAPP-MCP][TEMP] apagado após envio OK', source.tempFileId);
      }
      auditLog({ action: toolName, ok: true, identityId: extra?.authInfo?.extra?.identityId, chat_id: maskChatId(resolved.chat_id), mimetype: source.mimetype, size: source.size });
      log(`[WHATSAPP-MCP][FILE] ${toolName}_success`, maskChatId(resolved.chat_id), source.mimetype, source.size, 'bytes');
      if (request_id) idempotencyStore.put(request_id, result);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      console.error(`[${toolName}] erro detalhado:`, err);
      const result = { success: false, error: 'send_failed', message: err.message };
      auditLog({ action: toolName, ok: false, identityId: extra?.authInfo?.extra?.identityId, error: err.message });
      log(`[WHATSAPP-MCP][FILE] ${toolName}_failed`, maskChatId(resolved.chat_id), err.message);
      // Falhou: o arquivo temporário (se foi essa a origem) PERMANECE
      // intacto até o TTL - permite pedir retry sem novo upload.
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
    }
  }

  mcpServer.registerTool(
    'send_document',
    {
      title: 'Enviar um documento pelo WhatsApp (sempre como arquivo)',
      description:
        'WRITE: envia um arquivo (storage_id ou file_path) como DOCUMENTO para um contato/grupo. Sempre anexa como ' +
        'arquivo (nunca como mídia nativa), ideal para PDF/Word/planilha/outros documentos. Resolve "chat" por nome ' +
        '- se houver mais de um resultado parecido, não escolhe sozinho, pede para você confirmar.',
      inputSchema: fileSendInputSchema,
    },
    async (args, extra) => handleFileSend({ ...args, mode: 'document' }, extra, 'send_document')
  );

  mcpServer.registerTool(
    'send_media',
    {
      title: 'Enviar imagem/áudio/vídeo pelo WhatsApp (mídia nativa por padrão)',
      description:
        'WRITE: envia um arquivo (storage_id ou file_path) como MÍDIA NATIVA (imagem/áudio/vídeo) por padrão. Passe ' +
        'as_document=true para forçar envio como arquivo em vez de mídia nativa.',
      inputSchema: {
        ...fileSendInputSchema,
        as_document: z.boolean().optional().describe('true para enviar como documento/arquivo em vez de mídia nativa (padrão false).'),
      },
    },
    async ({ as_document, ...args }, extra) => handleFileSend({ ...args, mode: as_document ? 'document' : 'auto' }, extra, 'send_media')
  );

  mcpServer.registerTool(
    'send_file',
    {
      title: 'Enviar um arquivo pelo WhatsApp (genérica, detecta o modo automaticamente)',
      description:
        'WRITE: envia um arquivo (temp_file_id, storage_id ou file_path) escolhendo automaticamente entre documento/' +
        'imagem/áudio/vídeo pelo mimetype (mode="auto", padrão), ou force com mode="document"/"image"/"audio"/"video". ' +
        'Se o usuário mencionar um arquivo/lote que ele subiu antes (pela página de upload ou upload_temp_file), use ' +
        'list_temp_files ou get_temp_batch primeiro para achar o temp_file_id - nunca tente adivinhar um caminho do ' +
        'ambiente do usuário (ex: "C:\\Users\\...", "/mnt/user-data/...").',
      inputSchema: {
        ...fileSendInputSchema,
        mode: z.enum(['auto', 'document', 'image', 'audio', 'video']).optional().describe('Padrão "auto" - detecta pelo mimetype.'),
      },
    },
    async (args, extra) => handleFileSend(args, extra, 'send_file')
  );

  mcpServer.registerTool(
    'send_files',
    {
      title: 'Enviar vários arquivos em sequência (com texto opcional antes/depois)',
      description:
        'WRITE: envia uma lista de arquivos (temp_file_id, storage_id ou file_path) NA ORDEM INFORMADA (nunca ' +
        'reorganiza) para um contato/grupo, com texto opcional antes e depois. Se um arquivo falhar, continua com ' +
        'os seguintes e informa o resultado individual de cada um - não esconde falhas parciais. Para um lote que o ' +
        'usuário subiu pela página de upload (ex: "os arquivos do Renato"), use get_temp_batch primeiro para pegar ' +
        'os temp_file_id NA ORDEM certa. Use FEATURE_MULTI_FILE_SEND=false numa instância para desativar.',
      inputSchema: {
        chat: z.string().optional().describe('Nome do contato/grupo (resolvido automaticamente) - alias de "contact".'),
        chat_id: z.string().optional().describe('ID real do chat, se já souber.'),
        contact: z.string().optional().describe('Nome ou número do contato/grupo.'),
        files: z
          .array(
            z.object({
              storage_id: z.string().optional(),
              file_path: z.string().optional(),
              temp_file_id: z.string().optional().describe('ID de um arquivo enviado via upload_temp_file. Apagado automaticamente após o envio ter sucesso.'),
              filename: z.string().optional(),
              caption: z.string().optional(),
            })
          )
          .min(1)
          .describe('Lista de arquivos, NA ORDEM em que devem ser enviados.'),
        text_before: z.string().optional().describe('Texto a enviar antes dos arquivos.'),
        text_after: z.string().optional().describe('Texto a enviar depois dos arquivos.'),
        request_id: z.string().optional().describe('Chave de idempotência opcional para o lote inteiro.'),
      },
    },
    async ({ chat, chat_id, contact, files, text_before, text_after, request_id }, extra) => {
      const featureError = requireFeature('FEATURE_MULTI_FILE_SEND') || requireFeature('FEATURE_FILE_SEND');
      if (featureError) return featureError;
      const scopeError = requireScope(extra, 'whatsapp:send_file');
      if (scopeError) return scopeError;
      try {
        requireWhatsappReady();

        if (request_id) {
          const cached = idempotencyStore.get(request_id);
          if (cached) {
            log('[WHATSAPP-MCP][FILE] send_files idempotent_hit', request_id);
            return { content: [{ type: 'text', text: JSON.stringify({ ...cached, idempotent: true }, null, 2) }] };
          }
        }

        const resolved = await resolveSendTarget({ chat_id, contact, chat });
        if (!resolved.ok) return resolvedFailureResponse(resolved);

        if (text_before) {
          await waClient.sendMessage(resolved.chat_id, text_before);
        }

        const results = [];
        for (const f of files) {
          const source = await resolveFileSource({ storage_id: f.storage_id, file_path: f.file_path, temp_file_id: f.temp_file_id, filename: f.filename });
          if (!source.ok) {
            results.push({ success: false, filename: f.filename || f.file_path || f.storage_id || f.temp_file_id, error: source.error });
            log('[WHATSAPP-MCP][FILE] send_files_failed', maskChatId(resolved.chat_id), source.error);
            continue;
          }
          try {
            const sent = await sendFileCore({
              targetId: resolved.chat_id,
              buffer: source.buffer,
              mimetype: source.mimetype,
              filename: source.filename,
              caption: f.caption,
              mode: 'auto',
            });
            results.push({ success: true, filename: source.filename, mimetype: source.mimetype, size: source.size, message_id: sent.message_id });
            log('[WHATSAPP-MCP][FILE] send_files_success', maskChatId(resolved.chat_id), source.mimetype, source.size, 'bytes');
            // Só apaga o temporário DEPOIS de confirmado o envio deste arquivo
            // específico - um arquivo que falhar no meio do lote permanece
            // intacto para retry, os outros já enviados são apagados normalmente.
            if (source.tempFileId) {
              tempFileStore.remove(source.tempFileId);
              auditLog({ action: 'temp_file_sent', temp_file_id: source.tempFileId, filename: source.filename, size: source.size });
              log('[WHATSAPP-MCP][TEMP] apagado após envio OK', source.tempFileId);
            }
          } catch (err) {
            results.push({ success: false, filename: source.filename, error: 'send_failed', message: err.message });
            log('[WHATSAPP-MCP][FILE] send_files_failed', maskChatId(resolved.chat_id), err.message);
          }
        }

        if (text_after) {
          await waClient.sendMessage(resolved.chat_id, text_after);
        }

        const sentCount = results.filter((r) => r.success).length;
        const failedCount = results.filter((r) => !r.success).length;
        const result = {
          success: sentCount === files.length,
          chat_id: resolved.chat_id,
          requested: files.length,
          sent: sentCount,
          failed: failedCount,
          // Sempre 0 na implementação atual: processamos TODOS os arquivos do
          // lote em sequência (continue-on-failure), nunca abortamos no meio -
          // então nenhum arquivo fica "não tentado". Campo mantido no formato
          // de resposta para o caso de uma futura estratégia de abort parcial.
          pending: files.length - sentCount - failedCount,
          results,
        };
        auditLog({ action: 'send_files', ok: result.success, identityId: extra?.authInfo?.extra?.identityId, chat_id: maskChatId(resolved.chat_id), sent: sentCount, failed: result.failed });
        if (request_id) idempotencyStore.put(request_id, result);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result.failed > 0 && sentCount === 0 };
      } catch (err) {
        console.error('[send_files] erro detalhado:', err);
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'internal_error', message: err.message }, null, 2) }], isError: true };
      }
    }
  );

  registerAgentTools(mcpServer, {client: waClient, requireScope, requireReady: requireWhatsappReady, requireFeature, auditLog, fetchChatHistory, formatMessage});
  return mcpServer;
}

// ---------------------------------------------------------------------------
// Leitura de anexos (PDF/DOCX/texto/imagem) - processamento local, sem sair
// do MCP. Nunca inventa conteúdo: tipos não suportados ou PDFs sem texto
// embutido (escaneados) dizem isso explicitamente em vez de fabricar texto.
// ---------------------------------------------------------------------------
const MAX_TEXT_CHARS = 20000;
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB

const READABLE_TEXT_MIMETYPES = new Set(['text/plain', 'text/csv', 'application/json', 'text/xml', 'application/xml']);
const READABLE_IMAGE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const DOCX_MIMETYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function isReadableByMcp(mimetype) {
  if (!mimetype) return false;
  const base = mimetype.split(';')[0].trim();
  return (
    base === 'application/pdf' ||
    base === DOCX_MIMETYPE ||
    READABLE_TEXT_MIMETYPES.has(base) ||
    READABLE_IMAGE_MIMETYPES.has(base)
  );
}

function truncateText(text) {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

async function processAttachment({ buffer, mimetype, filename, size, messageId, rawDurationSeconds, canTranscribe }) {
  const base = mimetype.split(';')[0].trim();

  if (base === 'application/pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const rawText = (result.text || '').trim();
      if (!rawText) {
        return {
          fields: {
            page_count: result.total,
            text: '',
            text_extraction: 'no_embedded_text',
            ocr_required: true,
          },
        };
      }
      const { text, truncated } = truncateText(rawText);
      return { fields: { page_count: result.total, text, truncated } };
    } finally {
      await parser.destroy();
    }
  }

  if (base === DOCX_MIMETYPE) {
    const result = await mammoth.extractRawText({ buffer });
    const { text, truncated } = truncateText((result.value || '').trim());
    return { fields: { text, truncated } };
  }

  if (READABLE_TEXT_MIMETYPES.has(base)) {
    const { text, truncated } = truncateText(buffer.toString('utf8'));
    return { fields: { text, truncated } };
  }

  if (READABLE_IMAGE_MIMETYPES.has(base)) {
    if (size <= MAX_INLINE_IMAGE_BYTES) {
      return {
        fields: { content_type: 'image', note: 'Imagem incluída diretamente na resposta.' },
        imageBlock: { type: 'image', data: buffer.toString('base64'), mimeType: base },
      };
    }
    return {
      fields: {
        content_type: 'image',
        note: `Imagem maior que o limite de ${Math.round(MAX_INLINE_IMAGE_BYTES / 1024 / 1024)}MB para envio direto. Use get_message_media_info com download=true (requer escopo whatsapp:media) para obter um link temporário.`,
      },
    };
  }

  if (base.startsWith('audio/')) {
    let duration = rawDurationSeconds ?? null;
    let codec = null;
    let bitrate = null;
    try {
      const meta = await parseAudioMetadata(buffer, { mimeType: base, size });
      duration = duration ?? meta.format.duration ?? null;
      codec = meta.format.codec ?? null;
      bitrate = meta.format.bitrate ?? null;
    } catch {
      // metadados de áudio nem sempre são extraíveis (ex: ptt .ogg opus incomum) - segue só com o que já temos
    }
    const fields = { content_type: 'audio', duration_seconds: duration, codec, bitrate };
    if (!featureEnabled('FEATURE_TRANSCRIPTION')) {
      return { fields: { ...fields, transcription_available: false, transcription_source: 'feature_disabled' } };
    }
    if (!canTranscribe) {
      return { fields: { ...fields, transcription_available: true, transcription_source: 'scope_denied' } };
    }
    const result = await transcribeAudio({ messageId, buffer, mimetype: base, filename, durationSeconds: duration, cache: transcriptionCache, log });
    if (!result.success) {
      return { fields: { ...fields, transcription_available: false, transcription_error: result.error } };
    }
    return {
      fields: { ...fields, transcription_available: true, transcription: result.transcription, transcription_source: result.transcription_source },
    };
  }

  if (base.startsWith('video/')) {
    return {
      fields: {
        content_type: 'video',
        note: 'Leitura de conteúdo de vídeo não implementada - retornando só metadados (duration vem do WhatsApp quando disponível).',
      },
    };
  }

  return {
    fields: {
      content_type: 'unsupported',
      note: `Tipo "${mimetype}" não tem leitura de conteúdo implementada - retornando só metadados.`,
    },
  };
}

// Busca a mensagem bruta (getMessageModel) pelo message_id real - usado por
// get_message_media_info e read_message_attachment.
async function fetchRawMessage(messageId) {
  return waClient.pupPage.evaluate(async (msgId) => {
    const collections = window.require('WAWebCollections');
    let msg = collections.Msg.get(msgId);
    if (!msg) {
      const res = await collections.Msg.getMessagesById([msgId]);
      msg = res?.messages?.[0];
    }
    if (!msg) return null;
    return window.WWebJS.getMessageModel(msg);
  }, messageId);
}

// READ ONLY - MUST NOT SEND SEEN.
// Esta função (e todas as outras nesta seção que leem chats/mensagens via
// window.require('WAWebCollections')/WWebJS.getMessageModel) só LÊ dados já
// carregados no Store do WhatsApp Web - nunca chama window.WWebJS.sendSeen,
// WAWebUpdateUnreadChatAction, nem qualquer outra API de confirmação de
// leitura. Não acrescente nenhuma chamada desse tipo aqui: o princípio deste
// servidor é "consulta != visualização humana" - o MCP pode ler o conteúdo
// de uma conversa sem informar ao WhatsApp que o usuário humano a abriu.
// (A ÚNICA função que manda "seen" de propósito é send_message, porque
// sendMessage() da própria lib faz isso por padrão - ver comentário lá.)
//
// waClient.getChats() (função própria injetada pelo whatsapp-web.js,
// window.WWebJS.getChats) quebra com "r is not defined" nesta versão da lib
// contra o WhatsApp Web atual - bug de compatibilidade interno da lib, não
// do transporte MCP. Contorna lendo a coleção de chats diretamente via
// window.require (mecanismo estável e público do próprio whatsapp-web.js).
async function evaluateChats() {
  try {
    return await waClient.pupPage.evaluate(() => {
      const models = window.require('WAWebCollections').Chat.getModelsArray();
      return models.map((c) => {
        const chatId = c.id?._serialized || '';
        const isGroup = chatId.endsWith('@g.us');
        const isPhoneContact = chatId.endsWith('@c.us');
        return {
          chat_id: chatId,
          name: c.formattedTitle || c.name || c.id?.user || '',
          is_group: isGroup,
          // @c.us = número de telefone real. @lid é um ID anônimo do
          // WhatsApp (não é telefone) e @g.us é grupo - phone fica null
          // nesses casos em vez de mostrar um valor enganoso.
          phone: isPhoneContact ? c.id?.user || null : null,
          unread_count: c.unreadCount || 0,
          last_message_body: c.lastMessage?.body || c.msgs?.getModelsArray?.()?.at(-1)?.body || '',
          last_message_timestamp: c.t || c.lastMessage?.t || null,
        };
      });
    });
  } catch (err) {
    console.error('[evaluateChats] erro detalhado:', err);
    throw err;
  }
}

function formatChatSummary(chat) {
  const isLikelyBase64Media = /^[A-Za-z0-9+/=]{60,}$/.test(chat.last_message_body || '');
  const lastMessage = isLikelyBase64Media ? '[mídia]' : (chat.last_message_body || '').slice(0, 120);
  return {
    chat_id: chat.chat_id,
    name: chat.name,
    is_group: chat.is_group,
    phone: chat.phone,
    unread_count: chat.unread_count,
    last_message: lastMessage,
    last_message_date: chat.last_message_timestamp ? new Date(chat.last_message_timestamp * 1000).toISOString() : null,
  };
}

// Contatos (não conversas) que batem com "needle" no nome, pushname ou número.
async function evaluateContacts(needle) {
  return waClient.pupPage.evaluate((needleInner) => {
    const contacts = window.require('WAWebCollections').Contact.getModelsArray();
    const out = [];
    for (const ct of contacts) {
      const id = ct.id?._serialized || '';
      if (!id) continue;
      const isPhoneContact = id.endsWith('@c.us');
      const name = ct.name || '';
      const pushname = ct.pushname || '';
      const number = ct.id?.user || '';
      const haystack = `${name} ${pushname} ${number}`.toLowerCase();
      if (haystack.includes(needleInner)) {
        out.push({
          id,
          name: name || pushname || number,
          phone: isPhoneContact ? number : null,
          pushname: pushname || null,
        });
      }
    }
    return out;
  }, needle);
}

// Nome/tipo de um chat específico, para exibir em get_chat_context em vez
// de um ID cru (evita mostrar "[object Object]" quando from/author vêm como
// objeto WID em vez de string).
async function getChatDisplayInfo(chatId) {
  return waClient.pupPage.evaluate((chatIdInner) => {
    const chat = window.require('WAWebCollections').Chat.getModelsArray().find((c) => c.id?._serialized === chatIdInner);
    if (!chat) return null;
    return { chatName: chat.formattedTitle || chat.name || chat.id?.user || chatIdInner, isGroup: chatIdInner.endsWith('@g.us') };
  }, chatId);
}

// Busca por nome em TODOS os chats (client.getChats(), sem limite de 15) +
// contatos sem chat ativo ainda. Usada por search_chats e pela resolução
// automática de contato (resolveTargetChat).
async function findChatsByName(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const allChats = await evaluateChats();
  const byId = new Map();
  for (const chat of allChats) {
    if (chat.name.toLowerCase().includes(needle)) {
      byId.set(chat.chat_id, formatChatSummary(chat));
    }
  }
  const contacts = await evaluateContacts(needle);
  for (const ct of contacts) {
    if (!byId.has(ct.id)) {
      byId.set(ct.id, {
        chat_id: ct.id,
        name: ct.name,
        is_group: false,
        phone: ct.phone,
        unread_count: 0,
        last_message: '',
        last_message_date: null,
      });
    }
  }
  return [...byId.values()];
}

function isRealChatId(value) {
  return /@(c\.us|g\.us|lid)$/.test(value);
}

// Resolve {chat_id} ou {contact} (nome/número) para um chat_id único.
// Nunca escolhe sozinho entre vários candidatos parecidos - devolve
// candidates para quem chamou decidir.
async function resolveTargetChat({ chat_id, contact }) {
  if (chat_id) return { ok: true, chat_id };
  if (!contact) return { ok: false, error: 'missing_input', message: 'Informe chat_id ou contact.' };
  if (isRealChatId(contact.trim())) return { ok: true, chat_id: contact.trim() };
  const candidates = await findChatsByName(contact);
  log('contact resolved:', contact, '->', candidates.length === 1 ? candidates[0].chat_id : `${candidates.length} candidatos`);
  if (candidates.length === 0) return { ok: false, error: 'not_found', message: `Nenhum contato/grupo encontrado para "${contact}".`, candidates: [] };
  if (candidates.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      message: `Mais de um resultado para "${contact}". Confirme qual chat_id usar antes de continuar.`,
      candidates,
    };
  }
  return { ok: true, chat_id: candidates[0].chat_id };
}

function resolvedFailureResponse(resolved) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: resolved.error, message: resolved.message, candidates: resolved.candidates || [] }, null, 2),
      },
    ],
    isError: true,
  };
}

// Helper compartilhado para respostas de erro das tools (mesmo formato
// {success:false, error, message} usado em toda a base) - evita repetir o
// mesmo JSON.stringify/content wrapper em cada tool nova.
function toolErrorResponse(error, message, extraFields) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error, message, ...extraFields }, null, 2) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Encaminhamento (forward_message/forward_attachment/find_and_forward_file*)
//
// Tenta o forward NATIVO do WhatsApp Web (window.WWebJS.forwardMessage, que
// por baixo usa window.require('WAWebChatForwardMessage') - ver
// node_modules/whatsapp-web.js/src/util/Injected/Utils.js) PRIMEIRO, porque
// preserva o comportamento real de "encaminhado" do próprio WhatsApp. Testado
// empiricamente via CDP contra a versão atual do WhatsApp Web servida nesta
// instância (2.3000.1049516966): o módulo 'WAWebChatForwardMessage' não
// resolve (window.require devolve undefined) - não é um bug nosso, é uma
// incompatibilidade de versão da própria lib whatsapp-web.js 1.34.7 contra o
// build atual do WhatsApp Web (mesma classe de problema do bug __x_id
// documentado acima). Por isso, HOJE, todo forward real cai no fallback de
// cópia abaixo - mas esta função fica pronta para "religar sozinha" se uma
// atualização futura do WhatsApp Web voltar a expor o módulo, sem precisar
// mudar mais nada no código.
async function tryNativeForward(messageId, destChatId) {
  try {
    return await waClient.pupPage.evaluate(
      async (msgId, chatId) => {
        try {
          if (typeof window.WWebJS?.forwardMessage !== 'function') {
            return { ok: false, reason: 'wwebjs_forward_function_missing' };
          }
          await window.WWebJS.forwardMessage(chatId, msgId);
          return { ok: true };
        } catch (e) {
          return { ok: false, reason: e.message };
        }
      },
      messageId,
      destChatId
    );
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Varredura read-only de UM chat procurando anexos (mensagens com mídia) que
// batem com `query` (filename/caption/transcrição - mesma lógica de
// matchesQuery já usada em search_messages) - usada por find_and_forward_file
// e find_and_forward_files. NUNCA baixa/encaminha nada sozinha - só localiza
// candidatos; quem decide encaminhar é o chamador (forward_attachment).
async function findAttachmentCandidates({ chatId, query, canTranscribe, limitMatches = 10 }) {
  const needle = query.trim().toLowerCase();
  const scan = await scanChatForMatches({
    chatId,
    needle,
    limitMatches,
    deepSearch: true,
    deepAudioSearch: canTranscribe,
    canTranscribe,
  });
  if (scan.error) return { ok: false, error: scan.error };
  const attachmentMatches = scan.matches.filter((raw) => Boolean(raw.directPath));
  const candidates = attachmentMatches.map((raw) => {
    const info = formatMessage(raw);
    return {
      message_id: info.message_id,
      filename: info.filename,
      mimetype: info.mimetype,
      caption: info.caption || null,
      from: info.from,
      datetime: info.datetime,
    };
  });
  return { ok: true, candidates, scanned: scan.scanned, exhausted: scan.exhausted };
}

function isoToEpoch(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------
// Histórico de mensagens
//
// READ ONLY - MUST NOT SEND SEEN. Tudo nesta seção só lê o Store (chat.msgs,
// loadEarlierMsgs, getMessageModel) - nunca chama sendSeen/markChatUnread.
// Confirmado por auditoria do whatsapp-web.js 1.34.7: loadEarlierMsgs() e
// getChat(..., {getAsModel:false}) não têm nenhuma referência a "seen" ou
// "unread" no código-fonte, e testado na prática (ver notas de teste real
// no final do arquivo/relatório de entrega) - ler histórico de uma conversa
// não lida por aqui NÃO zera o unreadCount nem manda confirmação de leitura
// ao remetente. Isso é diferente de abrir a conversa na UI do WhatsApp Web
// (que o Chrome real faz via eventos de visibilidade do componente React,
// não disparados aqui já que não há nenhuma UI sendo renderizada/clicada).
//
// waClient.getChatById() (e portanto chat.fetchMessages() do jeito "normal")
// quebra com o mesmo bug de compatibilidade de getChats() (chama a mesma
// serialização interna problemática). Contorna replicando exatamente o que
// Chat.fetchMessages() do whatsapp-web.js faz por baixo dos panos, mas
// pegando o chat via window.WWebJS.getChat(id, {getAsModel:false}) - isso
// pula a serialização quebrada e devolve o modelo bruto do Store, que é
// tudo que loadEarlierMsgs()/o acesso a chat.msgs precisam.
// ---------------------------------------------------------------------------

// Mensagens já carregadas em memória para um chat (sem buscar mais no
// servidor do WhatsApp) - rápido, usado pela busca "sem chat específico".
async function getLoadedMessages(chatId, { beforeTs } = {}) {
  return waClient.pupPage.evaluate(
    (chatIdInner, beforeTsInner) => {
      return (async () => {
        const chat = await window.WWebJS.getChat(chatIdInner, { getAsModel: false });
        if (!chat) return { error: 'chat_not_found' };
        const msgs = chat.msgs
          .getModelsArray()
          .filter((m) => !m.isNotification && (beforeTsInner ? m.t < beforeTsInner : true))
          .map((m) => window.WWebJS.getMessageModel(m));
        const oldest = chat.msgs.getModelsArray()[0]?.t || null;
        return { messages: msgs, oldestLoadedTimestamp: oldest };
      })();
    },
    chatId,
    beforeTs || null
  );
}

// Carrega mensagens de um chat, paginando mensagens mais antigas
// (window.require('WAWebChatLoadMessages').loadEarlierMsgs) até atingir
// targetCount, respeitar beforeTs/afterTs, esgotar o histórico sincronizado
// pelo WhatsApp Web, ou bater o teto de segurança de lotes.
async function fetchChatHistory(chatId, { targetCount = 50, beforeTs, afterTs, maxBatches = 40 } = {}) {
  let batches = 0;
  // 'exhausted' = o WhatsApp Web confirmou que não há mais nada sincronizado
  // (limite REAL). 'target_reached'/'safety_cap' = paramos por causa do
  // limit pedido ou do teto de segurança do servidor - NÃO é o mesmo que
  // esgotar o histórico, então has_more fica true nesses casos.
  let stopReason = 'target_reached';
  let lastResult = null;
  for (;;) {
    const result = await waClient.pupPage.evaluate(
      (chatIdInner, beforeTsInner) => {
        return (async () => {
          const chat = await window.WWebJS.getChat(chatIdInner, { getAsModel: false });
          if (!chat) return { error: 'chat_not_found' };
          const filtered = chat.msgs
            .getModelsArray()
            .filter((m) => !m.isNotification && (beforeTsInner ? m.t < beforeTsInner : true));
          const oldestLoaded = chat.msgs.getModelsArray()[0]?.t || null;
          return { filteredCount: filtered.length, oldestLoaded, messages: filtered.map((m) => window.WWebJS.getMessageModel(m)) };
        })();
      },
      chatId,
      beforeTs || null
    );
    if (result.error) return result;
    lastResult = result;
    if (result.filteredCount >= targetCount) {
      stopReason = 'target_reached';
      break;
    }
    if (batches >= maxBatches) {
      stopReason = 'safety_cap';
      break;
    }
    log('fetching older messages: batch', batches + 1, '(', result.filteredCount, '/', targetCount, 'até agora)');
    const loadedCount = await waClient.pupPage.evaluate((chatIdInner) => {
      return (async () => {
        const chat = await window.WWebJS.getChat(chatIdInner, { getAsModel: false });
        if (!chat) return -1;
        const loaded = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
        return loaded ? loaded.length : 0;
      })();
    }, chatId);
    batches++;
    if (!loadedCount || loadedCount <= 0) {
      stopReason = 'exhausted';
      break;
    }
  }
  let msgs = lastResult.messages.sort((a, b) => a.t - b.t);
  if (afterTs) msgs = msgs.filter((m) => m.t > afterTs);
  const trimmed = targetCount ? msgs.slice(Math.max(0, msgs.length - targetCount)) : msgs;
  return {
    messages: trimmed,
    hasMoreOlder: stopReason !== 'exhausted',
    stopReason,
    oldestLoadedTimestamp: lastResult.oldestLoaded,
    batchesLoaded: batches,
  };
}

// transcriptionsById (opcional): Map message_id -> entrada de cache, carregada
// UMA VEZ pelo chamador (evita reler o arquivo de cache a cada mensagem).
// Pesquisa normal (sem deep_audio_search) só olha transcrições JÁ
// CACHEADAS - nunca transcreve áudio novo automaticamente (custo).
function matchesQuery(raw, needle, transcriptionsById) {
  const hasMedia = Boolean(raw.directPath);
  const messageId = messageIdToString(raw.id);
  const cachedTranscription = transcriptionsById?.get(messageId)?.transcription;
  const haystack = [hasMedia ? raw.caption : raw.body, raw.filename, raw.type, cachedTranscription]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

// Varredura profunda de UM chat: pagina mensagens mais antigas (um lote de
// cada vez) até achar `limitMatches` ocorrências, alcançar startTs, esgotar
// o histórico sincronizado pelo WhatsApp Web, ou bater maxBatches (teto de
// segurança). Registra quantas mensagens foram de fato examinadas.
async function scanChatForMatches({ chatId, needle, startTs, endTs, limitMatches, deepSearch, maxBatches = 200, deepAudioSearch, canTranscribe }) {
  let beforeTs = endTs;
  let scanned = 0;
  let batches = 0;
  const matches = [];
  let exhausted = false;
  let oldestScannedTs = null;
  const batchCap = deepSearch ? maxBatches : 3;
  const transcriptionsById = transcriptionCache.allByMessageId();

  for (;;) {
    const result = await waClient.pupPage.evaluate(
      (chatIdInner, beforeTsInner) => {
        return (async () => {
          const chat = await window.WWebJS.getChat(chatIdInner, { getAsModel: false });
          if (!chat) return { error: 'chat_not_found' };
          const before = chat.msgs.getModelsArray().filter((m) => !m.isNotification && (beforeTsInner ? m.t < beforeTsInner : true));
          return { messages: before.map((m) => window.WWebJS.getMessageModel(m)) };
        })();
      },
      chatId,
      beforeTs || null
    );
    if (result.error) return result;

    for (const raw of result.messages) {
      scanned++;
      oldestScannedTs = oldestScannedTs === null ? raw.t : Math.min(oldestScannedTs, raw.t);
      if (startTs && raw.t < startTs) continue;
      if (deepAudioSearch && canTranscribe && Boolean(raw.directPath) && (raw.mimetype || '').startsWith('audio/')) {
        const messageId = messageIdToString(raw.id);
        if (messageId && !transcriptionsById.get(messageId)) {
          const media = await downloadMessageMedia(messageId);
          if (media) {
            const transcribed = await transcribeAudio({
              messageId,
              buffer: Buffer.from(media.data, 'base64'),
              mimetype: media.mimetype || raw.mimetype,
              filename: media.filename || raw.filename,
              durationSeconds: raw.duration ?? null,
              cache: transcriptionCache,
              log,
            });
            if (transcribed.success) transcriptionsById.set(messageId, transcribed);
          }
        }
      }
      if (matchesQuery(raw, needle, transcriptionsById)) matches.push(raw);
    }

    const reachedStart = startTs !== undefined && oldestScannedTs !== null && oldestScannedTs < startTs;
    const enoughMatches = matches.length >= limitMatches;
    if (reachedStart || (enoughMatches && !deepSearch) || batches >= batchCap) {
      exhausted = false;
      break;
    }

    log('fetching older messages para busca: lote', batches + 1);
    const loadedCount = await waClient.pupPage.evaluate((chatIdInner) => {
      return (async () => {
        const chat = await window.WWebJS.getChat(chatIdInner, { getAsModel: false });
        if (!chat) return -1;
        const loaded = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
        return loaded ? loaded.length : 0;
      })();
    }, chatId);
    batches++;
    if (!loadedCount || loadedCount <= 0) {
      exhausted = true;
      break;
    }
    // Próximo lote: estritamente anterior ao mais antigo já examinado.
    beforeTs = oldestScannedTs;
    if (deepSearch && enoughMatches) {
      // já achou o suficiente em deep search - para, mas marca como não
      // esgotado (pode haver mais além do que foi examinado).
      break;
    }
  }

  return { matches: matches.slice(0, limitMatches), scanned, exhausted, oldestScannedTs };
}

// from/to/author às vezes vêm como objeto WID (com ._serialized), às vezes
// já como string, dependendo do tipo de chat (@c.us, @g.us, @lid) - mesma
// normalização que o próprio whatsapp-web.js faz na classe Message.
function widToString(value) {
  if (value && typeof value === 'object') return value._serialized || null;
  return value || null;
}

// O "id" bruto de uma mensagem nem sempre chega com "_serialized" (às vezes
// some na serialização). O formato real usado pelo WhatsApp é sempre
// "{fromMe}_{remote}_{id}[_{participant}]" - reconstruímos manualmente
// quando "_serialized" não sobrevive, para o message_id continuar sendo o
// ID REAL utilizável depois em get_message_media_info (Msg.get()).
function messageIdToString(id) {
  if (!id) return null;
  if (id._serialized) return id._serialized;
  if (id.remote && id.id !== undefined) {
    const parts = [id.fromMe, widToString(id.remote) ?? id.remote, id.id];
    if (id.participant) parts.push(widToString(id.participant) ?? id.participant);
    return parts.join('_');
  }
  return null;
}

function formatMessage(raw) {
  const hasMedia = Boolean(raw.directPath);
  const body = hasMedia ? raw.caption || '' : raw.body || raw.pollName || raw.eventName || '';
  const ts = raw.t || null;
  return {
    message_id: messageIdToString(raw.id),
    timestamp: ts,
    datetime: ts ? new Date(ts * 1000).toISOString() : null,
    from: widToString(raw.from),
    to: widToString(raw.to),
    from_me: !!raw.id?.fromMe,
    author: widToString(raw.author),
    body,
    type: raw.type || null,
    has_media: hasMedia,
    filename: raw.filename || null,
    mimetype: raw.mimetype || null,
    duration: raw.duration ?? null,
    caption: hasMedia ? raw.caption || null : null,
    quoted_message_id: raw.quotedMsg?.id?._serialized || raw.quotedStanzaID || null,
    links: Array.isArray(raw.links) ? raw.links.map((l) => l.link) : [],
  };
}

// Monta a linha de contexto a partir de uma mensagem JÁ formatada
// (formatMessage) e opcionalmente já enriquecida com transcrição
// (transcribeMessageIfAudio). Separado de formatMessageAsContextLine para
// poder enriquecer com áudio ANTES de montar o texto (ver get_chat_context).
function buildContextLine(m, { chatName, isGroup } = {}) {
  const date = m.datetime ? new Date(m.datetime) : null;
  const stamp = date
    ? `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
    : 'sem data';
  // Em conversa individual, quem não é "Você" só pode ser a outra pessoa do
  // chat (usamos o nome do chat em vez do ID cru, mais legível). Em grupo,
  // "author" identifica quem mandou dentro do grupo - mostramos o ID quando
  // não temos um nome resolvido para ele (evita mostrar "[object Object]").
  const who = m.from_me ? 'Você' : !isGroup ? chatName || m.from || '?' : m.author || m.from || '?';
  if (m.has_media) {
    const kind = (m.type || 'mídia').toUpperCase();
    const durationTag = m.type === 'ptt' || m.type === 'audio' ? formatDurationTag(m.duration) : '';
    const parts = [`[${stamp}] ${who}:`, `[${kind}${durationTag}]`];
    if (m.transcription) {
      parts.push(`Transcrição (${m.transcription_source}):`, `"${m.transcription}"`);
    } else if (m.transcription_available === true && m.transcription_source === 'scope_denied') {
      parts.push('Transcrição indisponível (token sem escopo whatsapp:transcribe).');
    } else if (m.transcription_error) {
      parts.push(`Transcrição indisponível. Motivo: ${m.transcription_error}`);
    } else {
      if (m.filename) parts.push(`arquivo: ${m.filename}`);
      if (m.mimetype) parts.push(`mimetype: ${m.mimetype}`);
      if (m.caption) parts.push(`caption: "${m.caption}"`);
    }
    return parts.join('\n');
  }
  return `[${stamp}] ${who}:\n"${m.body}"`;
}

function formatDurationTag(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return ` - ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatMessageAsContextLine(raw, opts = {}) {
  return buildContextLine(formatMessage(raw), opts);
}

// Baixa a mídia de uma mensagem. Replica o downloadMedia() da própria
// classe Message do whatsapp-web.js, mas usando DIRETAMENTE o message_id
// real que já calculamos (messageIdToString) em vez de instanciar a classe
// Message da lib - seu construtor guarda `this.id` como o objeto bruto, e
// `this.id._serialized` (usado internamente pelo downloadMedia original)
// não existe nesse objeto, quebrando o download com o mesmo bug de sempre.
async function downloadMessageMedia(messageId) {
  return waClient.pupPage.evaluate(async (msgId) => {
    const collections = window.require('WAWebCollections');
    const msg = collections.Msg.get(msgId) || (await collections.Msg.getMessagesById([msgId]))?.messages?.[0];
    if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') return null;
    if (msg.mediaData.mediaStage !== 'RESOLVED') {
      await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
    }
    if (msg.mediaData.mediaStage.includes('ERROR') || msg.mediaData.mediaStage === 'FETCHING') return null;
    const mockQpl = {
      addAnnotations: function () {
        return this;
      },
      addPoint: function () {
        return this;
      },
    };
    const baseParams = {
      directPath: msg.directPath,
      encFilehash: msg.encFilehash,
      filehash: msg.filehash,
      mediaKey: msg.mediaKey,
      mediaKeyTimestamp: msg.mediaKeyTimestamp,
      signal: new AbortController().signal,
      downloadQpl: mockQpl,
    };
    const downloadManager = window.require('WAWebDownloadManager').downloadManager;
    try {
      let decryptedMedia;
      try {
        decryptedMedia = await downloadManager.downloadAndMaybeDecrypt({ ...baseParams, type: msg.type });
      } catch (e) {
        // Bug de compatibilidade conhecido nesta versão do WhatsApp Web: a
        // validação de mimetype do content-type devolvido pelo CDN
        // ("application/octet-stream") rejeita tipos 'ptt'/'audio' mesmo
        // quando o arquivo decifra perfeitamente - confirmado manualmente
        // (cabeçalho OggS correto) que forçar type:'document' só pula essa
        // checagem de mimetype; a derivação da chave de decriptação usa
        // mediaKey/encFilehash do PRÓPRIO arquivo, não o "type" passado
        // aqui, então o conteúdo decifrado continua correto.
        if (!String(e.message).includes('Unexpected mimetype') || msg.type === 'document') throw e;
        decryptedMedia = await downloadManager.downloadAndMaybeDecrypt({ ...baseParams, type: 'document' });
      }
      const data = await window.WWebJS.arrayBufferToBase64Async(decryptedMedia);
      return { data, mimetype: msg.mimetype, filename: msg.filename, filesize: msg.size };
    } catch (e) {
      if (e.status && e.status === 404) return null;
      throw e;
    }
  }, messageId);
}

// ---------------------------------------------------------------------------
// Cache persistente de transcrições de áudio - sobrevive a restart/rebuild
// (volume próprio, ./transcription-data:/app/.transcription-data). Chave
// primária message_id, secundária audio_hash (ver transcription.js).
// ---------------------------------------------------------------------------
const TRANSCRIPTION_DATA_DIR = path.join(DATA_ROOT, '.transcription-data');
fs.mkdirSync(TRANSCRIPTION_DATA_DIR, { recursive: true });
const transcriptionCache = new TranscriptionCache(`${TRANSCRIPTION_DATA_DIR}/transcriptions.json`);

// READ ONLY - MUST NOT SEND SEEN. downloadMessageMedia() já é só leitura (ver
// comentário na própria função); transcribeAudio() só chama a API externa da
// OpenAI, nunca interage com o WhatsApp de novo. Enriquece uma mensagem já
// formatada (formatMessage) com a transcrição quando ela for um áudio.
async function transcribeMessageIfAudio(m, { transcribeFlag, canTranscribe }) {
  if (!transcribeFlag || !m.has_media || !(m.mimetype || '').startsWith('audio/')) return m;
  if (!canTranscribe) {
    return { ...m, transcription_available: true, transcription: null, transcription_source: 'scope_denied' };
  }
  const media = await downloadMessageMedia(m.message_id);
  if (!media) {
    return { ...m, transcription_available: false, transcription: null, transcription_error: 'download_failed' };
  }
  const result = await transcribeAudio({
    messageId: m.message_id,
    buffer: Buffer.from(media.data, 'base64'),
    mimetype: media.mimetype || m.mimetype,
    filename: media.filename || m.filename,
    durationSeconds: m.duration ?? null,
    cache: transcriptionCache,
    log,
  });
  if (!result.success) {
    return { ...m, transcription_available: false, transcription: null, transcription_error: result.error };
  }
  return { ...m, transcription_available: true, transcription: result.transcription, transcription_source: result.transcription_source };
}

// ---------------------------------------------------------------------------
// Cache temporário de mídia baixada (get_message_media_info com download=true)
// Fica só dentro do container (não é dado precioso como a sessão/OAuth) -
// links somem se o container reiniciar. Servido só sob o mesmo Bearer OAuth.
// ---------------------------------------------------------------------------
const MEDIA_DIR = path.join(DATA_ROOT, '.media-cache');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const mediaRegistry = new Map();
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

function cleanupOldMedia() {
  const cutoff = Date.now() - MEDIA_TTL_MS;
  for (const [id, entry] of mediaRegistry.entries()) {
    if (entry.createdAt < cutoff) {
      fs.rmSync(path.join(MEDIA_DIR, entry.storedFilename), { force: true });
      mediaRegistry.delete(id);
    }
  }
}

const MIME_EXTENSIONS = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

function extensionForMimetype(mimetype) {
  if (!mimetype) return '';
  if (MIME_EXTENSIONS[mimetype]) return MIME_EXTENSIONS[mimetype];
  const guess = mimetype.split('/')[1];
  return guess ? `.${guess.split(';')[0]}` : '';
}

// ---------------------------------------------------------------------------
// Armazenamento de arquivos por storage_id (download/import/envio).
//
// Volume próprio por instância (./.files-data, bind mount dedicado) -
// isolado da mesma forma que sessão/tokens/cache de transcrição: a
// uma instância não enxerga nem acessa arquivos de outra instância,
// e vice-versa, porque cada container só tem o SEU PRÓPRIO diretório
// montado (nunca o diretório de outra instância).
//
// registry.json guarda só METADADOS (storage_id, filename, mimetype, size,
// hash, created_at, expires_at, source) - os bytes em si ficam em
// blobs/<storage_id>. destination="temporary" expira em FILES_TMP_TTL_MS
// (limpeza preguiçosa, mesma técnica do cache de mídia); "persistent" fica
// para sempre (expires_at: null) até ser apagado manualmente.
// ---------------------------------------------------------------------------
const FILES_DATA_DIR = path.join(DATA_ROOT, '.files-data');
const FILES_BLOBS_DIR = `${FILES_DATA_DIR}/blobs`;
fs.mkdirSync(FILES_BLOBS_DIR, { recursive: true });

const FILES_TMP_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_SIZE_BYTES = Number(process.env.MAX_FILE_SIZE_MB || '64') * 1024 * 1024;

// ---------------------------------------------------------------------------
// Upload temporário (ingestão remota) - ver temp-files.js para o racional
// completo. Diretório PRÓPRIO desta instância (nunca compartilhado com
// .files-data, para deixar claro na própria estrutura de disco que isto é
// efêmero/não é a biblioteca de arquivos "de verdade").
// ---------------------------------------------------------------------------
const TMP_FILES_DATA_DIR = path.join(DATA_ROOT, '.tmp-files');
const TMP_FILES_BLOBS_DIR = `${TMP_FILES_DATA_DIR}/blobs`;
const TEMP_FILE_TTL_MINUTES = Number(process.env.TEMP_FILE_TTL_MINUTES || '60');
const TEMP_BASE64_MAX_MB = Number(process.env.TEMP_BASE64_MAX_MB || '2');
const TEMP_BASE64_MAX_BYTES = TEMP_BASE64_MAX_MB * 1024 * 1024;

const tempFileStore = new TempFileStore({ dataDir: TMP_FILES_DATA_DIR, blobsDir: TMP_FILES_BLOBS_DIR });

// Varredura de TTL - roda sozinha, sem precisar de tool/CLI admin (pedido
// explícito: "usuário comum não precisa chamar isso"). Loga cada arquivo
// expirado removido, só com metadados (nunca conteúdo). Roda uma vez já no
// boot (pega o que expirou enquanto o container estava parado) e depois a
// cada 5 minutos.
function runTempFileCleanup() {
  const expired = tempFileStore.cleanupExpired();
  for (const entry of expired) {
    auditLog({ action: 'temp_file_expired', temp_file_id: entry.temp_file_id, filename: entry.filename, hash: entry.hash, size: entry.size });
    log('[WHATSAPP-MCP][TEMP] expirado removido', entry.temp_file_id, entry.filename);
  }
}
runTempFileCleanup();
setInterval(runTempFileCleanup, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Google Drive (v1.5.0) - ver google-drive.js para o módulo completo. OAuth
// PRÓPRIO do WhatsApp MCP (nunca a conexão Google do Claude/ChatGPT - são sistemas
// independentes). Um único GOOGLE_CLIENT_ID/SECRET compartilhado entre
// instâncias; cada drive_connection tem seu próprio refresh_token
// (criptografado em repouso com DRIVE_TOKEN_ENCRYPTION_KEY, própria de cada
// instância). Sem credenciais OAuth configuradas, as tools/rotas de Drive
// respondem com `drive_oauth_not_configured` em vez de quebrar.
// ---------------------------------------------------------------------------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;
const DRIVE_TOKEN_ENCRYPTION_KEY = process.env.DRIVE_TOKEN_ENCRYPTION_KEY || null;
const DRIVE_OAUTH_REDIRECT_URI = `${PUBLIC_URL}/oauth/google/callback`;
const DRIVE_DATA_DIR = path.join(DATA_ROOT, '.drive-data');
fs.mkdirSync(DRIVE_DATA_DIR, { recursive: true });
const driveConnectionStore = new DriveConnectionStore(`${DRIVE_DATA_DIR}/connections.json`);

function driveOAuthConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && DRIVE_TOKEN_ENCRYPTION_KEY);
}

// Mensagem precisa de "o que falta" (em vez de listar as 3 variáveis sempre,
// mesmo quando só 1-2 estão faltando de verdade).
function driveOAuthMissingVars() {
  const missing = [];
  if (!GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!DRIVE_TOKEN_ENCRYPTION_KEY) missing.push('DRIVE_TOKEN_ENCRYPTION_KEY');
  return missing;
}

// Estado efêmero (em memória, TTL curto) do fluxo OAuth entre
// /admin/drive/connect e /oauth/google/callback - evita CSRF e carrega o
// display_name escolhido pelo admin até o callback voltar.
const driveOAuthStates = new Map(); // state -> { displayName, createdAt }
function cleanupDriveOAuthStates() {
  const now = Date.now();
  for (const [state, data] of driveOAuthStates.entries()) {
    if (now - data.createdAt > 10 * 60 * 1000) driveOAuthStates.delete(state);
  }
}

// Resolve + autentica uma drive_connection para uma tool - devolve
// {ok:true, connection, accessToken} ou {ok:false, response: <CallToolResult
// de erro pronto para return>}. Centraliza as checagens comuns (feature
// flag, OAuth configurado, conexão existe/não revogada, token válido) para
// não repetir em cada tool de Drive.
async function resolveDriveAccess({ connectionRef, requiredFeature }) {
  const featureError = requireFeature('FEATURE_GOOGLE_DRIVE') || (requiredFeature ? requireFeature(requiredFeature) : null);
  if (featureError) return { ok: false, response: featureError };
  if (!driveOAuthConfigured()) {
    return {
      ok: false,
      response: toolErrorResponse(
        'drive_oauth_not_configured',
        `Integração com Google Drive ainda não configurada nesta instância (faltando: ${driveOAuthMissingVars().join(', ')}) - peça para o administrador configurar e conectar uma conta em /admin/drive.`
      ),
    };
  }
  const resolved = driveConnectionStore.resolve(connectionRef);
  if (!resolved.ok) {
    const messages = {
      drive_not_connected: 'Nenhuma conexão Google Drive configurada ainda - peça para o administrador acessar /admin/drive e conectar uma conta.',
      connection_not_found: `Conexão "${connectionRef}" não encontrada.`,
      ambiguous_connection: 'Mais de uma conexão Google Drive - especifique drive_connection.',
    };
    return {
      ok: false,
      response: toolErrorResponse(resolved.error, messages[resolved.error] || resolved.error, resolved.candidates ? { candidates: resolved.candidates } : undefined),
    };
  }
  if (resolved.connection.status === 'revoked') {
    return { ok: false, response: toolErrorResponse('connection_revoked', `A conexão "${resolved.connection.display_name}" foi revogada - reconecte em /admin/drive.`) };
  }
  try {
    const accessToken = await getValidAccessToken({
      connection: resolved.connection,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      encryptionKey: DRIVE_TOKEN_ENCRYPTION_KEY,
      store: driveConnectionStore,
    });
    return { ok: true, connection: resolved.connection, accessToken };
  } catch (err) {
    driveConnectionStore.update(resolved.connection.connection_id, { status: 'error' });
    return {
      ok: false,
      response: toolErrorResponse('token_refresh_failed', `Falha ao renovar acesso à conexão "${resolved.connection.display_name}": ${err.message}. Pode ser necessário reconectar em /admin/drive.`),
    };
  }
}

// Baixa um arquivo do Drive (respeitando root_folder_ids) e grava no MESMO
// armazenamento temporário de upload_temp_file - devolve {ok:true, entry}
// no mesmo formato de tempFileStore.put(), ou {ok:false, error, message}.
// Usado por import_drive_file e por todas as tools send_drive_*/
// find_and_send_drive_* (evita duplicar a lógica de download+gravação).
async function importDriveFileToTempStore({ access, fileId }) {
  const meta = await driveGetFileMetadata({ accessToken: access.accessToken, fileId });
  if (access.connection.root_folder_ids?.length) {
    const allowed = await isUnderAllowedRoot({ accessToken: access.accessToken, fileId, rootFolderIds: access.connection.root_folder_ids });
    if (!allowed) return { ok: false, error: 'path_not_allowed', message: 'Este arquivo está fora das root_folder_ids autorizadas para esta conexão.' };
  }
  const { buffer, mimetype } = await driveDownloadFileContent({ accessToken: access.accessToken, fileId, mimeType: meta.mimeType, purpose: 'send' });
  if (buffer.length === 0) return { ok: false, error: 'empty_file', message: 'Arquivo vazio.' };
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    return { ok: false, error: 'file_too_large', message: `Arquivo de ${buffer.length} bytes excede o limite de ${MAX_FILE_SIZE_BYTES} bytes.` };
  }
  const isNative = isGoogleNativeMimetype(meta.mimeType);
  const filename = sanitizeFilename(isNative ? `${meta.name}.pdf` : meta.name) || `drive_${fileId}`;
  const tempFileId = `tmp_${randomUUID().replace(/-/g, '')}`;
  const hash = sha256Hex(buffer);
  fs.writeFileSync(tempFileStore.blobPath(tempFileId), buffer);
  const expiresAt = new Date(Date.now() + TEMP_FILE_TTL_MINUTES * 60 * 1000).toISOString();
  const entry = tempFileStore.put({
    temp_file_id: tempFileId,
    filename,
    mimetype,
    size: buffer.length,
    hash,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    status: 'uploaded',
    source: 'google_drive',
    drive_connection_id: access.connection.connection_id,
    drive_file_id: fileId,
  });
  return { ok: true, entry };
}

class FileRegistry {
  constructor(filePath) {
    this.filePath = filePath;
  }
  _reload() {
    try {
      this.entries = new Map(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch {
      this.entries = new Map();
    }
    return this.entries;
  }
  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify([...this.entries.entries()], null, 2));
  }
  get(storageId) {
    return this._reload().get(storageId) || null;
  }
  put(entry) {
    this._reload();
    this.entries.set(entry.storage_id, entry);
    this._save();
    return entry;
  }
  cleanupExpired() {
    this._reload();
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of this.entries.entries()) {
      if (entry.expires_at && new Date(entry.expires_at).getTime() < now) {
        fs.rmSync(path.join(FILES_BLOBS_DIR, id), { force: true });
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this._save();
  }
}
const fileRegistry = new FileRegistry(`${FILES_DATA_DIR}/registry.json`);

// request_id -> { result, ts } - evita reenviar o mesmo arquivo/lote se a
// mesma chamada (request_id) for repetida por retry acidental do cliente.
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;
class IdempotencyStore {
  constructor(filePath) {
    this.filePath = filePath;
  }
  _reload() {
    try {
      this.entries = new Map(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch {
      this.entries = new Map();
    }
    return this.entries;
  }
  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify([...this.entries.entries()], null, 2));
  }
  get(requestId) {
    const entries = this._reload();
    const hit = entries.get(requestId);
    if (!hit) return null;
    if (Date.now() - hit.ts > IDEMPOTENCY_TTL_MS) return null;
    return hit.result;
  }
  put(requestId, result) {
    this._reload();
    this.entries.set(requestId, { result, ts: Date.now() });
    this._save();
  }
}
const idempotencyStore = new IdempotencyStore(`${FILES_DATA_DIR}/idempotency.json`);

// Mascarar números de telefone em log técnico (grupos, que não são dados
// pessoais da mesma forma, ficam como estão).
function maskChatId(chatId) {
  if (!chatId) return chatId;
  if (chatId.endsWith('@g.us')) return chatId;
  const digits = chatId.split('@')[0];
  if (digits.length <= 4) return chatId;
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}@${chatId.split('@')[1]}`;
}

function sanitizeFilename(name) {
  if (!name) return null;
  // Só tira caracteres perigosos para nome de arquivo/caminho - preserva o
  // nome original o máximo possível (ex: "Renato_CIN.pdf" continua igual).
  return name.replace(/[/\\\0]/g, '_').replace(/^\.+/, '').slice(0, 200) || null;
}

// Caminhos explicitamente autorizados para import_file/file_path (allowlist
// por instância, via FILE_ALLOWED_PATHS no .env - CSV de diretórios
// absolutos). Vazio por padrão (import/file_path desligados até o admin da
// instância configurar). Canonicaliza (resolve symlink e "..") antes de
// comparar - bloqueia path traversal e symlinks apontando pra fora.
const FILE_ALLOWED_PATHS = (process.env.FILE_ALLOWED_PATHS || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

function resolveAllowedPath(inputPath) {
  if (!FILE_ALLOWED_PATHS.length) {
    return { ok: false, error: 'no_allowed_paths_configured' };
  }
  let real;
  try {
    real = fs.realpathSync(inputPath);
  } catch {
    return { ok: false, error: 'file_not_found' };
  }
  const allowed = FILE_ALLOWED_PATHS.some((base) => {
    let realBase;
    try {
      realBase = fs.realpathSync(base);
    } catch {
      return false;
    }
    return real === realBase || real.startsWith(realBase + path.sep);
  });
  if (!allowed) return { ok: false, error: 'path_not_allowed' };
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, error: 'file_not_found' };
  }
  if (!stat.isFile()) return { ok: false, error: 'not_a_regular_file' };
  return { ok: true, path: real, size: stat.size };
}

// Resolve a origem de um arquivo a enviar: temp_file_id (upload remoto via
// upload_temp_file - ver seção dedicada), storage_id (download/import
// antigos) OU file_path (precisa estar na allowlist). Devolve o buffer já
// carregado - chamador deve checar MAX_FILE_SIZE_BYTES ANTES de chamar isto
// para arquivos por file_path (aqui também checa, como segunda proteção).
// Quando a origem é temp_file_id, o retorno inclui `tempFileId` - o chamador
// (handleFileSend/send_files) usa isso para apagar o arquivo temporário
// IMEDIATAMENTE após confirmar que o envio deu certo (nunca antes).
async function resolveFileSource({ storage_id, file_path, temp_file_id, filename }) {
  if (temp_file_id) {
    const entry = tempFileStore.get(temp_file_id);
    if (!entry) return { ok: false, error: 'temp_file_id_not_found', message: 'temp_file_id não encontrado (já enviado/apagado, expirado, ou de outra instância).' };
    const blobPath = tempFileStore.blobPath(temp_file_id);
    if (!fs.existsSync(blobPath)) return { ok: false, error: 'temp_file_blob_missing' };
    const buffer = fs.readFileSync(blobPath);
    return { ok: true, buffer, mimetype: entry.mimetype, filename: filename || entry.filename, size: entry.size, tempFileId: temp_file_id };
  }
  if (storage_id) {
    const entry = fileRegistry.get(storage_id);
    if (!entry) return { ok: false, error: 'storage_id_not_found' };
    const blobPath = path.join(FILES_BLOBS_DIR, storage_id);
    if (!fs.existsSync(blobPath)) return { ok: false, error: 'blob_missing' };
    const buffer = fs.readFileSync(blobPath);
    return { ok: true, buffer, mimetype: entry.mimetype, filename: filename || entry.filename, size: entry.size };
  }
  if (file_path) {
    const resolved = resolveAllowedPath(file_path);
    if (!resolved.ok) return resolved;
    if (resolved.size > MAX_FILE_SIZE_BYTES) {
      return { ok: false, error: 'file_too_large', message: `Arquivo de ${resolved.size} bytes excede o limite de ${MAX_FILE_SIZE_BYTES} bytes.` };
    }
    const buffer = fs.readFileSync(resolved.path);
    const mimetype = mimetypeFromExtension(resolved.path) || 'application/octet-stream';
    return { ok: true, buffer, mimetype, filename: filename || sanitizeFilename(path.basename(resolved.path)), size: resolved.size };
  }
  return { ok: false, error: 'missing_source', message: 'Informe temp_file_id, storage_id ou file_path.' };
}

const EXTENSION_MIMETYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

function mimetypeFromExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MIMETYPES[ext] || null;
}

function pickSendMode(mimetype, mode) {
  const base = (mimetype || '').split(';')[0].trim();
  if (mode === 'document') return true;
  if (mode === 'image' || mode === 'audio' || mode === 'video') return false;
  // auto: imagem/áudio/vídeo nativo, qualquer outra coisa como documento.
  return !(base.startsWith('image/') || base.startsWith('audio/') || base.startsWith('video/'));
}

// WRITE - envia de verdade pelo WhatsApp (não é read-only). Mesma ressalva
// do send_message: sendMessage() marca a conversa como lida por padrão
// (sendSeen=true nativo da lib) - não suprimimos isso aqui (ver seção
// "send_message" acima para o raciocínio completo).
async function sendFileCore({ targetId, buffer, mimetype, filename, caption, mode }) {
  const asDocument = pickSendMode(mimetype, mode);
  const media = new MessageMedia(mimetype, buffer.toString('base64'), filename || undefined, buffer.length);
  const sentMessage = await waClient.sendMessage(targetId, media, {
    caption: caption || undefined,
    sendMediaAsDocument: asDocument,
  });
  return {
    message_id: sentMessage?.id?._serialized || null,
    timestamp: sentMessage?.timestamp ? new Date(sentMessage.timestamp * 1000).toISOString() : new Date().toISOString(),
  };
}

// Resolve "chat" (nome livre, como no exemplo do pedido) ou chat_id/contact
// já existentes - mesma lógica de resolução usada pelas outras tools,
// nunca inventa/deduz um chat_id a partir de nome sem confirmar unicidade.
async function resolveSendTarget({ chat_id, contact, chat }) {
  return resolveTargetChat({ chat_id, contact: contact || chat });
}


//
// Autorização e recurso no mesmo domínio, DCR em /register, PKCE S256 obrigatório,
// login por senha em /authorize (não é auto-aprovação), tokens de acesso
// curtos + refresh token rotativo.
//
// Clientes registrados (DCR) e refresh tokens são persistidos em disco
// (/app/.oauth-data, volume próprio) para sobreviver a rebuilds do
// container sem forçar o Claude a refazer o registro/login toda hora.
// Códigos de autorização e access tokens são de vida curta e ficam só em
// memória - perdê-los num restart é inofensivo (o cliente reautentica pelo
// refresh token, que esse sim é persistido).
// ---------------------------------------------------------------------------

// Identidades (usuários autorizados). Bootstrap: na primeiríssima vez que o
// servidor sobe para esta instância, cria uma identidade administrativa.
const identityStore = new IdentityStore(`${OAUTH_DATA_DIR}/identities.json`);
if (identityStore.list().length === 0) {
  const bootstrapLabel = process.env.BOOTSTRAP_LABEL || 'Admin';
  const bootstrapLogin = process.env.BOOTSTRAP_LOGIN || 'admin';
  identityStore.create({ label: bootstrapLabel, login: bootstrapLogin, secret: initialPassword(), scopes: [...ALL_SCOPES] });
  console.log(`[identidades] bootstrap: identidade "${bootstrapLogin}" criada (escopos completos).`);
}

// Log de auditoria - nunca grava o token em si, só quem (identity/label) fez
// o quê. Append-only em arquivo (sobrevive a restart) + console.
const AUDIT_LOG_PATH = `${OAUTH_DATA_DIR}/audit.log`;
function auditLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, line + '\n');
  } catch {
    // não deixa falha de log derrubar a requisição
  }
  console.log('[MCP][audit]', line);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

function saveJsonFile(filePath, entries) {
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

class FileBackedClientsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.clients = new Map(loadJsonFile(filePath));
  }

  async getClient(clientId) {
    return this.clients.get(clientId);
  }

  async registerClient(clientMetadata) {
    this.clients.set(clientMetadata.client_id, clientMetadata);
    saveJsonFile(this.filePath, [...this.clients.entries()]);
    return clientMetadata;
  }
}

function renderLoginPage({ clientName, hidden, error, loginValue }) {
  const hiddenInputs = Object.entries(hidden)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value ?? '')}">`)
    .join('\n      ');
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Autorizar acesso - WhatsApp MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1c1c1c; border-radius: 12px; padding: 32px; width: 100%; max-width: 380px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    h1 { font-size: 18px; margin: 0 0 4px; }
    p.sub { color: #aaa; font-size: 14px; margin: 0 0 24px; }
    label { display: block; font-size: 13px; color: #ccc; margin-bottom: 6px; }
    input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #333; background: #0f0f0f; color: #eee; font-size: 15px; margin-bottom: 16px; }
    button { width: 100%; padding: 11px; border-radius: 8px; border: none; background: #25d366; color: #063; font-weight: 600; font-size: 15px; cursor: pointer; }
    button:hover { background: #1fbd5a; }
    .error { background: #3a1414; color: #ff8a8a; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Autorizar acesso ao WhatsApp</h1>
    <p class="sub">${escapeHtml(clientName)} está pedindo acesso às ferramentas do WhatsApp MCP.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/authorize/approve">
      ${hiddenInputs}
      <label for="login">Usuário</label>
      <input type="text" id="login" name="login" value="${escapeHtml(loginValue || '')}" autofocus required autocomplete="username">
      <label for="password">Senha</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit">Autorizar</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

class WhatsAppOAuthProvider {
  constructor({ dataDir, identityStore }) {
    this.identityStore = identityStore;
    this.clientsStore = new FileBackedClientsStore(`${dataDir}/clients.json`);
    // Refresh tokens ficam persistidos só pelo HASH (nunca o valor em si) -
    // o valor bruto só existe em memória no instante em que é emitido para
    // o cliente, nunca é escrito em disco.
    this._refreshTokensPath = `${dataDir}/refresh-tokens.json`;
    this.refreshTokensByHash = new Map(loadJsonFile(this._refreshTokensPath));
    this.codes = new Map();
    this.accessTokens = new Map();
  }

  _persistRefreshTokens() {
    saveJsonFile(this._refreshTokensPath, [...this.refreshTokensByHash.entries()]);
  }

  // Confere se a identidade dona de um token ainda existe e não foi
  // revogada/expirada - checado tanto ao emitir quanto ao verificar tokens,
  // para que revogar uma identidade derrube o acesso na hora (não só nas
  // próximas renovações).
  _identityStillUsable(identityId) {
    const identity = this.identityStore.getById(identityId);
    return this.identityStore.isUsable(identity) ? identity : null;
  }

  _issueTokenPair(clientId, identityId, scopes, resource) {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    this.accessTokens.set(accessToken, {
      clientId,
      identityId,
      scopes,
      resource,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    this.refreshTokensByHash.set(hashToken(refreshToken), { clientId, identityId, scopes, resource });
    this._persistRefreshTokens();
    this.identityStore.touchLastUsed(identityId);
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async authorize(client, params, res) {
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError('redirect_uri não registrado para este cliente.');
    }
    const html = renderLoginPage({
      clientName: client.client_name || client.client_id,
      hidden: {
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        state: params.state || '',
        code_challenge: params.codeChallenge,
        scope: (params.scopes || []).join(' '),
        resource: params.resource ? params.resource.toString() : '',
      },
    });
    res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new InvalidGrantError('Código de autorização inválido.');
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, _redirectUri, _resource) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new InvalidGrantError('Código de autorização inválido.');
    if (codeData.client.client_id !== client.client_id) {
      throw new InvalidGrantError('Código de autorização não foi emitido para este cliente.');
    }
    this.codes.delete(authorizationCode);
    const identity = this._identityStillUsable(codeData.identityId);
    if (!identity) throw new InvalidGrantError('Identidade revogada ou expirada.');
    return this._issueTokenPair(client.client_id, identity.id, identity.scopes, codeData.params.resource);
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const hash = hashToken(refreshToken);
    const data = this.refreshTokensByHash.get(hash);
    if (!data) throw new InvalidGrantError('Refresh token inválido.');
    if (data.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token não foi emitido para este cliente.');
    }
    // Rotaciona o refresh token a cada uso (recomendação OAuth 2.1).
    this.refreshTokensByHash.delete(hash);
    const identity = this._identityStillUsable(data.identityId);
    if (!identity) {
      this._persistRefreshTokens();
      throw new InvalidGrantError('Identidade revogada ou expirada.');
    }
    // O cliente pode pedir um subconjunto dos scopes da identidade, nunca mais.
    const requestedScopes = scopes && scopes.length ? scopes.filter((s) => identity.scopes.includes(s)) : identity.scopes;
    return this._issueTokenPair(client.client_id, identity.id, requestedScopes, resource || data.resource);
  }

  async verifyAccessToken(token) {
    const data = this.accessTokens.get(token);
    if (!data || data.expiresAt < Date.now()) {
      throw new InvalidTokenError('Token inválido ou expirado.');
    }
    const identity = this._identityStillUsable(data.identityId);
    if (!identity) {
      this.accessTokens.delete(token);
      throw new InvalidTokenError('Identidade revogada ou expirada.');
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expiresAt / 1000),
      resource: data.resource,
      extra: { identityId: identity.id, label: identity.label },
    };
  }

  async revokeToken(_client, request) {
    this.accessTokens.delete(request.token);
    if (this.refreshTokensByHash.delete(hashToken(request.token))) {
      this._persistRefreshTokens();
    }
  }
}

const oauthProvider = new WhatsAppOAuthProvider({ dataDir: OAUTH_DATA_DIR, identityStore });
await provisionPlatform({ identityStore, provider: oauthProvider, instance: INSTANCE_NAME,
  name: INSTANCE_DISPLAY_NAME, publicUrl: PUBLIC_URL });

const issuerUrl = new URL(`${PUBLIC_URL}/`);
const resourceServerUrl = new URL(`${PUBLIC_URL}/mcp`);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

// ---------------------------------------------------------------------------
// Transporte MCP Streamable HTTP (stateless) com autenticação OAuth
// ---------------------------------------------------------------------------
const app = express();
// Trust forwarding headers only behind an explicitly configured reverse proxy.
app.set('trust proxy', Number(process.env.MCP_PROXY_HOPS || 0));
// Limite padrão do express.json() é 100kb - pequeno demais para aceitar
// content_base64 (upload_temp_file): base64 infla o tamanho em ~33%, mais a
// margem do envelope JSON-RPC. Calculado a partir de TEMP_BASE64_MAX_MB com
// folga generosa (x2) em vez de um valor fixo, para continuar correto se
// essa env var for aumentada numa instância.
const JSON_BODY_LIMIT_MB = Math.max(4, TEMP_BASE64_MAX_MB * 2);
app.use(express.json({ limit: `${JSON_BODY_LIMIT_MB}mb` }));
app.use(express.urlencoded({ extended: false }));
registerConnectionManagement(app, {dataDir:OAUTH_DATA_DIR, identityStore, provider:oauthProvider,
  instance:INSTANCE_NAME, publicUrl:PUBLIC_URL, rateLimiter:rateLimit({windowMs:60000,limit:60})});

app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: ['mcp'],
    resourceName: INSTANCE_DISPLAY_NAME,
  })
);

// ---------------------------------------------------------------------------
// Páginas públicas institucionais (/ e /privacy) - v1.6.0. Exigência do
// Google para publicar o OAuth Client em produção (branding: precisa de
// Homepage URL e Privacy Policy URL públicas, sem login). Propositalmente
// SÓ texto estático - nenhum dado de sessão/token/número/arquivo/log, nada
// que dependa de identityStore ou de qualquer estado interno. Mesmo
// conteúdo em TODAS as instâncias (codebase compartilhado) - não é
// específico da conta conectada de propósito, para
// não publicar nome de pessoa numa página indexável publicamente.
//
// CONTATO: nenhum e-mail técnico/administrativo "do projeto" estava
// configurado em lugar nenhum da base (o e-mail do Caddyfile é só do
// registro ACME/Let's Encrypt, finalidade diferente) - por isso o campo
// abaixo é um placeholder explícito. Preencha PRIVACY_CONTACT_EMAIL antes
// de publicar o OAuth Client (ver AGENTS.md).
const PRIVACY_CONTACT_EMAIL = process.env.PRIVACY_CONTACT_EMAIL || 'Consulte o administrador desta instalação.';

function renderPublicLayout({ title, bodyHtml }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #111; color: #ddd; margin: 0; padding: 32px 16px; box-sizing: border-box; }
    .wrap { max-width: 640px; margin: 0 auto; }
    h1 { color: #25d366; font-size: 26px; margin: 0 0 4px; }
    h2 { color: #eee; font-size: 16px; margin: 28px 0 8px; }
    .sub { color: #999; font-size: 15px; margin: 0 0 24px; }
    p { line-height: 1.6; font-size: 14px; }
    ul { line-height: 1.6; font-size: 14px; }
    a { color: #4dabf7; }
    .footer { margin-top: 40px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="wrap">
    ${bodyHtml}
    <div class="footer"><a href="/">WhatsApp MCP</a> · <a href="/privacy">Política de Privacidade</a></div>
  </div>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(
    renderPublicLayout({
      title: 'WhatsApp MCP',
      bodyHtml: `
    <h1>WhatsApp MCP</h1>
    <p class="sub">Integração privada entre Google Drive e WhatsApp</p>
    <p>WhatsApp MCP é uma aplicação privada de automação que permite aos usuários autorizados localizar, ler e baixar
    documentos de suas próprias contas Google Drive e utilizá-los em fluxos autorizados de atendimento e
    comunicação via WhatsApp.</p>
    <p>O acesso ao Google Drive é concedido individualmente pelo próprio usuário através do OAuth do Google e é
    utilizado somente para executar ações solicitadas pelo usuário.</p>
    <p>O WhatsApp MCP não vende dados pessoais nem utiliza os arquivos do Google Drive para publicidade.</p>
    <h2>Permissões utilizadas</h2>
    <ul>
      <li><strong>Google Drive:</strong> acesso somente leitura para localizar, visualizar e baixar arquivos
      autorizados pelo usuário.</li>
      <li><strong>E-mail Google:</strong> utilizado apenas para identificar qual conta foi conectada.</li>
    </ul>
    <h2>Uso privado</h2>
    <p>Esta aplicação é destinada ao uso privado de usuários previamente autorizados.</p>
    <p><a href="/privacy">Política de Privacidade</a></p>`,
    })
  );
});

app.get('/privacy', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(
    renderPublicLayout({
      title: 'Política de Privacidade — WhatsApp MCP',
      bodyHtml: `
    <h1>Política de Privacidade</h1>
    <p class="sub">WhatsApp MCP</p>

    <h2>1. Sobre o aplicativo</h2>
    <p>WhatsApp MCP é uma aplicação privada que integra serviços como Google Drive e WhatsApp para executar tarefas
    solicitadas por usuários autorizados.</p>

    <h2>2. Dados Google acessados</h2>
    <p>O WhatsApp MCP pode acessar, mediante autorização expressa do usuário:</p>
    <ul>
      <li>endereço de e-mail da conta Google conectada;</li>
      <li>nomes e metadados de arquivos e pastas;</li>
      <li>conteúdo de arquivos do Google Drive;</li>
      <li>arquivos necessários para leitura, análise ou envio solicitado pelo usuário.</li>
    </ul>

    <h2>3. Finalidade</h2>
    <p>Os dados são utilizados exclusivamente para:</p>
    <ul>
      <li>localizar arquivos solicitados pelo usuário;</li>
      <li>ler documentos quando solicitado;</li>
      <li>baixar documentos autorizados;</li>
      <li>utilizar esses arquivos em fluxos iniciados pelo próprio usuário, como envio pelo WhatsApp.</li>
    </ul>
    <p>Os dados do Google não são utilizados para publicidade, não são vendidos, e o acesso é limitado ao
    estritamente necessário para executar a ação solicitada pelo usuário.</p>

    <h2>4. Acesso somente leitura</h2>
    <p>Atualmente o WhatsApp MCP solicita acesso somente leitura ao Google Drive e não altera, exclui ou modifica
    arquivos no Drive através dessa integração.</p>

    <h2>5. Armazenamento</h2>
    <p>Tokens OAuth necessários para manter a conexão são armazenados de forma protegida (criptografados em
    repouso) no servidor da aplicação e nunca são expostos a terceiros.</p>
    <p>Arquivos baixados do Google Drive para operações de envio são tratados temporariamente e removidos após a
    conclusão da operação ou após o período de expiração configurado.</p>

    <h2>6. Compartilhamento</h2>
    <p>O WhatsApp MCP não vende dados pessoais. Dados e arquivos somente são transmitidos a serviços ou destinatários
    quando isso for necessário para executar uma ação solicitada pelo usuário.</p>

    <h2>7. Segurança</h2>
    <p>A aplicação utiliza HTTPS, autenticação, isolamento de credenciais e controles de acesso para proteger
    dados e conexões.</p>

    <h2>8. Revogação</h2>
    <p>O usuário pode revogar o acesso do WhatsApp MCP à sua Conta Google a qualquer momento através das configurações
    de segurança da Conta Google ou através da própria aplicação.</p>

    <h2>9. Contato</h2>
    <p>${escapeHtml(PRIVACY_CONTACT_EMAIL)}</p>

    <h2>10. Atualizações</h2>
    <p>Esta política poderá ser atualizada conforme novas funcionalidades forem adicionadas ao WhatsApp MCP.</p>`,
    })
  );
});

// Login/senha errados demais vezes do mesmo IP = bloqueio temporário
// (proteção contra força bruta na tela de autorização).
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts', message: 'Muitas tentativas de login. Tente novamente em alguns minutos.' },
});

app.post('/authorize/approve', loginRateLimiter, async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, scope, resource, login, password } = req.body;
  const client = await oauthProvider.clientsStore.getClient(client_id);
  if (!client || !redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
    res.status(400).send('Requisição de autorização inválida.');
    return;
  }
  const identity = identityStore.findByLogin(String(login || '').trim().toLowerCase());
  const loginOk = identityStore.isUsable(identity) && verifySecret(password || '', identity.secret_hash);
  if (!loginOk) {
    auditLog({ action: 'login', ok: false, login, ip: req.ip });
    const html = renderLoginPage({
      clientName: client.client_name || client.client_id,
      hidden: { client_id, redirect_uri, state, code_challenge, scope, resource },
      loginValue: login,
      error: 'Usuário ou senha incorretos.',
    });
    res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(html);
    return;
  }
  auditLog({ action: 'login', ok: true, identityId: identity.id, label: identity.label, ip: req.ip });

  const code = randomUUID();
  oauthProvider.codes.set(code, {
    client,
    identityId: identity.id,
    params: {
      redirectUri: redirect_uri,
      state: state || undefined,
      codeChallenge: code_challenge,
      scopes: scope ? scope.split(' ').filter(Boolean) : [],
      resource: resource ? new URL(resource) : undefined,
    },
  });

  const target = new URL(redirect_uri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  res.redirect(target.toString());
});

// Rate limit por identidade (não por IP) - detectar/limitar abuso de uma
// credencial sem penalizar outras identidades atrás do mesmo IP/rede.
const mcpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.extra?.identityId || req.auth?.token || ipKeyGenerator(req.ip),
  message: { jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit excedido para esta identidade.' }, id: null },
});

app.post('/mcp', requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl }), mcpRateLimiter, async (req, res) => {
  auditLog({ action: 'mcp_request', identityId: req.auth?.extra?.identityId, label: req.auth?.extra?.label, ip: req.ip });
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] erro ao processar requisição:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', (req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Este servidor MCP é stateless (somente POST /mcp).' },
    id: null,
  });
});

app.delete('/mcp', (req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Este servidor MCP é stateless (somente POST /mcp).' },
    id: null,
  });
});

// Upload temporário via multipart/form-data - rota alternativa a
// upload_temp_file (content_base64) para quem consegue fazer uma requisição
// HTTP autenticada diretamente (ex: um agente com acesso a shell/HTTP, ou
// uma automação de outro sistema), sem precisar colocar o arquivo inteiro
// em base64 dentro de uma chamada MCP. NÃO é alcançável por um modelo que só
// tem as tools MCP - ver AGENTS.md para a análise de compatibilidade real.
const tempFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 } });
const tempFileUploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.extra?.identityId || ipKeyGenerator(req.ip),
  message: { success: false, error: 'rate_limited', message: 'Muitos uploads em pouco tempo.' },
});

app.post(
  '/api/temp-files',
  requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl }),
  tempFileUploadRateLimiter,
  tempFileUpload.single('file'),
  (req, res) => {
    const identityId = req.auth?.extra?.identityId;
    if (!req.auth?.scopes?.includes('whatsapp:file_upload')) {
      auditLog({ action: 'upload_temp_file_multipart', ok: false, reason: 'insufficient_scope', identityId, ip: req.ip });
      return res.status(403).json({ success: false, error: 'insufficient_scope', required_scope: 'whatsapp:file_upload' });
    }
    if (!featureEnabled('FEATURE_TEMP_FILE_UPLOAD')) {
      return res.status(403).json({ success: false, error: 'feature_disabled', feature: 'FEATURE_TEMP_FILE_UPLOAD' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'missing_file', message: 'Envie o arquivo no campo "file" (multipart/form-data).' });
    }
    const safeFilename = sanitizeFilename(req.body.filename || req.file.originalname);
    if (!safeFilename) {
      return res.status(400).json({ success: false, error: 'invalid_filename' });
    }
    const buffer = req.file.buffer;
    if (buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'empty_file' });
    }
    const mimetype = req.body.mimetype || mimetypeFromExtension(safeFilename) || req.file.mimetype || 'application/octet-stream';
    const tempFileId = `tmp_${randomUUID().replace(/-/g, '')}`;
    const hash = sha256Hex(buffer);
    fs.writeFileSync(tempFileStore.blobPath(tempFileId), buffer);
    const expiresAt = new Date(Date.now() + TEMP_FILE_TTL_MINUTES * 60 * 1000).toISOString();
    const entry = tempFileStore.put({
      temp_file_id: tempFileId,
      filename: safeFilename,
      mimetype,
      size: buffer.length,
      hash,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      status: 'uploaded',
      source: 'multipart',
    });
    auditLog({ action: 'upload_temp_file', ok: true, identityId, temp_file_id: tempFileId, mimetype, size: buffer.length, source: 'multipart' });
    log('[WHATSAPP-MCP][TEMP] upload ok (multipart)', tempFileId, mimetype, buffer.length, 'bytes');
    res.json({ success: true, instance_display_name: INSTANCE_DISPLAY_NAME, temp_file_id: entry.temp_file_id, filename: entry.filename, mimetype: entry.mimetype, size: entry.size, expires_at: entry.expires_at });
  }
);

// ---------------------------------------------------------------------------
// Página de upload no navegador (/upload) - pedido explícito porque enviar
// um arquivo de tamanho normal (ex: ~500KB) em base64 dentro de uma chamada
// MCP não é prático para nenhum cliente de chat (Claude/ChatGPT): o modelo
// teria que carregar ~1,37x o tamanho do arquivo como texto no próprio
// contexto. Esta página deixa o UPLOAD por fora do protocolo MCP - o
// usuário sobe o arquivo direto do celular/PC pelo navegador, e o Claude só
// entra depois, já com temp_file_id/batch_id em mãos (via list_temp_files/
// get_temp_batch).
//
// Autenticação: HTTP Basic, reaproveitando o MESMO login/senha da tela de
// autorização OAuth (identityStore + verifySecret) - sem sessão/cookie,
// sem token na URL. O navegador cacheia a credencial por origem depois do
// primeiro desafio 401, então a chamada fetch() da página para o endpoint
// de upload reaproveita a mesma credencial sem pedir de novo.
// Fábrica genérica - reaproveitada por /upload (whatsapp:file_upload) e
// /admin/drive (drive:read). Mesmo mecanismo: HTTP Basic contra
// identityStore + verifySecret, sem sessão/cookie, sem token na URL.
function requireIdentityBasicAuth(requiredScope, realm) {
  return function (req, res, next) {
    const challenge = () => res.set('WWW-Authenticate', `Basic realm="${realm}"`);
    const authHeader = req.headers.authorization || '';
    const match = /^Basic\s+(.+)$/.exec(authHeader);
    if (!match) {
      challenge();
      return res.status(401).send('Autenticação necessária.');
    }
    let login = '';
    let password = '';
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      login = decoded.slice(0, sep === -1 ? decoded.length : sep);
      password = sep === -1 ? '' : decoded.slice(sep + 1);
    } catch {
      challenge();
      return res.status(401).send('Autenticação inválida.');
    }
    const identity = identityStore.findByLogin(String(login || '').trim().toLowerCase());
    const loginOk = identityStore.isUsable(identity) && verifySecret(password || '', identity.secret_hash);
    if (!loginOk) {
      auditLog({ action: 'admin_page_login', ok: false, login, ip: req.ip });
      challenge();
      return res.status(401).send('Usuário ou senha incorretos.');
    }
    if (!identity.scopes.includes(requiredScope)) {
      auditLog({ action: 'admin_page_login', ok: false, reason: 'insufficient_scope', identityId: identity.id, ip: req.ip });
      return res.status(403).send(`Esta identidade não tem o escopo ${requiredScope} - peça para o admin rodar admin.js set-scopes.`);
    }
    req.authenticatedIdentity = identity;
    next();
  };
}
const requireUploadPageAuth = requireIdentityBasicAuth('whatsapp:file_upload', 'WhatsApp MCP Upload');

const uploadPageRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: 'Muitas tentativas. Tente novamente em alguns minutos.',
});

function renderUploadPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp MCP - ${escapeHtml(INSTANCE_DISPLAY_NAME)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
    .card { background: #1c1c1c; border-radius: 12px; padding: 28px; width: 100%; max-width: 420px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    h1 { font-size: 16px; letter-spacing: .04em; margin: 0 0 2px; color: #25d366; }
    h2 { font-size: 20px; margin: 0 0 4px; color: #eee; }
    p.sub { font-size: 13px; color: #999; margin: 0 0 20px; }
    label { display: block; font-size: 13px; color: #ccc; margin-bottom: 6px; }
    input[type=text] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #333; background: #0f0f0f; color: #eee; font-size: 15px; margin-bottom: 16px; }
    #dropzone { border: 2px dashed #444; border-radius: 10px; padding: 28px 16px; text-align: center; color: #999; margin-bottom: 14px; cursor: pointer; }
    #dropzone.drag { border-color: #25d366; color: #25d366; }
    button { width: 100%; padding: 11px; border-radius: 8px; border: none; background: #25d366; color: #063; font-weight: 600; font-size: 15px; cursor: pointer; margin-top: 4px; }
    button:disabled { background: #333; color: #777; cursor: not-allowed; }
    button.secondary { background: #333; color: #eee; margin-top: 10px; width: auto; padding: 8px 14px; font-size: 13px; }
    ul { list-style: none; padding: 0; margin: 10px 0; font-size: 14px; }
    li { padding: 4px 0; color: #ccc; }
    #status { margin-top: 16px; font-size: 14px; white-space: pre-wrap; }
    #status.ok { color: #25d366; }
    #status.err { color: #ff8a8a; }
  </style>
</head>
<body>
  <div class="card">
    <h1>WHATSAPP-MCP</h1>
    <h2>${escapeHtml(INSTANCE_DISPLAY_NAME)}</h2>
    <p class="sub">ENVIO TEMPORÁRIO — os arquivos enviados aqui ficarão disponíveis para o conector ${escapeHtml(INSTANCE_DISPLAY_NAME)}.</p>
    <label for="label">Referência (opcional)</label>
    <input id="label" type="text" placeholder="Ex: Renato Silva do Nascimento">
    <div id="dropzone">Arraste arquivos aqui<br>ou<br><button type="button" class="secondary" id="pickBtn">Selecionar arquivos</button>
      <input id="fileInput" type="file" multiple hidden>
    </div>
    <ul id="fileList"></ul>
    <button type="button" id="sendBtn" disabled>ENVIAR PARA ÁREA TEMPORÁRIA</button>
    <div id="status"></div>
  </div>
  <script>
    const INSTANCE_DISPLAY_NAME = ${JSON.stringify(INSTANCE_DISPLAY_NAME)};
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');
    const pickBtn = document.getElementById('pickBtn');
    const fileList = document.getElementById('fileList');
    const sendBtn = document.getElementById('sendBtn');
    const statusEl = document.getElementById('status');
    const labelInput = document.getElementById('label');
    let selected = [];

    function renderList() {
      fileList.innerHTML = '';
      for (const f of selected) {
        const li = document.createElement('li');
        li.textContent = '✓ ' + f.name + ' (' + Math.ceil(f.size / 1024) + ' KB)';
        fileList.appendChild(li);
      }
      sendBtn.disabled = selected.length === 0;
    }

    function addFiles(fileListObj) {
      selected = selected.concat(Array.from(fileListObj));
      renderList();
    }

    pickBtn.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('click', (e) => { if (e.target === dropzone) fileInput.click(); });
    fileInput.addEventListener('change', (e) => addFiles(e.target.files));
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      addFiles(e.dataTransfer.files);
    });

    sendBtn.addEventListener('click', async () => {
      if (!selected.length) return;
      sendBtn.disabled = true;
      statusEl.className = '';
      statusEl.textContent = 'Enviando...';
      const form = new FormData();
      if (labelInput.value.trim()) form.append('label', labelInput.value.trim());
      for (const f of selected) form.append('files', f, f.name);
      try {
        const resp = await fetch('/api/temp-files/batch', { method: 'POST', body: form, credentials: 'same-origin' });
        const data = await resp.json();
        if (resp.ok && data.success) {
          statusEl.className = 'ok';
          const lines = [
            'Upload concluído', '',
            'Instância:', INSTANCE_DISPLAY_NAME, '',
            'Referência:', data.label || '(sem referência)', '',
            'Batch ID:', data.batch_id, '',
            'Arquivos:', String(data.files.length), '',
            'Expiração:', new Date(data.expires_at).toLocaleString('pt-BR'),
          ];
          statusEl.textContent = lines.join('\\n');
          selected = [];
          renderList();
          fileInput.value = '';
        } else {
          statusEl.className = 'err';
          statusEl.textContent = 'Erro: ' + (data.message || data.error || resp.status);
        }
      } catch (err) {
        statusEl.className = 'err';
        statusEl.textContent = 'Erro de rede: ' + err.message;
      }
      sendBtn.disabled = selected.length === 0;
    });
  </script>
</body>
</html>`;
}

app.get('/upload', uploadPageRateLimiter, requireUploadPageAuth, (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(renderUploadPage());
});

const tempFileBatchUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 20 } });

app.post(
  '/api/temp-files/batch',
  uploadPageRateLimiter,
  requireUploadPageAuth,
  tempFileBatchUpload.array('files', 20),
  (req, res) => {
    if (!featureEnabled('FEATURE_TEMP_FILE_UPLOAD')) {
      return res.status(403).json({ success: false, error: 'feature_disabled', feature: 'FEATURE_TEMP_FILE_UPLOAD' });
    }
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ success: false, error: 'missing_files', message: 'Selecione ao menos um arquivo.' });
    }
    const label = (req.body.label || '').trim().slice(0, 200) || null;
    const batchId = `batch_${randomUUID().replace(/-/g, '')}`;
    const expiresAt = new Date(Date.now() + TEMP_FILE_TTL_MINUTES * 60 * 1000).toISOString();
    const results = [];
    files.forEach((file, index) => {
      const safeFilename = sanitizeFilename(file.originalname) || `arquivo_${index + 1}`;
      if (file.buffer.length === 0) {
        results.push({ success: false, filename: safeFilename, error: 'empty_file' });
        return;
      }
      const mimetype = mimetypeFromExtension(safeFilename) || file.mimetype || 'application/octet-stream';
      const tempFileId = `tmp_${randomUUID().replace(/-/g, '')}`;
      const hash = sha256Hex(file.buffer);
      fs.writeFileSync(tempFileStore.blobPath(tempFileId), file.buffer);
      const entry = tempFileStore.put({
        temp_file_id: tempFileId,
        filename: safeFilename,
        mimetype,
        size: file.buffer.length,
        hash,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        status: 'uploaded',
        source: 'browser_upload',
        batch_id: batchId,
        batch_order: index,
        label,
      });
      auditLog({ action: 'upload_temp_file', ok: true, identityId: req.authenticatedIdentity.id, temp_file_id: tempFileId, mimetype, size: file.buffer.length, source: 'browser_upload', batch_id: batchId });
      results.push({ success: true, temp_file_id: entry.temp_file_id, filename: entry.filename, mimetype: entry.mimetype, size: entry.size });
    });
    log('[WHATSAPP-MCP][TEMP] upload em lote (navegador)', batchId, files.length, 'arquivo(s), label=', label, 'identidade=', req.authenticatedIdentity.label);
    res.json({ success: true, instance_display_name: INSTANCE_DISPLAY_NAME, batch_id: batchId, label, expires_at: expiresAt, files: results });
  }
);

// Erros do multer (ex: arquivo acima de MAX_FILE_SIZE_BYTES) chegam aqui em
// vez de derrubar o processo - precisa ter 4 parâmetros para o Express
// reconhecer como error handler. Cobre as duas rotas de upload acima.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ success: false, error: 'file_too_large', message: err.message });
  }
  next(err);
});

// ---------------------------------------------------------------------------
// Administração de conexões Google Drive (/admin/drive) - mesmo padrão de
// autenticação de /upload (HTTP Basic contra identityStore), escopo
// drive:read. OAuth PRÓPRIO do WhatsApp MCP com o Google - nunca usa/depende da
// conexão Google do Claude/ChatGPT (são sistemas completamente
// independentes - ver AGENTS.md).
// ---------------------------------------------------------------------------
const requireDriveAdminAuth = requireIdentityBasicAuth('drive:read', 'WhatsApp MCP Drive Admin');
const driveAdminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: 'Muitas tentativas. Tente novamente em alguns minutos.',
});

function renderDrivePage({ identity, connections, oauthConfigured, flash }) {
  const rows = connections.length
    ? connections
        .map((c) => {
          const pub = publicConnectionFields(c);
          return `<div class="conn">
      <div class="conn-name">${escapeHtml(pub.display_name)}${pub.is_default ? ' <span class="badge">padrão</span>' : ''}</div>
      <div class="conn-meta">Status: ${escapeHtml(pub.status === 'connected' ? 'Conectado' : pub.status === 'error' ? 'Erro (reconecte)' : 'Revogado')} · Conta: ${escapeHtml(pub.account_masked || '?')} · Escopo: somente leitura</div>
      <div class="conn-actions">
        <form method="POST" action="/admin/drive/revoke" onsubmit="return confirm('Revogar esta conexão?');">
          <input type="hidden" name="connection_id" value="${escapeHtml(pub.connection_id)}">
          <button type="submit" class="secondary danger">Revogar</button>
        </form>
        ${!pub.is_default ? `<form method="POST" action="/admin/drive/set-default">
          <input type="hidden" name="connection_id" value="${escapeHtml(pub.connection_id)}">
          <button type="submit" class="secondary">Tornar padrão</button>
        </form>` : ''}
      </div>
    </div>`;
        })
        .join('\n')
    : '<p class="sub">Nenhuma conexão ainda.</p>';

  const connectForm = oauthConfigured
    ? `<form method="GET" action="/admin/drive/connect" class="connect-form">
      <label for="display_name">Nome para esta conexão</label>
      <input type="text" id="display_name" name="display_name" placeholder="Ex.: Meu Drive" required>
      <button type="submit">Conectar outro Drive</button>
    </form>`
    : `<p class="sub">OAuth do Google ainda não configurado nesta instância (faltando no .env: ${escapeHtml(driveOAuthMissingVars().join(', '))}).</p>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp MCP - Google Drive</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
    .card { background: #1c1c1c; border-radius: 12px; padding: 28px; width: 100%; max-width: 460px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    h1 { font-size: 16px; letter-spacing: .04em; margin: 0 0 2px; color: #4285F4; }
    h2 { font-size: 18px; margin: 0 0 16px; color: #eee; }
    p.sub { font-size: 13px; color: #999; margin: 8px 0; }
    .flash { background: #14301d; color: #8fe0a8; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
    .flash.err { background: #3a1414; color: #ff8a8a; }
    .conn { border: 1px solid #333; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
    .conn-name { font-weight: 600; margin-bottom: 4px; }
    .badge { font-size: 11px; background: #25d366; color: #063; padding: 1px 6px; border-radius: 4px; }
    .conn-meta { font-size: 12px; color: #999; margin-bottom: 8px; }
    .conn-actions { display: flex; gap: 8px; }
    .conn-actions form { margin: 0; }
    label { display: block; font-size: 13px; color: #ccc; margin: 16px 0 6px; }
    input[type=text] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #333; background: #0f0f0f; color: #eee; font-size: 15px; }
    button { padding: 10px 14px; border-radius: 8px; border: none; background: #4285F4; color: #fff; font-weight: 600; font-size: 14px; cursor: pointer; }
    button.secondary { background: #333; color: #eee; font-size: 12px; padding: 7px 10px; }
    button.danger:hover { background: #5a2020; }
    .connect-form button { width: 100%; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>GOOGLE DRIVE</h1>
    <h2>${escapeHtml(INSTANCE_DISPLAY_NAME)}</h2>
    ${flash ? `<div class="flash${flash.err ? ' err' : ''}">${escapeHtml(flash.message)}</div>` : ''}
    ${rows}
    ${connectForm}
  </div>
</body>
</html>`;
}

app.get('/admin/drive', driveAdminRateLimiter, requireDriveAdminAuth, (req, res) => {
  const flashMessage = req.query.msg ? { message: String(req.query.msg), err: req.query.err === '1' } : null;
  res.set('Content-Type', 'text/html; charset=utf-8').send(
    renderDrivePage({
      identity: req.authenticatedIdentity,
      connections: driveConnectionStore.list(),
      oauthConfigured: driveOAuthConfigured(),
      flash: flashMessage,
    })
  );
});

app.get('/admin/drive/connect', driveAdminRateLimiter, requireDriveAdminAuth, (req, res) => {
  if (!driveOAuthConfigured()) {
    return res.redirect('/admin/drive?err=1&msg=' + encodeURIComponent('OAuth do Google não configurado.'));
  }
  const displayName = String(req.query.display_name || '').trim().slice(0, 100);
  if (!displayName) {
    return res.redirect('/admin/drive?err=1&msg=' + encodeURIComponent('Informe um nome para a conexão.'));
  }
  cleanupDriveOAuthStates();
  const state = randomUUID();
  driveOAuthStates.set(state, { displayName, createdAt: Date.now() });
  const url = buildGoogleAuthUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri: DRIVE_OAUTH_REDIRECT_URI, state });
  auditLog({ action: 'drive_connect_start', identityId: req.authenticatedIdentity.id, ip: req.ip });
  res.redirect(url);
});

app.get('/oauth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect('/admin/drive?err=1&msg=' + encodeURIComponent(`Google recusou a autorização: ${error}`));
  }
  const stateData = state && driveOAuthStates.get(state);
  if (!stateData) {
    return res.redirect('/admin/drive?err=1&msg=' + encodeURIComponent('Sessão de autorização expirada ou inválida - tente conectar de novo.'));
  }
  driveOAuthStates.delete(state);
  if (!driveOAuthConfigured()) {
    return res.redirect('/admin/drive?err=1&msg=' + encodeURIComponent('OAuth do Google não configurado.'));
  }
  try {
    const tokens = await exchangeCodeForTokens({ code, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, redirectUri: DRIVE_OAUTH_REDIRECT_URI });
    const email = await fetchGoogleUserEmail(tokens.access_token);
    const connectionId = `drive_${stateData.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}_${randomUUID().slice(0, 8)}`;
    driveConnectionStore.create({
      connection_id: connectionId,
      display_name: stateData.displayName,
      google_account_email: email,
      instance_id: INSTANCE_NAME,
      access_mode: 'read',
      scopes: (tokens.scope || DRIVE_READONLY_SCOPE).split(' '),
      encrypted_refresh_token: encryptToken(tokens.refresh_token, DRIVE_TOKEN_ENCRYPTION_KEY),
    });
    auditLog({ action: 'drive_connect_success', connection_id: connectionId, account_masked: maskEmail(email) });
    log('[WHATSAPP-MCP][DRIVE] conexão criada', connectionId, maskEmail(email));
    res.redirect('/admin/drive?msg=' + encodeURIComponent(`Conectado: ${stateData.displayName} (${maskEmail(email)})`));
  } catch (err) {
    console.error('[oauth/google/callback] erro detalhado:', err);
    auditLog({ action: 'drive_connect_failed', error: err.message });
    res.redirect('/admin/drive?err=1&msg=' + encodeURIComponent(`Falha ao conectar: ${err.message}`));
  }
});

app.post('/admin/drive/revoke', driveAdminRateLimiter, requireDriveAdminAuth, async (req, res) => {
  const { connection_id } = req.body;
  const conn = driveConnectionStore.get(connection_id);
  if (!conn) return res.redirect('/admin/drive?err=1&msg=' + encodeURIComponent('Conexão não encontrada.'));
  try {
    if (conn.encrypted_refresh_token) {
      const refreshToken = decryptToken(conn.encrypted_refresh_token, DRIVE_TOKEN_ENCRYPTION_KEY);
      await revokeGoogleToken(refreshToken);
    }
  } catch {
    // best-effort - revoga localmente mesmo se a chamada ao Google falhar
  }
  driveConnectionStore.revoke(connection_id);
  auditLog({ action: 'drive_revoke', identityId: req.authenticatedIdentity.id, connection_id });
  res.redirect('/admin/drive?msg=' + encodeURIComponent('Conexão revogada.'));
});

app.post('/admin/drive/set-default', driveAdminRateLimiter, requireDriveAdminAuth, (req, res) => {
  const { connection_id } = req.body;
  try {
    driveConnectionStore.setDefault(connection_id);
    auditLog({ action: 'drive_set_default', identityId: req.authenticatedIdentity.id, connection_id });
    res.redirect('/admin/drive?msg=' + encodeURIComponent('Conexão padrão atualizada.'));
  } catch (err) {
    res.redirect('/admin/drive?err=1&msg=' + encodeURIComponent(err.message));
  }
});

app.get('/media/:id', requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl }), (req, res) => {
  const identityId = req.auth?.extra?.identityId;
  if (!req.auth?.scopes?.includes('whatsapp:media')) {
    auditLog({ action: 'media_download', ok: false, reason: 'insufficient_scope', identityId, ip: req.ip });
    res.status(403).json({ error: 'insufficient_scope', message: 'Requer escopo whatsapp:media.' });
    return;
  }
  const entry = mediaRegistry.get(req.params.id);
  if (!entry) {
    res.status(404).json({ error: 'not_found', message: 'Arquivo não encontrado (link expirado ou servidor reiniciou).' });
    return;
  }
  if (entry.ownerIdentityId && entry.ownerIdentityId !== identityId) {
    auditLog({ action: 'media_download', ok: false, reason: 'not_owner', identityId, mediaId: req.params.id, ip: req.ip });
    res.status(403).json({ error: 'forbidden', message: 'Este arquivo foi gerado por outra identidade.' });
    return;
  }
  auditLog({ action: 'media_download', ok: true, identityId, mediaId: req.params.id, ip: req.ip });
  res.set('Content-Type', entry.mimetype || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${entry.filename.replace(/"/g, '')}"`);
  res.sendFile(path.join(MEDIA_DIR, entry.storedFilename));
});

// Health check público mínimo - não revela número, contatos, sessão ou
// qualquer dado interno por padrão. Com um Bearer válido (qualquer escopo),
// devolve detalhe extra (whatsapp_ready) para administração/debug.
registerSessionRoutes(app,{
  session:whatsappSession,instance:INSTANCE_NAME,displayName:INSTANCE_DISPLAY_NAME,audit:auditLog,
  authorize:requireBearerAuth({verifier:oauthProvider,requiredScopes:['whatsapp:session'],resourceMetadataUrl}),
  limiter:rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-8',legacyHeaders:false}),
});

app.get('/health', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      await oauthProvider.verifyAccessToken(token);
      res.json({
        status: 'ok',
        whatsapp_ready: whatsappSession.isReady(),
        instance: INSTANCE_NAME,
        instance_display_name: INSTANCE_DISPLAY_NAME,
        version: WHATSAPP_MCP_VERSION,
        transcription: transcriptionConfigSummary(),
      });
      return;
    } catch {
      // token inválido - cai para a resposta pública mínima abaixo
    }
  }
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor MCP WhatsApp ouvindo na porta ${PORT}`);
});

process.on('SIGTERM', async () => {
  whatsappSession.stopped=true;
  clearInterval(readyPoll);
  try {
    await waClient.destroy();
  } catch {
    // ignora - saindo de qualquer forma
  }
  process.exit(0);
});
