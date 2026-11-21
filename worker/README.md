# WhatsApp reader (Command Center)

Keeps each owner's WhatsApp linked-device session open and forwards recent chat
messages to the Command Center API. Read-only: it never sends messages.

Deploy on any always-on Node 20+ host (Railway, Render, Fly):

- Root directory: `worker`
- Start command: `node index.mjs`
- Environment variable `WORKER_SECRET`: the worker secret from the Command Center setup
