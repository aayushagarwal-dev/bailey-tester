import cors from 'cors';
import express from 'express';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = path.join(rootDir, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const statePath = path.join(dataDir, 'state.json');
const port = Number(process.env.PORT ?? 5055);

mkdirSync(uploadDir, { recursive: true });

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      mkdirSync(uploadDir, { recursive: true });
      callback(null, uploadDir);
    },
    filename: (_req, file, callback) => {
      callback(null, `${Date.now()}-${randomUUID()}-${sanitizeFileName(file.originalname)}`);
    }
  }),
  limits: {
    files: 10,
    fileSize: 25 * 1024 * 1024
  }
});

const defaultState = {
  config: {
    projectName: 'Local Baileys App',
    deliveryMode: 'generic',
    webhookUrl: '',
    bearerToken: '',
    webhookSecret: '',
    testerBaseUrl: 'http://localhost:5055'
  },
  chats: [],
  messages: [],
  events: []
};

let state = await loadState();
let saveTimer = null;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadDir));
app.use(express.static(publicDir));

io.on('connection', (socket) => {
  socket.emit('state', getClientState());
});

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      ok: true,
      app: 'bailey-tester',
      port,
      chats: state.chats.length,
      messages: state.messages.length
    }
  });
});

app.get('/api/state', (_req, res) => {
  res.json({
    success: true,
    data: getClientState()
  });
});

app.put('/api/config', (req, res) => {
  const nextConfig = {
    ...state.config,
    projectName: stringOr(req.body.projectName, state.config.projectName),
    deliveryMode: ['generic'].includes(req.body.deliveryMode)
      ? req.body.deliveryMode
      : state.config.deliveryMode,
    webhookUrl: stringOr(req.body.webhookUrl, state.config.webhookUrl),
    bearerToken:
      req.body.bearerToken === '__KEEP__'
        ? state.config.bearerToken
        : stringOr(req.body.bearerToken, ''),
    webhookSecret:
      req.body.webhookSecret === '__KEEP__'
        ? state.config.webhookSecret
        : stringOr(req.body.webhookSecret, ''),
    testerBaseUrl: stringOr(req.body.testerBaseUrl, state.config.testerBaseUrl)
  };

  state.config = nextConfig;
  addEvent('config.updated', 'info', {
    deliveryMode: state.config.deliveryMode,
    webhookUrl: redactUrl(state.config.webhookUrl),
    hasBearerToken: Boolean(state.config.bearerToken),
    hasWebhookSecret: Boolean(state.config.webhookSecret)
  });
  touchState();
  res.json({
    success: true,
    data: getClientState()
  });
});

app.get('/api/chats', (req, res) => {
  const query = String(req.query.query ?? '').trim().toLowerCase();
  const chats = sortChats(state.chats).filter((chat) => {
    if (!query) {
      return true;
    }

    return [
      chat.phone,
      chat.jid,
      chat.name,
      ...(chat.tags ?? [])
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  res.json({
    success: true,
    data: chats.map(enrichChat)
  });
});

app.post('/api/chats', (req, res) => {
  const phone = normalizePhone(req.body.phone ?? req.body.jid);
  const jid = normalizeJid(req.body.jid ?? phone);

  if (!jid) {
    res.status(400).json({
      success: false,
      error: { message: 'Phone or jid is required.' }
    });
    return;
  }

  const chat = findOrCreateChat({
    phone,
    jid,
    name: String(req.body.name ?? '').trim() || undefined,
    tags: parseTags(req.body.tags)
  });

  touchState();
  res.json({
    success: true,
    data: enrichChat(chat)
  });
});

app.patch('/api/chats/:id', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    sendNotFound(res, 'Chat not found.');
    return;
  }

  if (req.body.name !== undefined) {
    chat.name = stringOr(req.body.name, chat.name);
  }

  if (req.body.tags !== undefined) {
    chat.tags = parseTags(req.body.tags);
  }

  if (req.body.notes !== undefined) {
    chat.notes = stringOr(req.body.notes, '');
  }

  chat.updatedAt = nowIso();
  touchState();
  res.json({
    success: true,
    data: enrichChat(chat)
  });
});

app.get('/api/chats/:id/messages', (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    sendNotFound(res, 'Chat not found.');
    return;
  }

  res.json({
    success: true,
    data: getChatMessages(chat.id)
  });
});

