/** The approval box follows the chat: text pieces and tool rows share one arrival order, a card waiting for an answer is the last element of the turn, and the text that follows an approval lands below the command rows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const src = f => fileURLToPath(new URL(`../src/${f}`, import.meta.url));
const stub = fileURLToPath(new URL('./helpers/react-stub.mjs', import.meta.url));
const result = await build({ entryPoints: [src('lib/deliverables.ts')], bundle: true, format: 'esm', platform: 'node', write: false, alias: { react: stub }, logLevel: 'silent' });
const D = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

const tool = (id, state, extra = {}) => ({ id, name: id, args: {}, preview: id, effect: '', scope: 'shell', state, ...extra });

test('the timeline is the order the turn happened: text, command rows, then the text streamed after them', () => {
  let b = D.appendText(undefined, 'Let me check. ', 0);
  const rows = [{ ...tool('t1', 'done'), seq: 1 }];
  b = D.appendText(b, 'Now the next step.', 3);
  const items = D.messageTimeline([b[0], { kind: 'group', id: 'g1', closed: true, line: 'Ran a command', added: 0, removed: 0, files: [], seq: 2 }, b[1]], rows);
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
});

test('a continued text piece keeps its arrival number; a re-sent group keeps its place in the flow', () => {
  let b = D.appendText(undefined, 'Alpha. ', 4);
  b = D.appendText(b, 'More alpha.');
  assert.equal(b.length, 1);
  assert.equal(b[0].seq, 4);
  assert.equal(b[0].text, 'Alpha. More alpha.');
  b = D.upsertGroup(b, D.readGroup({ id: 'g1', closed: false, line: 'Ran a command', files: [] }), 5);
  b = D.appendText(b, 'Beta.', 6);
  b = D.upsertGroup(b, D.readGroup({ id: 'g1', closed: true, line: 'Ran 2 commands', files: [] }));
  assert.deepEqual(b.map(x => x.kind), ['text', 'group', 'text']);
  assert.equal(b[1].seq, 5, 'the re-sent group keeps the arrival number it first got');
  const items = D.messageTimeline(b, [{ ...tool('t1', 'done'), seq: 0 }]);
  assert.deepEqual(items.map(i => i.kind), ['tool', 'text', 'group', 'text'], 'the command row stays where it happened, not above everything');
});

test('the store seeds pieces from the text streamed before the first row, so later text lands below it', () => {
  const seeded = D.appendText(undefined, 'Preamble.', D.SEED_SEQ);
  const withMore = D.appendText(seeded, 'After the command.', 2);
  const items = D.messageTimeline(withMore, [{ ...tool('t1', 'done', { ask: { id: 'run', params: ['x'] } }), seq: 0 }, { ...tool('t2', 'done'), seq: 1 }]);
  assert.deepEqual(items.map(i => (i.kind === 'tool' ? i.tool.id : i.text)), ['Preamble.', 't1', 't2', 'After the command.'], 'the approval sat at the live end while it waited, and the next words continue below the rows');
});

test('Chat.tsx renders one timeline per reply and keeps the waiting card at the live end', async () => {
  const { readFile } = await import('node:fs/promises');
  const chat = await readFile(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8');
  assert.match(chat, /messageTimeline\(m\.blocks, m\.tools\)/, 'the pieces and the tool rows render as one ordered flow');
  assert.match(chat, /messageTimeline\(undefined, m\.tools\)/, 'a reply without pieces still puts its rows after the text, waiting card last');
  assert.match(chat, /data-approval-card=\{t\.id\}/, 'a waiting card stays addressable for the scroller');
});
