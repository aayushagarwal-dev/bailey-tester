# Universal Baileys Tester Design

This document describes how to use Bailey Tester as a generic local WhatsApp simulator for any project that normally talks to WhatsApp through Baileys.

## Problem

Real WhatsApp testing is slow, noisy, stateful, and risky:

- QR/session pairing gets in the way.
- Real groups and customers can receive accidental messages.
- Media, retries, and message history are hard to reproduce.
- Automated tests should not depend on a real WhatsApp session.

Bailey Tester gives the project a fake WhatsApp surface with the same broad shape:

- Inbound messages are sent from fake users into your app.
- Outbound messages from your app are captured and shown in the tester UI.
- Messages can have tags, metadata, media, and delivery status.

## Architecture

```text
Human tester
   |
   v
Bailey Tester UI
   |
   | POST simulated inbound webhook
   v
Your app inbound endpoint

Your app Baileys adapter
   |
   | POST outbound message
   v
Bailey Tester API
   |
   v
Bailey Tester UI message history
```

## Two Temporary Changes In Your App

### 1. Route outbound messages to Bailey Tester

Where your app currently calls Baileys:

```ts
await socket.sendMessage(jid, { text });
```

temporarily route to Bailey Tester:

```ts
await fetch('http://localhost:5055/api/app/outbound', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jid,
    text,
    messageType: 'text',
    tags: ['local-test'],
    metadata: {
      origin: 'my-app'
    }
  })
});
```

Bailey Tester will create or update the chat and show the message as an outgoing WhatsApp bubble.

### 2. Expose an inbound test endpoint in your app

Your app needs one HTTP endpoint that accepts simulated inbound messages and passes them into the same internal handler that real Baileys messages use.

Generic payload from Bailey Tester:

```json
{
  "event": "messages.upsert",
  "source": "bailey-tester",
  "chat": {
    "jid": "919999999999@s.whatsapp.net",
    "phone": "919999999999",
    "name": "Test Customer",
    "tags": ["pricing"]
  },
  "messages": [
    {
      "key": {
        "remoteJid": "919999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "bt_msg_123"
      },
      "message": {
        "conversation": "What is the price?"
      },
      "messageTimestamp": 1777360000,
      "pushName": "Test Customer",
      "tester": {
        "tags": ["pricing"],
        "media": []
      }
    }
  ]
}
```

Your endpoint can translate that into your normal internal message envelope.

## Payload Modes

Bailey Tester supports two delivery styles.

### Generic Baileys-like webhook

Use this for new projects or apps with a thin adapter layer.

Config:

```json
{
  "deliveryMode": "generic",
  "webhookUrl": "http://localhost:4000/test/baileys/inbound"
}
```

## Recommended Adapter Interface

Add a runtime switch to your app:

```text
WHATSAPP_TRANSPORT=baileys
WHATSAPP_TRANSPORT=bailey_tester
BAILEY_TESTER_URL=http://localhost:5055
```

Use a common interface:

```ts
interface WhatsAppTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  sendTextMessage(jid: string, text: string, metadata?: Record<string, unknown>): Promise<string>;
  sendMediaMessage(input: {
    jid: string;
    caption?: string;
    mediaUrl?: string;
    mimeType?: string;
    fileName?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string>;
}
```

Then create:

- `BaileysTransport`: the real adapter.
- `BaileyTesterTransport`: the fake adapter that posts to Bailey Tester.

## BaileyTesterTransport Example

```ts
export class BaileyTesterTransport {
  constructor(private readonly baseUrl = 'http://localhost:5055') {}

  async connect() {}
  async disconnect() {}
  isConnected() {
    return true;
  }

  async sendTextMessage(jid: string, text: string, metadata = {}) {
    const response = await fetch(`${this.baseUrl}/api/app/outbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jid,
        text,
        messageType: 'text',
        metadata
      })
    });

    if (!response.ok) {
      throw new Error(`Bailey Tester rejected outbound message: ${response.status}`);
    }

    const payload = await response.json();
    return payload.data.message.id;
  }
}
```

## Media Testing

For inbound media, upload files in the UI. Bailey Tester stores them locally and includes references in the webhook payload:

```json
{
  "media": [
    {
      "id": "bt_media_123",
      "fileName": "invoice.pdf",
      "mimeType": "application/pdf",
      "size": 12044,
      "url": "http://localhost:5055/uploads/bt_media_123-invoice.pdf"
    }
  ]
}
```

Your app can either:

- Download from the `url`.
- Store only metadata during tests.
- Map it into your existing media import path.

## Message Tags

Tags are intentionally generic. Suggested uses:

- `pricing`
- `lead-qualification`
- `task-command`
- `media`
- `regression`
- `manual-test`

Bailey Tester includes tags in:

- Chat state.
- Message state.
- Webhook payload.
- UI filters.

Your app can store them in message metadata or lead labels.

## Security

Bailey Tester is meant for local development.

Recommended:

- Keep it bound to localhost when using real customer-like data.
- Use a local bearer token when exposing app inbound endpoints.
- Never point it at production unless the transport is explicitly fake.

## Testing Checklist

1. Start Bailey Tester.
2. Start your app.
3. Configure the inbound webhook in Bailey Tester.
4. Replace outbound Baileys send calls with Bailey Tester transport.
5. Create a chat in Bailey Tester.
6. Send inbound text.
7. Confirm your app processes it.
8. Confirm app replies show in Bailey Tester.
9. Test media upload.
10. Test tags and message history.