app.post('/api/chats/:id/send-to-app', upload.array('media', 10), async (req, res) => {
  const chat = getChat(req.params.id);
  if (!chat) {
    sendNotFound(res, 'Chat not found.');
    return;
  }

  const tags = mergeTags(chat.tags, parseTags(req.body.tags));
  const media = filesToMedia(req, req.files ?? []);
  const text = stringOr(req.body.text, '').trim();

  if (!text && media.length === 0) {
    res.status(400).json({
      success: false,
      error: { message: 'Message text or media is required.' }
    });
    return;
  }

  const message = appendMessage({
    chat,
    direction: 'inbound',
    source: 'tester',
    senderLabel: chat.name || chat.phone,
    text,
    tags,
    media,
    messageType: inferMessageType(text, media),
    metadata: {
      testRunId: stringOr(req.body.testRunId, ''),
      note: stringOr(req.body.note, ''),
      route: 'tester_to_app'
    },
    status: 'queued'
  });

  const delivery = await deliverInboundToApp(chat, message);
  message.status = delivery.ok ? 'delivered' : delivery.skipped ? 'local-only' : 'failed';
  message.delivery = delivery;
  chat.lastDeliveryStatus = message.status;

  addEvent('message.inbound', delivery.ok ? 'info' : delivery.skipped ? 'warn' : 'error', {
    chatId: chat.id,
    jid: chat.jid,
    messageId: message.id,
    status: message.status,
    webhookStatus: delivery.status ?? null,
    error: delivery.error ?? null
  });

  touchState();
  res.json({
    success: true,
    data: {
      chat: enrichChat(chat),
      message
    }
  });
});

app.post('/api/app/outbound', upload.array('media', 10), (req, res) => {
  const input = req.body ?? {};
  const jid = normalizeJid(input.jid ?? input.to ?? input.phone);
  const phone = normalizePhone(input.phone ?? input.to ?? input.jid);

  if (!jid && !phone) {
    res.status(400).json({
      success: false,
      error: { message: 'Outbound message needs jid, to, or phone.' }
    });
    return;
  }

  const chat = findOrCreateChat({
    phone,
    jid: jid || normalizeJid(phone),
    name: String(input.name ?? '').trim() || undefined,
    tags: parseTags(input.chatTags)
  });
  const media = [
    ...filesToMedia(req, req.files ?? []),
    ...parseJsonArray(input.media).map(normalizeExternalMedia).filter(Boolean)
  ];
  const tags = parseTags(input.tags);
  const text = stringOr(input.text ?? input.caption, '').trim();

  const message = appendMessage({
    chat,
    direction: 'outbound',
    source: 'app',
    senderLabel: stringOr(input.senderLabel, state.config.projectName),
    text,
    tags,
    media,
    messageType: stringOr(input.messageType, inferMessageType(text, media)),
    metadata: parseJsonObject(input.metadata),
    status: 'received'
  });

  message.providerMessageId = stringOr(
    input.providerMessageId ?? input.messageId,
    message.id
  );

  addEvent('message.outbound', 'info', {
    chatId: chat.id,
    jid: chat.jid,
    messageId: message.id,
    providerMessageId: message.providerMessageId
  });

  touchState();
  res.json({
    success: true,
    data: {
      key: {
        remoteJid: chat.jid,
        fromMe: true,
        id: message.providerMessageId
      },
      message,
      chat: enrichChat(chat)
    }
  });
});

app.post('/api/app/events', (req, res) => {
  const event = addEvent(
    stringOr(req.body.type ?? req.body.event, 'app.event'),
    ['info', 'warn', 'error'].includes(req.body.level) ? req.body.level : 'info',
    parseJsonObject(req.body.payload ?? req.body)
  );
  touchState();
  res.json({
    success: true,
    data: event
  });
});

