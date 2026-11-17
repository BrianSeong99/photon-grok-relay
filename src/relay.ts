import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

type Turn = { user: string; assistant: string };
export type Input = { requestId: string; text: string; history?: Turn[] };
type Send = (text: string) => Promise<void>;
type Typing = { start: () => Promise<void>; stop: () => Promise<void> };
type Job = Input & { chatId: string; send?: Send; typing?: Typing };

export class Relay {
  private db: DatabaseSync;
  private trigger: (input: Input) => Promise<string | void>;
  private now: () => number;
  private report: (id: string, status: string) => void;
  private queue: Job[] = [];
  private history = new Map<string, Turn[]>();
  private active?: Job;
  private timer?: NodeJS.Timeout;

  constructor(path: string, trigger: (input: Input) => Promise<string | void>, now = Date.now, report = (_id: string, _status: string) => {}) {
    this.db = new DatabaseSync(path);
    this.trigger = trigger;
    this.now = now;
    this.report = report;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        event_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, expires_at INTEGER, captured_text TEXT
      );
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
    this.queue.push({ requestId, chatId, text, send, typing });
    await this.advance();
    return requestId;
  }

  private setStatus(id: string, status: string) {
    this.db.prepare('UPDATE turns SET status = ? WHERE request_id = ?').run(status, id);
    this.report(id, status);
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
      const input = { requestId: job.requestId, text: job.text, history: this.history.get(job.chatId) };
      const answer = await this.trigger(input);
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
    if (status === 'sent' || status === 'captured') {
      const recent = this.history.get(job.chatId) ?? [];
      this.history.set(job.chatId, [...recent.slice(-3), {
        user: job.text.slice(0, 4000), assistant: text.slice(0, 4000),
      }]);
    }
    this.setStatus(requestId, status);
    await this.finish();
    return status;
  }
}
