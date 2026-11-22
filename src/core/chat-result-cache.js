export class ChatResultCache {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/get' && request.method === 'GET') {
      const result = await this.state.storage.transaction(async transaction => {
        const entry = await transaction.get('result');
        if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
          await transaction.delete('result');
          return null;
        }
        return entry?.value || null;
      });
      return Response.json({ value: result });
    }

    if (path === '/set' && request.method === 'POST') {
      const { value, ttlSeconds } = await request.json().catch(() => ({}));
      if (!value || typeof value.answer !== 'string') return Response.json({ error: 'Invalid chat cache entry' }, { status: 400 });
      const ttl = Number(ttlSeconds);
      const expiresAt = Number.isFinite(ttl) && ttl > 0 ? Date.now() + Math.floor(ttl) * 1000 : null;
      await this.state.storage.put('result', { value, expiresAt });
      if (expiresAt) await this.state.storage.setAlarm(expiresAt);
      return Response.json({ stored: true });
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm() {
    const now = Date.now();
    const nextExpiry = await this.state.storage.transaction(async transaction => {
      const entry = await transaction.get('result');
      if (!entry?.expiresAt) return null;
      if (entry.expiresAt <= now) {
        await transaction.delete('result');
        return null;
      }
      return entry.expiresAt;
    });
    if (nextExpiry) await this.state.storage.setAlarm(nextExpiry);
  }
}
