/**
 * The approval box follows the chat: text pieces, activity lines and command rows share one arrival
 * order, a card waiting for an answer is the last element of the turn, the text that follows an
 * answer lands below the command rows, and the rows are drawn whether or not the bubble can hold them
 * (a waiting card that is not in the document leaves the agent waiting on an answer nobody can see).
 * The Chat.tsx checks read the source: this suite has no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const src = f => fileURLToPath(new URL(`../src/${f}`, import.meta.url));
const stub = fileURLToPath(new URL('./helpers/react-stub.mjs', import.meta.url));
const result = await build({ entryPoints: [src('lib/deliverables.ts')], bundle: true, format: 'esm', platform: 'node', write: false, alias: { react: stub }, logLevel: 'silent' });
const D = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

const tool = (id, state, extra = {}) => ({ id, name: id, args: {}, preview: id, effect: '', scope: 'shell', state, ...extra });
const group = (id, line, extra = {}) => D.readGroup({ id, closed: true, line, files: [], ...extra });

test('the flow is the order the turn happened: text, the rows that followed, then the text streamed after them', () => {
  const rows = [{ ...tool('t1', 'done'), seq: 1 }];
  let b = D.appendText(undefined, 'Let me check. ', 0);
  b = D.upsertGroup(b, group('g1', 'Ran a command'), 2);
  b = D.appendText(b, 'Now the next step.', D.afterSeq({ blocks: b, tools: rows }));
  const items = D.messageTimeline(b, rows);
  assert.deepEqual(items.map(i => i.kind), ['text', 'tool', 'group', 'text']);
});

test('a card waiting for an answer is the last element of the turn even when later pieces exist', () => {
  const ask = tool('a1', 'proposed', { ask: { id: 'run', params: ['make'] } });
  const items = D.messageTimeline(
    [{ kind: 'text', text: 'Before.', seq: 0 }, { kind: 'text', text: 'After.', seq: 5 }],
    [ask, { ...tool('t1', 'done'), seq: 1 }]);
  assert.deepEqual(items.map(i => (i.kind === 'tool' ? i.tool.id : i.text)), ['Before.', 't1', 'After.', 'a1']);
  assert.deepEqual(items.filter(i => i.kind === 'tool').map(i => i.tool.id), ['t1', 'a1']);
});

test('rows saved before the order was kept fall back to the old look: tools first, in their stored order; a waiting card still last', () => {
  const ask = tool('a1', 'proposed', { ask: { id: 'run', params: ['ls'] } });
  const items = D.messageTimeline([{ kind: 'text', text: 'Answer.' }], [tool('t1', 'done'), ask]);
  assert.deepEqual(items.map(i => (i.kind === 'tool' ? i.tool.id : i.text)), ['t1', 'Answer.', 'a1'], 'the finished row keeps the old place before the answer; the waiting card moves to the end');
  const two = D.messageTimeline([{ kind: 'text', text: 'Answer.' }], [tool('t1', 'done'), tool('t2', 'done')]);
  assert.deepEqual(two.map(i => (i.kind === 'tool' ? i.tool.id : i.text)), ['t1', 't2', 'Answer.'], 'unnumbered rows keep the order they were saved in, not the reverse');
});

test('a token continues the piece it belongs to, and only a row or a line in between starts a new one', () => {
  const rows = [{ ...tool('t1', 'done'), seq: 0 }];
  let b = D.seedBlocks('Let me check. ');
  assert.equal(b[0].seq, D.SEED_SEQ, 'what streamed before the first row sits before every row');
  b = D.appendText(b, 'Now ', D.afterSeq({ blocks: b, tools: rows }));
  const started = b.length;
  const key = b.at(-1).pid;
  for (const token of ['the ', 'next ', 'step.'])
    b = D.appendText(b, token, D.afterSeq({ blocks: b, tools: rows }));
  assert.equal(b.length, started, 'three tokens, one piece: a piece per token would remake the reply for every token');
  assert.equal(b.at(-1).text, 'Now the next step.');
  assert.equal(b.at(-1).pid, key, 'the piece keeps its key, so a re-sort does not remount the pieces after it');
  b = D.upsertGroup(b, group('g1', 'Ran 2 commands'), D.nextSeq({ blocks: b, tools: rows }));
  b = D.appendText(b, 'Below the line.', D.afterSeq({ blocks: b, tools: rows }));
  assert.deepEqual(b.map(x => x.kind), ['text', 'text', 'group', 'text'], 'an activity line in between starts a new piece below it');
  const items = D.messageTimeline(b, rows);
  assert.deepEqual(items.map(i => (i.kind === 'tool' ? i.tool.id : i.kind)), ['text', 't1', 'text', 'group', 'text'], 'the row stays where it happened, not above everything, and the words after it read below it');
});

test('the store seeds pieces from the text streamed before the first row, so later text lands below it', () => {
  const rows = [{ ...tool('t1', 'done', { ask: { id: 'run', params: ['x'] } }), seq: 0 }, { ...tool('t2', 'done'), seq: 1 }];
  const seeded = D.seedBlocks('Preamble.');
  const withMore = D.appendText(seeded, 'After the command.', D.afterSeq({ blocks: seeded, tools: rows }));
  const items = D.messageTimeline(withMore, rows);
  assert.deepEqual(items.map(i => (i.kind === 'tool' ? i.tool.id : i.text)), ['Preamble.', 't1', 't2', 'After the command.'], 'the approval sat at the live end while it waited, and the next words continue below the rows');
});

test('a turn whose text has not started still carries its waiting card', () => {
  // The real frame order: the first command finishes and opens an activity group, only then does the
  // agent ask — so pieces exist, m.content is still empty, and the bubble that holds text is hidden.
  const rows = [{ ...tool('t1', 'done'), seq: 0 }, { ...tool('a1', 'proposed', { ask: { id: 'run', params: ['rm -r build'] } }), seq: 1 }];
  const b = D.upsertGroup(undefined, group('g1', 'Ran a command'), D.nextSeq({ blocks: undefined, tools: [rows[0]] }));
  const items = D.messageTimeline(b, rows);
  assert.equal(items.at(-1).kind, 'tool', 'the card the agent waits on is in the flow, at its end');
  assert.equal(items.at(-1).tool.id, 'a1');
  assert.ok(D.waitingApproval(rows[1]) && !D.waitingApproval(rows[0]), 'one rule says which cards are waiting');
});

test('Chat.tsx draws the rows where the bubble cannot hide them, and keeps the waiting card at the live end', async () => {
  const { readFile } = await import('node:fs/promises');
  const chat = await readFile(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8');
  assert.match(chat, /const flow = messageTimeline\(m\.blocks, m\.tools\)/, 'the pieces, lines and rows make one ordered flow');
  assert.doesNotMatch(chat, /messageTimeline\(undefined, m\.tools\)/, 'one flow, ordered once, not a second ordering for the fallback');
  assert.match(chat, /const bubble = !demoHidden && \(/, 'the bubble has its own condition, apart from the rows');
  assert.match(chat, /flowInBubble \? null : flow\.map\(it => it\.kind === 'tool'/, 'when the flow cannot sit inside the bubble its rows and lines are drawn after it');
  assert.match(chat, /\.filter\(waitingApproval\)/, 'the scroller uses the same waiting rule as the flow');
  assert.match(chat, /data-approval-card=\{t\.id\}/, 'a waiting card stays addressable for the scroller');
});
