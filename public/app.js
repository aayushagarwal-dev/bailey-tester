const socket = window.io();

const app = document.querySelector('#app');
const state = {
  config: {},
  chats: [],
  messages: [],
  events: []
};

const ui = {
  selectedChatId: null,
  search: '',
  status: 'Loading tester...',
  statusTone: 'neutral',
  busy: false,
  drafts: {
    newPhone: '',
    newName: '',
    newTags: 'manual-test',
    bulkContacts: '',
    messageText: '',
    messageTags: 'manual-test',
    messageNote: '',
    testRunId: `manual-${new Date().toISOString().slice(0, 10)}`,
    chatName: '',
    chatTags: '',
    chatNotes: ''
  }
};

socket.on('state', (nextState) => {
  replaceState(nextState);
  render();
});

loadState();

async function loadState() {
  try {
    const nextState = await api('/api/state');
    replaceState(nextState);
    setStatus('Ready', 'success');
  } catch (error) {
    setStatus(error.message, 'danger');
  } finally {
    render();
  }
}

function replaceState(nextState) {
  state.config = nextState.config ?? {};
  state.chats = nextState.chats ?? [];
  state.messages = nextState.messages ?? [];
  state.events = nextState.events ?? [];

  if (!ui.selectedChatId && state.chats.length > 0) {
    ui.selectedChatId = state.chats[0].id;
    primeChatDraft(getSelectedChat());
  }

  if (ui.selectedChatId && !state.chats.some((chat) => chat.id === ui.selectedChatId)) {
    ui.selectedChatId = state.chats[0]?.id ?? null;
    primeChatDraft(getSelectedChat());
  }
}

function render() {
  const selectedChat = getSelectedChat();
  const filteredChats = getFilteredChats();

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Local WhatsApp simulator</p>
          <h1>Bailey Tester</h1>
        </div>
        <div class="topbar-actions">
          <span class="pill ${ui.statusTone}">${escapeHtml(ui.status)}</span>
          <span class="pill">${escapeHtml(state.config.projectName || 'No app linked')}</span>
          <button class="icon-button" data-action="refresh" title="Refresh state">Refresh</button>
        </div>
      </header>

      <div class="workspace">
        <aside class="sidebar">
          ${renderSidebar(filteredChats)}
        </aside>

        <main class="chat-panel">
          ${selectedChat ? renderChat(selectedChat) : renderEmptyChat()}
        </main>

        <aside class="inspector">
          ${renderInspector(selectedChat)}
        </aside>
      </div>
    </div>
  `;

  bindEvents();
  scrollMessagesToBottom();
}

function renderSidebar(chats) {
  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Inbox</p>
          <h2>Test numbers</h2>
        </div>
        <span class="count">${state.chats.length}</span>
      </div>

      <input
        id="chat-search"
        class="input"
        value="${escapeAttribute(ui.search)}"
        placeholder="Search phone, name, or tag"
      />
    </section>

    <section class="panel-section compact">
      <form id="new-chat-form" class="stack">
        <label>
          <span>Phone or JID</span>
          <input class="input" name="phone" value="${escapeAttribute(ui.drafts.newPhone)}" placeholder="919999999999" />
        </label>
        <label>
          <span>Name</span>
          <input class="input" name="name" value="${escapeAttribute(ui.drafts.newName)}" placeholder="Test Customer" />
        </label>
        <label>
          <span>Chat tags</span>
          <input class="input" name="tags" value="${escapeAttribute(ui.drafts.newTags)}" placeholder="manual-test, pricing" />
        </label>
        <button class="primary-button" type="submit">Add number</button>
      </form>
    </section>

    <section class="panel-section compact">
      <div class="section-heading small">
        <h3>Import contacts</h3>
      </div>
      <p class="helper">Use .txt with one phone per line, or CSV: phone,name,tags.</p>
      <input id="contacts-file" class="file-input" type="file" accept=".txt,.csv,text/plain,text/csv" />
      <textarea id="bulk-contacts" class="textarea small" placeholder="919999999999, Ravi, pricing">${escapeHtml(ui.drafts.bulkContacts)}</textarea>
      <button class="secondary-button" data-action="import-contacts">Import contacts</button>
    </section>

    <section class="chat-list">
      ${chats.length ? chats.map(renderChatListItem).join('') : '<div class="empty-small">No chats yet. Add or import a number.</div>'}
    </section>
  `;
}

