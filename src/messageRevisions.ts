import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
export interface MessageRevision {
  id: string; conversationId: string; targetOrdinal: number; targetStepIndex: number;
  originalText: string; text: string; createdAt: number;
}
const TOKEN = /\u2063AGY_REVISION:([a-f0-9-]{36})\u2063/g;
export function revisionToken(id: string): string { return `\u2063AGY_REVISION:${id}\u2063`; }
export function stripRevisionToken(text: string): string { return text.replace(TOKEN, '').trimEnd(); }
export function revisionIds(text: string): string[] { return [...text.matchAll(TOKEN)].map((match) => match[1]); }
export function rewriteRevisionHistory(envelope: any, records: MessageRevision[]): boolean {
  const payload = envelope.request || envelope;
  if (!Array.isArray(payload.contents)) return false;
  const byId = new Map(records.map((record) => [record.id, record]));
  let ordinal = 0;
  let entries = payload.contents.map((content: any, index: number) => {
    const requests = (content.parts || []).flatMap((part: any, partIndex: number) => typeof part.text === 'string'
      ? [...part.text.matchAll(/<USER_REQUEST>\r?\n([\s\S]*?)\r?\n<\/USER_REQUEST>/g)].map((match) => ({ text: match[1], partIndex, match: match[0] })) : []);
    const user = content.role === 'user' && requests.length === 1 ? requests[0] : undefined;
    return { content, index, ordinal: user ? ordinal++ : undefined, user };
  });
  const events = entries.flatMap((entry: any) => entry.user ? revisionIds(entry.user.text).map((id) => ({ index: entry.index, id })) : []);
  if (!events.length) {
    if (revisionIds(JSON.stringify(payload.contents)).length) throw new Error('Edited message is outside the available model context.');
    return false;
  }
  for (const event of events) {
    const revision = byId.get(event.id);
    if (!revision) throw new Error('Message edit metadata is unavailable. The original history was not changed.');
    const markerIndex = entries.findIndex((entry: any) => entry.index === event.index);
    const targetIndex = entries.findIndex((entry: any) => entry.ordinal === revision.targetOrdinal);
    const marker = entries[markerIndex], target = entries[targetIndex];
    if (!marker?.user || !target?.user || targetIndex >= markerIndex ||
      stripRevisionToken(target.user.text).trim() !== revision.originalText.trim() ||
      stripRevisionToken(marker.user.text).trim() !== revision.text.trim()) {
      throw new Error('Message edit could not be matched to the current model context. No request was sent.');
    }
    const part = marker.content.parts[marker.user.partIndex];
    const content = { ...marker.content, parts: marker.content.parts.map((value: any, index: number) => index === marker.user.partIndex
      ? { ...part, text: part.text.replace(marker.user.match, `<USER_REQUEST>\n${revision.text}\n</USER_REQUEST>`) } : value) };
    const replacement = { ...marker, content, user: { ...marker.user, text: revision.text } };
    entries = [...entries.slice(0, targetIndex), replacement, ...entries.slice(markerIndex + 1)];
  }
  payload.contents = entries.map((entry: any) => entry.content);
  return true;
}
export class MessageRevisionStore {
  private records: MessageRevision[] = [];
  constructor(private readonly filename?: string) {
    if (filename && fs.existsSync(filename)) {
      const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!Array.isArray(data)) throw new Error('Message revision store is invalid');
      this.records = data;
    }
  }
  list(conversationId?: string): MessageRevision[] { return this.records.filter((record) => !conversationId || record.conversationId === conversationId).map((record) => ({ ...record })); }
  create(input: Omit<MessageRevision, 'id' | 'createdAt'>): MessageRevision {
    if (typeof input.conversationId !== 'string' || !input.conversationId || !Number.isInteger(input.targetOrdinal) || input.targetOrdinal < 0 ||
      !Number.isInteger(input.targetStepIndex) || input.targetStepIndex < 0 || typeof input.text !== 'string' || !input.text.trim() ||
      typeof input.originalText !== 'string' || input.text.length > 100000 || input.originalText.length > 100000 ||
      /<\/?USER_REQUEST>|AGY_REVISION:/.test(input.text) || /<\/?USER_REQUEST>/.test(input.originalText)) throw new Error('This message cannot be edited safely.');
    const record = { ...input, id: randomUUID(), createdAt: Date.now() };
    const next = [...this.records, record];
    if (this.filename) {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); fs.renameSync(temporary, this.filename); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    this.records = next; return { ...record };
  }
}
let sharedStore: MessageRevisionStore | undefined;
export function getMessageRevisionStore(): MessageRevisionStore {
  if (!sharedStore) {
    const { app } = require('electron');
    sharedStore = new MessageRevisionStore(path.join(app.getPath('userData'), 'message-revisions.json'));
  }
  return sharedStore;
}
