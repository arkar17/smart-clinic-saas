import type { Response } from 'express';
import pg from 'pg';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { Logger } from '../../infra/logger';

type Db = PrismaClient | Prisma.TransactionClient;
export type EventType = 'queue.entry.created' | 'queue.entry.updated' | 'queue.counter.updated' | 'appointment.updated';

/** PII-free payload (ADR-026): IDs, status, token, version and counters only. */
export interface EventPayload { entityId?: string; status?: string; token?: number; version?: number; counters?: { lastToken: number; walkInCount: number; paused: boolean } }

/**
 * Transactional outbox (ADR-012): the row and pg_notify commit with the business change, so subscribers in any
 * process (API or worker) only ever see committed state.
 */
export async function emitEvent(db: Db, e: { clinicId: string; type: EventType; doctorId?: string | null; queueEntryId?: string | null; appointmentId?: string | null; payload: EventPayload }) {
  const row = await db.clinicEvent.create({
    data: { clinicId: e.clinicId, type: e.type, doctorId: e.doctorId ?? null, queueEntryId: e.queueEntryId ?? null, appointmentId: e.appointmentId ?? null, payload: e.payload as Prisma.InputJsonValue },
  });
  await db.$executeRaw`SELECT pg_notify('clinic_event', ${row.id.toString()})`;
  return row.id;
}

export interface StoredEvent { id: bigint; clinicId: string; type: string; doctorId: string | null; queueEntryId: string | null; appointmentId: string | null; payload: unknown }

interface BaseSub { id: number; clinicId: string; ipKey: string; res: Response; revalidate: () => Promise<boolean> }
/** Staff stream bound at connect to the selected membership (Arch 19.1). */
export interface StaffSub extends BaseSub { kind: 'staff'; sessionHash: string; memberId: string; userId: string; ownDoctorId: string | null }
/** Patient stream bound to one queue entry; receives only its own recomputed status. */
export interface PublicSub extends BaseSub { kind: 'public'; entryId: string; status: () => Promise<unknown> }
type Sub = StaffSub | PublicSub;

const STAFF_STREAMS_PER_USER = 10;
const PUBLIC_STREAMS_PER_IP = 5;

/** In-process SSE hub fed by one dedicated LISTEN connection (ADR-012, Arch 19). */
export class Hub {
  private subs = new Map<number, Sub>();
  private seq = 0;
  private client: pg.Client | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(private prisma: PrismaClient, private log: Logger) {}

  async start(databaseUrl: string) {
    this.stopped = false;
    await this.connect(databaseUrl);
    this.timers.push(setInterval(() => this.broadcastComment('heartbeat'), 25_000));
    this.timers.push(setInterval(() => void this.revalidateAll(), 60_000));
  }

  private async connect(databaseUrl: string) {
    const client = new pg.Client({ connectionString: databaseUrl });
    client.on('notification', (msg) => { if (msg.payload) void this.dispatch(BigInt(msg.payload)); });
    client.on('error', (err) => {
      this.log.error({ err }, 'LISTEN connection lost');
      this.client = null;
      if (this.stopped) return;
      setTimeout(() => void this.connect(databaseUrl).then(() => this.broadcast('resync', {})).catch((e) => this.log.error({ err: e }, 'LISTEN reconnect failed')), 1000);
    });
    await client.connect();
    await client.query('LISTEN clinic_event');
    this.client = client;
  }

