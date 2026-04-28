# Bailey Tester

Bailey Tester is a local WhatsApp-style simulator for Baileys-based apps. It lets you test inbound and outbound chat behavior without using real WhatsApp.

## Run

```powershell
cd D:\ANTIGRAVITY\bailey-tester
npm install
npm start
```

Open:

```text
http://localhost:5055
```

## What It Does

- Shows a WhatsApp-style inbox with chats, message history, tags, and media.
- Lets you create/select a test phone number and send messages as that user.
- Sends simulated inbound messages to your app through a configurable webhook.
- Accepts outbound messages from your app at `POST /api/app/outbound`.
- Stores local test history in `data/state.json`.
- Stores uploaded media in `data/uploads`.

## Main Integration Idea

For any app using Baileys, temporarily replace the live Baileys adapter with a small test adapter:

- Outbound app -> WhatsApp becomes `POST http://localhost:5055/api/app/outbound`.
- Inbound WhatsApp -> app comes from Bailey Tester calling your webhook.

Read [docs/UNIVERSAL-BAILEYS-TESTER.md](docs/UNIVERSAL-BAILEYS-TESTER.md) for the generic integration pattern and payload examples.

## Changes Needed In The Original App

Your original app needs two temporary test-mode changes: one for messages going **out of your app**, and one for messages coming **into your app**.

### 1. Add A Test Transport Switch

Add env variables to the original app:

```text
WHATSAPP_TRANSPORT=bailey_tester
BAILEY_TESTER_URL=http://localhost:5055
```

Keep the real mode as:

```text
WHATSAPP_TRANSPORT=baileys
```

The app should use the tester only when `WHATSAPP_TRANSPORT=bailey_tester`.

### 2. Route Outbound App Messages To Bailey Tester

Where the app normally sends through Baileys:

```ts
await socket.sendMessage(jid, { text });
```

branch to Bailey Tester in test mode:

```ts
if (process.env.WHATSAPP_TRANSPORT === 'bailey_tester') {
  const response = await fetch(
    `${process.env.BAILEY_TESTER_URL ?? 'http://localhost:5055'}/api/app/outbound`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jid,
        text,
        messageType: 'text',
        tags: ['local-test'],
        metadata: {
          origin: 'your-app'
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Bailey Tester rejected outbound message: ${response.status}`);
  }

  const payload = await response.json();
  return payload.data.message.id;
}
```

This makes your app's replies appear in Bailey Tester as outgoing WhatsApp bubbles.

### 3. Give Bailey Tester An Inbound Webhook In Your App

Bailey Tester needs a URL it can call when you type a message in the tester UI.

If your app already has a test/simulate endpoint, use it.

For a generic Baileys app, add a dev-only endpoint like:

```text
POST /test/baileys/inbound
```

That endpoint should translate the Bailey Tester payload into the same internal handler used by real Baileys inbound messages.

Example generic handler shape:

```ts
app.post('/test/baileys/inbound', async (req, res) => {
  if (process.env.WHATSAPP_TRANSPORT !== 'bailey_tester') {
    return res.status(404).json({ success: false });
  }

  const message = req.body.messages?.[0];
  const jid = message?.key?.remoteJid;
  const text = message?.message?.conversation;

  await yourInboundMessageHandler({
    jid,
    senderJid: jid,
    senderPhone: jid?.split('@')[0],
    text,
    messageId: message?.key?.id,
    messageType: 'text',
    metadata: {
      source: 'bailey-tester',
      tags: message?.tester?.tags ?? [],
      media: message?.tester?.media ?? []
    }
  });

  return res.json({ success: true });
});
```

### 4. Skip Real QR/Connection In Test Mode

When `WHATSAPP_TRANSPORT=bailey_tester`, the original app should not open a real Baileys socket or ask for QR pairing.

In test mode:

- `connect()` can return successfully without opening WhatsApp.
- `isConnected()` can return `true`.
- `disconnect()` can be a no-op.
- `sendTextMessage()` posts to Bailey Tester.

This lets you test workflows without touching a real WhatsApp session.

### 5. Configure Bailey Tester

In Bailey Tester settings:

```text
Project name: Your app name
Delivery mode: Generic Baileys webhook
Inbound webhook URL: http://localhost:4000/test/baileys/inbound
Tester base URL: http://localhost:5055
```

### 6. Media And Tags

Bailey Tester sends media and tags in the webhook payload. Store them in your app's message metadata during testing.

Outbound app messages can also include:

```json
{
  "jid": "919999999999@s.whatsapp.net",
  "text": "Here is the invoice",
  "messageType": "document",
  "tags": ["invoice", "regression"],
  "media": [
    {
      "fileName": "invoice.pdf",
      "mimeType": "application/pdf",
      "url": "http://localhost:5055/uploads/example.pdf"
    }
  ],
  "metadata": {
    "origin": "your-app",
    "testRunId": "manual-001"
  }
}
```

## Useful Endpoints

- `GET /api/health`
- `GET /api/state`
- `PUT /api/config`
- `POST /api/chats`
- `GET /api/chats/:id/messages`
- `POST /api/chats/:id/send-to-app`
- `POST /api/app/outbound`
- `POST /api/app/events`