function renderChatListItem(chat) {
  const active = chat.id === ui.selectedChatId ? 'active' : '';
  const last = chat.lastMessage;
  const preview = last?.text || last?.media?.[0]?.fileName || 'No messages yet';
  return `
    <button class="chat-item ${active}" data-chat-id="${chat.id}">
      <div class="avatar">${escapeHtml(initials(chat.name || chat.phone))}</div>
      <div class="chat-item-main">
        <div class="chat-item-row">
          <strong>${escapeHtml(chat.name || chat.phone || chat.jid)}</strong>
          <time>${last ? formatShortTime(last.createdAt) : ''}</time>
        </div>
        <p>${escapeHtml(preview)}</p>
        <div class="tag-row">${renderTags(chat.tags)}</div>
      </div>
    </button>
  `;
}

function renderChat(chat) {
  const messages = getMessagesForChat(chat.id);

  return `
    <div class="chat-header">
      <div class="avatar large">${escapeHtml(initials(chat.name || chat.phone))}</div>
      <div>
        <h2>${escapeHtml(chat.name || chat.phone || chat.jid)}</h2>
        <p>${escapeHtml(chat.jid)} · ${messages.length} messages</p>
      </div>
    </div>

    <div id="message-stream" class="message-stream">
      ${messages.length ? messages.map(renderMessage).join('') : renderChatPrimer(chat)}
    </div>

    <form id="composer-form" class="composer">
      <div class="composer-meta">
        <label>
          <span>From test number</span>
          <input class="input" value="${escapeAttribute(chat.phone || chat.jid)}" disabled />
        </label>
        <label>
          <span>Message tags</span>
          <input class="input" name="tags" value="${escapeAttribute(ui.drafts.messageTags)}" placeholder="manual-test, pricing" />
        </label>
        <label>
          <span>Test run</span>
          <input class="input" name="testRunId" value="${escapeAttribute(ui.drafts.testRunId)}" placeholder="manual-001" />
        </label>
      </div>

      <textarea
        class="textarea composer-text"
        name="text"
        placeholder="Type an inbound WhatsApp message to send into the linked app"
      >${escapeHtml(ui.drafts.messageText)}</textarea>

      <div class="composer-tools">
        <label class="file-button">
          Attach media
          <input id="media-input" type="file" name="media" multiple />
        </label>
        <label class="file-button">
          Load .txt message
          <input id="message-file" type="file" accept=".txt,text/plain" />
        </label>
        <input class="input note-input" name="note" value="${escapeAttribute(ui.drafts.messageNote)}" placeholder="Optional note for metadata" />
        <button class="primary-button" type="submit" ${ui.busy ? 'disabled' : ''}>Send to app</button>
      </div>
    </form>
  `;
}

function renderMessage(message) {
  const side = message.direction === 'outbound' ? 'outgoing' : 'incoming';
  const statusClass = message.status === 'failed' ? 'danger' : message.status === 'delivered' ? 'success' : 'neutral';
  return `
    <article class="message-row ${side}">
      <div class="bubble">
        <div class="bubble-meta">
          <strong>${escapeHtml(message.direction === 'outbound' ? message.senderLabel || 'App' : message.senderLabel || 'Tester')}</strong>
          <span>${escapeHtml(message.source)} · ${formatDateTime(message.createdAt)}</span>
        </div>
        ${message.text ? `<p class="message-text">${linkify(escapeHtml(message.text))}</p>` : ''}
        ${renderMedia(message.media)}
        <div class="message-footer">
          <span class="mini-status ${statusClass}">${escapeHtml(message.status)}</span>
          ${renderTags(message.tags)}
        </div>
        ${message.delivery?.error ? `<p class="delivery-error">${escapeHtml(message.delivery.error)}</p>` : ''}
      </div>
    </article>
  `;
}

function renderMedia(media = []) {
  if (!media.length) {
    return '';
  }

  return `
    <div class="media-grid">
      ${media.map((item) => {
        const isImage = item.mimeType?.startsWith('image/') && item.url;
        if (isImage) {
          return `<a class="media-card image" href="${escapeAttribute(item.url)}" target="_blank" rel="noreferrer"><img src="${escapeAttribute(item.url)}" alt="${escapeAttribute(item.fileName)}" /><span>${escapeHtml(item.fileName)}</span></a>`;
        }

        return `<a class="media-card" href="${escapeAttribute(item.url || '#')}" target="_blank" rel="noreferrer"><span class="file-icon">FILE</span><strong>${escapeHtml(item.fileName || 'media')}</strong><small>${escapeHtml(item.mimeType || 'file')}</small></a>`;
      }).join('')}
    </div>
  `;
}

