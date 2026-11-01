import { describe, expect, it } from 'vitest';
import { MessageRevisionStore, rewriteRevisionHistory, revisionToken } from '../messageRevisions';
const user = (text: string) => ({ role: 'user', parts: [{ text: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>` }] });
const model = (text: string) => ({ role: 'model', parts: [{ text }] });
function fixture() { const store = new MessageRevisionStore(); const envelope = { request: { contents: [user('same'), model('first answer'), user('same'), model('second answer')] } }; return { store, envelope }; }
describe('logical message replacements', () => {
  it('targets the requested occurrence and replaces the prompt without changing native history or files', () => {
    const { store, envelope } = fixture(); const original = structuredClone(envelope.request.contents);
    const revision = store.create({ conversationId: 'conversation', targetOrdinal: 1, targetStepIndex: 2, originalText: 'same', text: 'edited' });
    envelope.request.contents.push(user(`edited\n\n${revisionToken(revision.id)}`));
    expect(rewriteRevisionHistory(envelope, store.list())).toBe(true);
    expect(envelope.request.contents).toHaveLength(3);
    expect(envelope.request.contents[0]).toEqual(original[0]); expect(envelope.request.contents[1]).toEqual(original[1]);
    expect(envelope.request.contents[2].parts[0].text).toContain('<USER_REQUEST>\nedited\n</USER_REQUEST>');
    expect(JSON.stringify(envelope)).not.toContain('AGY_REVISION');
    expect(original[2].parts[0].text).toContain('same');
  });
  it('reapplies revisions to future requests and supports editing the replacement again', () => {
    const { store, envelope } = fixture();
    const first = store.create({ conversationId: 'c', targetOrdinal: 0, targetStepIndex: 0, originalText: 'same', text: 'new' });
    envelope.request.contents.push(user(`new\n\n${revisionToken(first.id)}`), model('replacement answer'));
    const second = store.create({ conversationId: 'c', targetOrdinal: 2, targetStepIndex: 4, originalText: 'new', text: 'new again' });
    envelope.request.contents.push(user(`new again\n\n${revisionToken(second.id)}`), model('final answer'), user('continue'));
    rewriteRevisionHistory(envelope, store.list());
    expect(envelope.request.contents).toHaveLength(3);
    expect(envelope.request.contents[0].parts[0].text).toContain('new again');
    expect(envelope.request.contents[1].parts[0].text).toBe('final answer');
    expect(envelope.request.contents[2].parts[0].text).toContain('continue');
  });
  it('refuses unmatched, missing or compacted targets without mutating the envelope', () => {
    const { store, envelope } = fixture();
    const revision = store.create({ conversationId: 'c', targetOrdinal: 1, targetStepIndex: 2, originalText: 'different text', text: 'edit' });
    envelope.request.contents.push(user(`edit\n\n${revisionToken(revision.id)}`));
    const original = structuredClone(envelope);
    expect(() => rewriteRevisionHistory(envelope, store.list())).toThrow('could not be matched'); expect(envelope).toEqual(original);
    expect(() => rewriteRevisionHistory(envelope, [])).toThrow('unavailable');
    expect(() => rewriteRevisionHistory({ contents: [{ role: 'user', parts: [{ text: revisionToken(revision.id) }] }] }, store.list())).toThrow('outside');
  });
  it('implements retry as replacement of the same user turn rather than a second copy in model context', () => {
    const { store, envelope } = fixture();
    const revision = store.create({ conversationId: 'c', targetOrdinal: 1, targetStepIndex: 2, originalText: 'same', text: 'same' });
    envelope.request.contents.push(user(`same\n\n${revisionToken(revision.id)}`)); rewriteRevisionHistory(envelope, store.list());
    expect(envelope.request.contents).toHaveLength(3); expect(JSON.stringify(envelope)).not.toContain('second answer');
  });
});