app.post('/api/reset', (req, res) => {
  const keepConfig = req.body?.keepConfig !== false;
  state = {
    ...defaultState,
    config: keepConfig ? state.config : { ...defaultState.config },
    chats: [],
    messages: [],
    events: []
  };
  addEvent('state.reset', 'warn', { keepConfig });
  touchState();
  res.json({
    success: true,
    data: getClientState()
  });
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

httpServer.listen(port, () => {
  console.log(`Bailey Tester running at http://localhost:${port}`);
});

async function loadState() {
  if (!existsSync(statePath)) {
    return structuredClone(defaultState);
  }

  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(defaultState),
      ...parsed,
      config: {
        ...defaultState.config,
        ...(parsed.config ?? {})
      },
      chats: Array.isArray(parsed.chats) ? parsed.chats : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      events: Array.isArray(parsed.events) ? parsed.events : []
    };
  } catch (error) {
    console.warn(`Could not load state.json, starting fresh: ${error.message}`);
    return structuredClone(defaultState);
  }
}

function touchState() {
  emitState();
  scheduleSave();
}

function emitState() {
  io.emit('state', getClientState());
}

function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveState();
  }, 150);
}

async function saveState() {
  mkdirSync(dataDir, { recursive: true });
  const tempPath = `${statePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
  await rename(tempPath, statePath);
}

function getClientState() {
  return {
    config: {
      ...state.config,
      bearerToken: state.config.bearerToken ? '__SET__' : '',
      webhookSecret: state.config.webhookSecret ? '__SET__' : ''
    },
    chats: sortChats(state.chats).map(enrichChat),
    messages: state.messages,
    events: state.events.slice(-120).reverse()
  };
}

function findOrCreateChat(input) {
  const jid = normalizeJid(input.jid ?? input.phone);
  const phone = normalizePhone(input.phone ?? jid);
  let chat = state.chats.find(
    (item) => item.jid === jid || (phone && item.phone === phone)
  );

  if (!chat) {
    chat = {
      id: `bt_chat_${randomUUID()}`,
      jid,
      phone,
      name: input.name || phone || jid,
      tags: parseTags(input.tags),
      notes: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastMessageAt: null,
      lastDeliveryStatus: null
    };
    state.chats.push(chat);
    addEvent('chat.created', 'info', { chatId: chat.id, jid: chat.jid });
  } else {
    chat.name = input.name || chat.name;
    chat.tags = mergeTags(chat.tags, parseTags(input.tags));
    chat.updatedAt = nowIso();
  }

  return chat;
}

function getChat(id) {
  return state.chats.find((chat) => chat.id === id);
}

function enrichChat(chat) {
  const messages = getChatMessages(chat.id);
  const lastMessage = messages.at(-1) ?? null;
  return {
    ...chat,
    messageCount: messages.length,
    lastMessage
  };
}

function sortChats(chats) {
  return [...chats].sort((a, b) => {
    const left = new Date(a.lastMessageAt ?? a.updatedAt ?? a.createdAt).getTime();
    const right = new Date(b.lastMessageAt ?? b.updatedAt ?? b.createdAt).getTime();
    return right - left;
  });
}

function getChatMessages(chatId) {
  return state.messages
    .filter((message) => message.chatId === chatId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function appendMessage(input) {
  const createdAt = nowIso();
  const message = {
    id: `bt_msg_${randomUUID()}`,
    chatId: input.chat.id,
    jid: input.chat.jid,
    direction: input.direction,
    source: input.source,
    senderLabel: input.senderLabel,
    text: input.text,
    messageType: input.messageType,
    tags: parseTags(input.tags),
    media: input.media ?? [],
    metadata: input.metadata ?? {},
    status: input.status ?? 'created',
    createdAt,
    delivery: null
  };

  state.messages.push(message);
  input.chat.lastMessageAt = createdAt;
  input.chat.updatedAt = createdAt;
  return message;
}

async function deliverInboundToApp(chat, message) {
  if (!state.config.webhookUrl) {
    return {
      ok: false,
      skipped: true,
      error: 'No webhook URL configured.'
    };
  }

  const body = buildGenericBaileysPayload(chat, message);

  const headers = {
    'Content-Type': 'application/json',
    'X-Bailey-Tester': 'true'
  };

  if (state.config.bearerToken) {
    headers.Authorization = `Bearer ${state.config.bearerToken}`;
  }

  if (state.config.webhookSecret) {
    headers['X-Bailey-Tester-Secret'] = state.config.webhookSecret;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(state.config.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const responseText = await response.text();

    return {
      ok: response.ok,
      skipped: false,
      status: response.status,
      response: safeSlice(responseText, 1600),
      deliveredAt: nowIso(),
      payload: body
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error.name === 'AbortError' ? 'Webhook request timed out.' : error.message,
      deliveredAt: nowIso(),
      payload: body
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildGenericBaileysPayload(chat, message) {
  const media = message.media ?? [];
  return {
    event: 'messages.upsert',
    source: 'bailey-tester',
    chat: {
      id: chat.id,
      jid: chat.jid,
      phone: chat.phone,
      name: chat.name,
      tags: chat.tags
    },
    messages: [
      {
        key: {
          remoteJid: chat.jid,
          fromMe: false,
          id: message.id
        },
        message: toBaileysMessage(message),
        messageTimestamp: Math.floor(new Date(message.createdAt).getTime() / 1000),
        pushName: chat.name,
        tester: {
          messageId: message.id,
          tags: message.tags,
          metadata: message.metadata,
          media
        }
      }
    ]
  };
}

function toBaileysMessage(message) {
  if ((message.media ?? []).length > 0) {
    const first = message.media[0];
    const base = {
      mimetype: first.mimeType,
      fileName: first.fileName,
      caption: message.text || undefined,
      url: first.url
    };

    if (first.mimeType?.startsWith('image/')) {
      return { imageMessage: base };
    }

    if (first.mimeType?.startsWith('video/')) {
      return { videoMessage: base };
    }

    if (first.mimeType?.startsWith('audio/')) {
      return { audioMessage: base };
    }

    return { documentMessage: base };
  }

  return {
    conversation: message.text
  };
}

function filesToMedia(req, files) {
  return files.map((file) => ({
    id: `bt_media_${randomUUID()}`,
    fileName: file.originalname,
    storedName: file.filename,
    mimeType: file.mimetype,
    size: file.size,
    url: `${resolveBaseUrl(req)}/uploads/${encodeURIComponent(file.filename)}`
  }));
}

function normalizeExternalMedia(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return {
    id: stringOr(value.id, `bt_media_${randomUUID()}`),
    fileName: stringOr(value.fileName ?? value.name, 'external-media'),
    mimeType: stringOr(value.mimeType ?? value.mimetype, 'application/octet-stream'),
    size: Number(value.size ?? 0),
    url: stringOr(value.url ?? value.path, '')
  };
}

function resolveBaseUrl(req) {
  return (
    state.config.testerBaseUrl ||
    `${req.protocol}://${req.get('host')}` ||
    `http://localhost:${port}`
  ).replace(/\/$/, '');
}

