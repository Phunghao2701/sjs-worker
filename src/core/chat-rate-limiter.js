const WINDOW_MS = 60_000;

export class ChatRateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const { limit: requestedLimit } = await request.json().catch(() => ({}));
    const limit = Math.max(1, Number(requestedLimit) || 5);
    const now = Date.now();
    const result = await this.state.storage.transaction(async transaction => {
      const current = await transaction.get('window');
      const record = !current || current.expiresAt <= now
        ? { count: 0, expiresAt: now + WINDOW_MS }
        : current;
      record.count += 1;
      await transaction.put('window', record);
      return { allowed: record.count <= limit, limit, expiresAt: record.expiresAt };
    });
    await this.state.storage.setAlarm(result.expiresAt);
    return Response.json({ allowed: result.allowed, limit: result.limit });
  }

  async alarm() {
    const now = Date.now();
    const nextExpiry = await this.state.storage.transaction(async transaction => {
      const current = await transaction.get('window');
      if (!current || current.expiresAt <= now) {
        await transaction.delete('window');
        return null;
      }
      return current.expiresAt;
    });
    if (nextExpiry) await this.state.storage.setAlarm(nextExpiry);
  }
}