  async stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const s of this.subs.values()) s.res.end();
    this.subs.clear();
    await this.client?.end().catch(() => undefined);
    this.client = null;
  }

  /** Opens an SSE response; returns false when the per-user / per-IP cap is reached. */
  open(sub: Omit<StaffSub, 'id'> | Omit<PublicSub, 'id'>): number | null {
    const all = [...this.subs.values()];
    if (sub.kind === 'staff' && all.filter((s) => s.kind === 'staff' && s.userId === sub.userId).length >= STAFF_STREAMS_PER_USER) return null;
    if (sub.kind === 'public' && all.filter((s) => s.kind === 'public' && s.ipKey === sub.ipKey).length >= PUBLIC_STREAMS_PER_IP) return null;
    const id = ++this.seq;
    const full = { ...sub, id } as Sub;
    this.subs.set(id, full);
    sub.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive', 'X-Robots-Tag': 'noindex' });
    sub.res.write('retry: 3000\n\n');
    sub.res.on('close', () => this.subs.delete(id));
    return id;
  }

  send(subId: number, event: string, data: unknown, id?: bigint) {
    const s = this.subs.get(subId);
    if (!s) return;
    s.res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Audience routing (Arch 19.1): clinic first; DR only own doctor (plus counters); patients only their recomputed status. */
  private async dispatch(eventId: bigint) {
    const e = await this.prisma.clinicEvent.findFirst({ where: { id: eventId } });
    if (!e) return;
    for (const s of this.subs.values()) {
      if (s.clinicId !== e.clinicId) continue;
      if (s.kind === 'staff') {
        if (staffMayReceive(s, e)) this.send(s.id, e.type, staffPayload(e), e.id);
      } else if (e.queueEntryId === s.entryId || e.doctorId) {
        // Any change for the clinic's doctors may move this patient's position; the payload is recomputed for this entry only.
        const status = await s.status().catch(() => null);
        if (status) this.send(s.id, 'status', status, e.id);
        else this.close(s.id);
      }
    }
  }

  async replay(subId: number, clinicId: string, afterId: bigint) {
    const s = this.subs.get(subId);
    if (!s || s.kind !== 'staff') return;
    const events = await this.prisma.clinicEvent.findMany({ where: { clinicId, id: { gt: afterId } }, orderBy: { id: 'asc' }, take: 500 });
    for (const e of events) if (staffMayReceive(s, e)) this.send(subId, e.type, staffPayload(e), e.id);
  }

  close(subId: number) {
    const s = this.subs.get(subId);
    if (!s) return;
    s.res.end();
    this.subs.delete(subId);
  }
  /** FR-SEC-002 / FR-STF-003 / FR-PLT-003: close streams on clinic switch, membership change, revocation or suspension. */
  closeWhere(pred: (s: Sub) => boolean) {
    for (const s of [...this.subs.values()]) if (pred(s)) this.close(s.id);
  }
  closeSession = (sessionHash: string) => this.closeWhere((s) => s.kind === 'staff' && s.sessionHash === sessionHash);
  closeMember = (memberId: string) => this.closeWhere((s) => s.kind === 'staff' && s.memberId === memberId);
  closeUser = (userId: string) => this.closeWhere((s) => s.kind === 'staff' && s.userId === userId);
  closeClinic = (clinicId: string) => this.closeWhere((s) => s.clinicId === clinicId);

  /** Arch 19.3: credentials of open streams are re-validated every 60 s. */
  async revalidateAll() {
    for (const s of [...this.subs.values()]) if (!(await s.revalidate().catch(() => false))) this.close(s.id);
  }
  private broadcastComment(text: string) {
    for (const s of this.subs.values()) s.res.write(`: ${text}\n\n`);
  }
  private broadcast(event: string, data: unknown) {
    for (const s of this.subs.values()) this.send(s.id, event, data);
  }
  get size() {
    return this.subs.size;
  }
}

function staffMayReceive(s: StaffSub, e: StoredEvent) {
  if (!s.ownDoctorId) return true; // CA / RC: all clinic events
  return e.type === 'queue.counter.updated' || e.doctorId === s.ownDoctorId;
}
const staffPayload = (e: StoredEvent) => ({ id: e.id.toString(), type: e.type, doctorId: e.doctorId, queueEntryId: e.queueEntryId, appointmentId: e.appointmentId, ...(e.payload as object) });