function addEvent(type, level, payload) {
  const event = {
    id: `bt_evt_${randomUUID()}`,
    type,
    level,
    payload,
    createdAt: nowIso()
  };
  state.events.push(event);
  if (state.events.length > 500) {
    state.events = state.events.slice(-500);
  }
  return event;
}

function inferMessageType(text, media) {
  const first = media?.[0];
  if (!first) {
    return text ? 'text' : 'unknown';
  }

  if (first.mimeType?.startsWith('image/')) {
    return 'image';
  }

  if (first.mimeType?.startsWith('video/')) {
    return 'video';
  }

  if (first.mimeType?.startsWith('audio/')) {
    return 'audio';
  }

  return 'document';
}

function normalizePhone(value) {
  const raw = String(value ?? '').trim();
  const withoutDomain = raw.split('@')[0] ?? raw;
  return withoutDomain.replace(/\D+/g, '');
}

function normalizeJid(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }

  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@g.us')) {
    return raw;
  }

  const phone = normalizePhone(raw);
  return phone ? `${phone}@s.whatsapp.net` : '';
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return uniqueClean(value);
  }

  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    try {
      return uniqueClean(JSON.parse(trimmed));
    } catch {
      return uniqueClean(trimmed.split(','));
    }
  }

  return uniqueClean(trimmed.split(/[,\n]/));
}

function mergeTags(...sets) {
  return uniqueClean(sets.flatMap((set) => parseTags(set)));
}

function uniqueClean(values) {
  return [...new Set(
    values
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
  )];
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {
      raw: value
    };
  }
}

function stringOr(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value);
}

function sanitizeFileName(value) {
  const cleaned = String(value ?? 'upload.bin')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'upload.bin';
}

function redactUrl(value) {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function safeSlice(value, length) {
  return String(value ?? '').slice(0, length);
}

function nowIso() {
  return new Date().toISOString();
}

function sendNotFound(res, message) {
  res.status(404).json({
    success: false,
    error: { message }
  });
}
