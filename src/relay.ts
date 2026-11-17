import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

type Turn = { user: string; assistant: string };
export type Input = { requestId: string; text: string; history?: Turn[] };
type Send = (text: string) => Promise<void>;
type Typing = { start: () => Promise<void>; stop: () => Promise<void> };
export type Backend = 'grok' | 'ollama';
type Routing = {
  defaultBackend: Backend;
  available: Backend[];
  describe?: (backend: Backend) => Promise<string>;
};
type Job = Input & { backend: Backend; historyKey: string; historyVersion: number; send?: Send; typing?: Typing };

const backendNames = { grok: 'Grok Bot', ollama: 'Ollama' };

export class Relay {
  private db: DatabaseSync;
  private trigger: (input: Input, backend: Backend) => Promise<string | void>;
  private now: () => number;
  private report: (id: string, status: string, backend?: Backend) => void;
  private routing: Routing;
  private queue: Job[] = [];
  private history = new Map<string, Turn[]>();
  private historyVersions = new Map<string, number>();
  private active?: Job;
  private timer?: NodeJS.Timeout;

  constructor(path: string, trigger: (input: Input, backend: Backend) => Promise<string | void>, now = Date.now, report = (_id: string, _status: string, _backend?: Backend) => {}, routing: Routing = { defaultBackend: 'grok', available: ['grok'] }) {
    this.db = new DatabaseSync(path);
    this.trigger = trigger;
    this.now = now;
    this.report = report;
    this.routing = routing;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        event_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, expires_at INTEGER, captured_text TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_backends (chat_id TEXT PRIMARY KEY, backend TEXT NOT NULL);
      UPDATE turns SET status = 'interrupted' WHERE status IN ('queued', 'pending');
      UPDATE turns SET status = 'send_unknown' WHERE status = 'sending';
    `);
  }

  async receive(eventId: string, chatId: string, text: string, send?: Send, typing?: Typing) {
    const requestId = randomUUID();
    const { changes } = this.db.prepare(
      "INSERT OR IGNORE INTO turns (event_id, chat_id, request_id, status) VALUES (?, ?, ?, 'queued')",
    ).run(eventId, chatId, requestId);
    if (!changes) return;
    const backend = this.backendFor(chatId);
    const historyKey = JSON.stringify([chatId, backend]);
    const command = text.normalize('NFKC').replace(/\p{Cf}/gu, '').trim().toLowerCase();
    if (command.startsWith('/')) {
      this.setStatus(requestId, 'command');
      const answer = await this.command(chatId, backend, historyKey, command);
      if (send) await send(answer);
      return;
    }
    this.queue.push({
      requestId, text, backend, historyKey, historyVersion: this.historyVersions.get(historyKey) ?? 0, send, typing,
    });
    await this.advance();
    return requestId;
  }

  private backendFor(chatId: string): Backend {
    const row = this.db.prepare('SELECT backend FROM chat_backends WHERE chat_id = ?').get(chatId);
    const backend = row?.backend;
    if ((backend === 'grok' || backend === 'ollama') && this.routing.available.includes(backend)) return backend;
    return this.routing.defaultBackend;
  }

  private async command(chatId: string, backend: Backend, historyKey: string, command: string) {
    switch (command) {
      case '/grok':
      case '/ollama': {
        const selected = command === '/grok' ? 'grok' : 'ollama';
        if (!this.routing.available.includes(selected)) return `${backendNames[selected]} is not configured on this relay.`;
        this.db.prepare('INSERT INTO chat_backends (chat_id, backend) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET backend = excluded.backend')
          .run(chatId, selected);
        return `Switched to ${backendNames[selected]}.`;
      }
      case '/backend': {
        const detail = await this.routing.describe?.(backend);
        return `Active backend: ${backendNames[backend]}.${detail ? ' ' + detail : ''}`;
      }
      case '/reset':
        this.history.delete(historyKey);
        this.historyVersions.set(historyKey, (this.historyVersions.get(historyKey) ?? 0) + 1);
        return `Cleared this thread’s relay history for ${backendNames[backend]}.`;
      case '/help':
        return '/grok — Grok Bot\n/ollama — local model\n/backend — active backend\n/reset — clear active relay history\n/help — show commands';
      default:
        return 'Unknown command. Text /help for commands.';
    }
  }

  async replyFromGrok(requestId: string, text: string) {
    if (this.active?.requestId === requestId && this.active.backend !== 'grok') return 'unknown';
    return this.reply(requestId, text);
  }

  private setStatus(id: string, status: string) {
    this.db.prepare('UPDATE turns SET status = ? WHERE request_id = ?').run(status, id);
    this.report(id, status, this.active?.requestId === id ? this.active.backend : undefined);
  }

  private async advance() {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    if (job.typing) {
      await job.typing.start().catch(() => this.report(job.requestId, 'typing_start_failed'));
    }
    this.db.prepare("UPDATE turns SET status = 'pending', expires_at = ? WHERE request_id = ?")
      .run(this.now() + 180_000, job.requestId);
    this.timer = setTimeout(() => {
      this.setStatus(job.requestId, 'expired');
      void this.finish();
    }, 180_000).unref();
    try {
      const input = { requestId: job.requestId, text: job.text, history: this.history.get(job.historyKey) };
      const answer = await this.trigger(input, job.backend);
      if (typeof answer === 'string') await this.reply(job.requestId, answer);
    } catch {
      const row = this.db.prepare('SELECT status FROM turns WHERE request_id = ?').get(job.requestId);
      if (row?.status === 'pending') {
        this.setStatus(job.requestId, 'trigger_unknown');
        await this.finish();
      }
    }
  }

  private async finish() {
    clearTimeout(this.timer);
    if (this.active) await this.stopTyping(this.active);
    this.active = undefined;
    await this.advance();
  }

  private async stopTyping(job: Job) {
    const typing = job.typing;
    job.typing = undefined;
    if (typing) await typing.stop().catch(() => this.report(job.requestId, 'typing_stop_failed'));
  }

  async reply(requestId: string, text: string) {
    const row = this.db.prepare('SELECT status, expires_at FROM turns WHERE request_id = ?').get(requestId);
    if (!row) return 'unknown';
    if (row.status === 'expired') return 'expired';
    if (row.status !== 'pending' || this.active?.requestId !== requestId) return 'duplicate';
    if (Number(row.expires_at) <= this.now()) {
      this.setStatus(requestId, 'expired');
      await this.finish();
      return 'expired';
    }
    clearTimeout(this.timer);
    const job = this.active;
    const send = job.send;
    let status = 'captured';
    if (send) {
      this.setStatus(requestId, 'sending');
      await this.stopTyping(job);
      try {
        await send(text);
        status = 'sent';
      } catch {
        status = 'send_unknown';
      }
    } else {
      this.db.prepare('UPDATE turns SET captured_text = ? WHERE request_id = ?').run(text, requestId);
    }
    if ((status === 'sent' || status === 'captured') &&
        (this.historyVersions.get(job.historyKey) ?? 0) === job.historyVersion) {
      const recent = this.history.get(job.historyKey) ?? [];
      this.history.set(job.historyKey, [...recent.slice(-3), {
        user: job.text.slice(0, 4000), assistant: text.slice(0, 4000),
      }]);
    }
    this.setStatus(requestId, status);
    await this.finish();
    return status;
  }
}