function renderChatPrimer(chat) {
  return `
    <div class="chat-primer">
      <h3>Start a simulated WhatsApp conversation</h3>
      <p>Messages you send here are treated as inbound messages from ${escapeHtml(chat.phone || chat.jid)} into your linked app. Replies from your app appear as outgoing bubbles.</p>
    </div>
  `;
}

function renderEmptyChat() {
  return `
    <div class="empty-chat">
      <h2>Select or add a test number</h2>
      <p>Create a fake WhatsApp contact, then send messages into any Baileys-based app through the configured webhook.</p>
    </div>
  `;
}

function renderInspector(chat) {
  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Link</p>
          <h2>App connection</h2>
        </div>
      </div>
      <form id="config-form" class="stack">
        <label>
          <span>Project name</span>
          <input class="input" name="projectName" value="${escapeAttribute(state.config.projectName || '')}" />
        </label>
        <label>
          <span>Delivery mode</span>
          <select class="input" name="deliveryMode">
            <option value="generic" ${state.config.deliveryMode === 'generic' ? 'selected' : ''}>Generic Baileys webhook</option>
          </select>
        </label>
        <label>
          <span>Inbound webhook URL</span>
          <input class="input" name="webhookUrl" value="${escapeAttribute(state.config.webhookUrl || '')}" placeholder="http://localhost:4000/test/baileys/inbound" />
        </label>
        <label>
          <span>Tester base URL</span>
          <input class="input" name="testerBaseUrl" value="${escapeAttribute(state.config.testerBaseUrl || 'http://localhost:5055')}" />
        </label>
        <label>
          <span>Bearer token</span>
          <input class="input" name="bearerToken" placeholder="${state.config.bearerToken === '__SET__' ? 'Token is set. Leave keep checked.' : 'Optional'}" />
        </label>
        <label class="check-row">
          <input name="keepBearerToken" type="checkbox" ${state.config.bearerToken === '__SET__' ? 'checked' : ''} />
          <span>Keep existing bearer token</span>
        </label>
        <label>
          <span>Webhook secret</span>
          <input class="input" name="webhookSecret" placeholder="${state.config.webhookSecret === '__SET__' ? 'Secret is set. Leave keep checked.' : 'Optional'}" />
        </label>
        <label class="check-row">
          <input name="keepWebhookSecret" type="checkbox" ${state.config.webhookSecret === '__SET__' ? 'checked' : ''} />
          <span>Keep existing webhook secret</span>
        </label>
        <button class="primary-button" type="submit">Save connection</button>
      </form>
      <div class="endpoint-card">
        <p>App outbound endpoint</p>
        <code>POST http://localhost:5055/api/app/outbound</code>
      </div>
    </section>

    ${chat ? renderChatInspector(chat) : ''}

    <section class="panel-section">
      <div class="section-heading small">
        <h3>Recent events</h3>
      </div>
      <div class="event-list">
        ${state.events.length ? state.events.slice(0, 14).map(renderEvent).join('') : '<div class="empty-small">No events yet.</div>'}
      </div>
    </section>
  `;
}

function renderChatInspector(chat) {
  return `
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Selected</p>
          <h2>Chat context</h2>
        </div>
      </div>
      <form id="chat-form" class="stack">
        <label>
          <span>Display name</span>
          <input class="input" name="name" value="${escapeAttribute(ui.drafts.chatName || chat.name || '')}" />
        </label>
        <label>
          <span>Chat tags</span>
          <input class="input" name="tags" value="${escapeAttribute(ui.drafts.chatTags || (chat.tags ?? []).join(', '))}" />
        </label>
        <label>
          <span>Notes</span>
          <textarea class="textarea small" name="notes">${escapeHtml(ui.drafts.chatNotes || chat.notes || '')}</textarea>
        </label>
        <button class="secondary-button" type="submit">Save chat context</button>
      </form>
      <dl class="details">
        <div><dt>Phone</dt><dd>${escapeHtml(chat.phone || '-')}</dd></div>
        <div><dt>JID</dt><dd>${escapeHtml(chat.jid)}</dd></div>
        <div><dt>Messages</dt><dd>${chat.messageCount}</dd></div>
        <div><dt>Last delivery</dt><dd>${escapeHtml(chat.lastDeliveryStatus || 'none')}</dd></div>
      </dl>
    </section>
  `;
}

function renderEvent(event) {
  return `
    <article class="event ${event.level}">
      <div>
        <strong>${escapeHtml(event.type)}</strong>
        <time>${formatDateTime(event.createdAt)}</time>
      </div>
      <pre>${escapeHtml(JSON.stringify(event.payload ?? {}, null, 2))}</pre>
    </article>
  `;
}

function renderTags(tags = []) {
  if (!tags.length) {
    return '';
  }

  return tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
}

function bindEvents() {
  document.querySelector('[data-action="refresh"]')?.addEventListener('click', loadState);

  document.querySelector('#chat-search')?.addEventListener('input', (event) => {
    ui.search = event.target.value;
    render();
  });

  document.querySelectorAll('[data-chat-id]').forEach((button) => {
    button.addEventListener('click', () => {
      ui.selectedChatId = button.dataset.chatId;
      primeChatDraft(getSelectedChat());
      render();
    });
  });

  document.querySelector('#new-chat-form')?.addEventListener('input', captureNewChatDraft);
  document.querySelector('#new-chat-form')?.addEventListener('submit', submitNewChat);
  document.querySelector('#contacts-file')?.addEventListener('change', handleContactsFile);
  document.querySelector('[data-action="import-contacts"]')?.addEventListener('click', importContactsFromTextarea);
  document.querySelector('#bulk-contacts')?.addEventListener('input', (event) => {
    ui.drafts.bulkContacts = event.target.value;
  });

  document.querySelector('#composer-form')?.addEventListener('input', captureComposerDraft);
  document.querySelector('#composer-form')?.addEventListener('submit', submitMessage);
  document.querySelector('#message-file')?.addEventListener('change', loadMessageFile);
  document.querySelector('#config-form')?.addEventListener('submit', submitConfig);
  document.querySelector('#chat-form')?.addEventListener('input', captureChatDraft);
  document.querySelector('#chat-form')?.addEventListener('submit', submitChatContext);
}

function captureNewChatDraft(event) {
  const form = event.currentTarget;
  ui.drafts.newPhone = form.phone.value;
  ui.drafts.newName = form.name.value;
  ui.drafts.newTags = form.tags.value;
}

function captureComposerDraft(event) {
  const form = event.currentTarget;
  ui.drafts.messageText = form.text.value;
  ui.drafts.messageTags = form.tags.value;
  ui.drafts.messageNote = form.note.value;
  ui.drafts.testRunId = form.testRunId.value;
}

function captureChatDraft(event) {
  const form = event.currentTarget;
  ui.drafts.chatName = form.name.value;
  ui.drafts.chatTags = form.tags.value;
  ui.drafts.chatNotes = form.notes.value;
}

async function submitNewChat(event) {
  event.preventDefault();
  const form = event.currentTarget;
  captureNewChatDraft(event);

  if (!form.phone.value.trim()) {
    setStatus('Phone or JID is required.', 'danger');
    render();
    return;
  }

  try {
    const chat = await api('/api/chats', {
      method: 'POST',
      body: {
        phone: form.phone.value.trim(),
        name: form.name.value.trim(),
        tags: form.tags.value
      }
    });
    ui.selectedChatId = chat.id;
    ui.drafts.newPhone = '';
    ui.drafts.newName = '';
    setStatus('Chat added', 'success');
    await loadState();
  } catch (error) {
    setStatus(error.message, 'danger');
    render();
  }
}

async function handleContactsFile(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const text = await file.text();
  ui.drafts.bulkContacts = text;
  await importContacts(parseContacts(text));
}

async function importContactsFromTextarea() {
  await importContacts(parseContacts(ui.drafts.bulkContacts));
}

async function importContacts(contacts) {
  if (!contacts.length) {
    setStatus('No contacts found to import.', 'danger');
    render();
    return;
  }

  try {
    setStatus(`Importing ${contacts.length} contacts...`, 'neutral');
    render();
    let firstChatId = null;

    for (const contact of contacts) {
      const chat = await api('/api/chats', {
        method: 'POST',
        body: contact
      });
      firstChatId ??= chat.id;
    }

    ui.selectedChatId = firstChatId ?? ui.selectedChatId;
    setStatus(`Imported ${contacts.length} contacts`, 'success');
    await loadState();
  } catch (error) {
    setStatus(error.message, 'danger');
    render();
  }
}

async function loadMessageFile(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  ui.drafts.messageText = await file.text();
  render();
}

async function submitMessage(event) {
  event.preventDefault();
  const chat = getSelectedChat();
  if (!chat) {
    setStatus('Select a chat first.', 'danger');
    render();
    return;
  }

  const form = event.currentTarget;
  captureComposerDraft(event);

  const formData = new FormData();
  formData.set('text', form.text.value);
  formData.set('tags', form.tags.value);
  formData.set('note', form.note.value);
  formData.set('testRunId', form.testRunId.value);

  const files = document.querySelector('#media-input')?.files ?? [];
  for (const file of files) {
    formData.append('media', file);
  }

  if (!form.text.value.trim() && files.length === 0) {
    setStatus('Write text or attach media first.', 'danger');
    render();
    return;
  }

  try {
    ui.busy = true;
    setStatus('Sending message to linked app...', 'neutral');
    render();
    await api(`/api/chats/${chat.id}/send-to-app`, {
      method: 'POST',
      body: formData
    });
    ui.drafts.messageText = '';
    ui.drafts.messageNote = '';
    setStatus('Message sent into app', 'success');
    await loadState();
  } catch (error) {
    setStatus(error.message, 'danger');
    render();
  } finally {
    ui.busy = false;
  }
}

async function submitConfig(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {
    projectName: form.projectName.value,
    deliveryMode: form.deliveryMode.value,
    webhookUrl: form.webhookUrl.value,
    testerBaseUrl: form.testerBaseUrl.value,
    bearerToken: form.keepBearerToken.checked ? '__KEEP__' : form.bearerToken.value,
    webhookSecret: form.keepWebhookSecret.checked ? '__KEEP__' : form.webhookSecret.value
  };

  try {
    await api('/api/config', {
      method: 'PUT',
      body
    });
    setStatus('Connection saved', 'success');
    await loadState();
  } catch (error) {
    setStatus(error.message, 'danger');
    render();
  }
}

async function submitChatContext(event) {
  event.preventDefault();
  const chat = getSelectedChat();
  if (!chat) {
    return;
  }

  const form = event.currentTarget;
  captureChatDraft(event);

  try {
    await api(`/api/chats/${chat.id}`, {
      method: 'PATCH',
      body: {
        name: form.name.value,
        tags: form.tags.value,
        notes: form.notes.value
      }
    });
    setStatus('Chat context saved', 'success');
    await loadState();
  } catch (error) {
    setStatus(error.message, 'danger');
    render();
  }
}

function primeChatDraft(chat) {
  ui.drafts.chatName = chat?.name ?? '';
  ui.drafts.chatTags = (chat?.tags ?? []).join(', ');
  ui.drafts.chatNotes = chat?.notes ?? '';
}

function getSelectedChat() {
  return state.chats.find((chat) => chat.id === ui.selectedChatId) ?? null;
}

function getFilteredChats() {
  const query = ui.search.trim().toLowerCase();
  if (!query) {
    return state.chats;
  }

  return state.chats.filter((chat) =>
    [chat.phone, chat.jid, chat.name, ...(chat.tags ?? [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query))
  );
}

function getMessagesForChat(chatId) {
  return state.messages
    .filter((message) => message.chatId === chatId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

async function api(path, options = {}) {
  const init = {
    method: options.method ?? 'GET',
    headers: options.headers ? { ...options.headers } : {}
  };

  if (options.body instanceof FormData) {
    init.body = options.body;
  } else if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({
    success: false,
    error: { message: 'Invalid server response.' }
  }));

  if (!response.ok || !payload.success) {
    throw new Error(payload.error?.message ?? `Request failed: ${response.status}`);
  }

  return payload.data;
}

function parseContacts(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(',').map((part) => part.trim());
      if (parts.length === 1) {
        return {
          phone: parts[0],
          name: '',
          tags: ui.drafts.newTags
        };
      }

      return {
        phone: parts[0],
        name: parts[1] ?? '',
        tags: parts.slice(2).join(',') || ui.drafts.newTags
      };
    })
    .filter((contact) => contact.phone);
}

function scrollMessagesToBottom() {
  requestAnimationFrame(() => {
    const stream = document.querySelector('#message-stream');
    if (stream) {
      stream.scrollTop = stream.scrollHeight;
    }
  });
}

function setStatus(message, tone = 'neutral') {
  ui.status = message;
  ui.statusTone = tone;
}

function initials(value) {
  const parts = String(value ?? 'BT')
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) {
    return 'BT';
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function formatShortTime(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('\n', '&#10;');
}

function linkify(value) {
  return value.replace(
    /(https?:\/\/[^\s]+)/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>'
  );
}
