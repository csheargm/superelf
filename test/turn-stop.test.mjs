// lib/turn-stop.mjs — the handle and registry behind the composer's Stop · 停止 button (F4-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTurnCancel, cancelOnClose, createTurnStops } from '../lib/turn-stop.mjs';

test('stop() aborts the signal', () => {
  const c = createTurnCancel();
  assert.equal(c.signal.aborted, false);
  c.stop();
  assert.equal(c.signal.aborted, true);
});

test('the registry stops only the named user\'s conversation, and only once', () => {
  const s = createTurnStops();
  const a = createTurnCancel(), b = createTurnCancel();
  s.register('mom', 'c1', a); s.register('kid', 'c1', b);
  assert.equal(s.stop('kid', 'nope'), false, 'an unknown conversation stops nothing');
  assert.equal(s.stop('mom', 'c1'), true);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false, 'CONTROL: another user\'s turn in a same-named convo runs on');
  assert.equal(s.stop('mom', 'c1'), false, 'idempotent');
});

test('unregister removes only its own handle', () => {
  const s = createTurnStops();
  const a = createTurnCancel(), b = createTurnCancel();
  const offA = s.register('u', 'c', a); s.register('u', 'c', b);
  offA();
  assert.equal(s.size(), 1, 'the newer turn stays stoppable');
  assert.equal(s.stop('u', 'c'), true); assert.equal(b.signal.aborted, true);
});

test('cancelOnClose fires on a close before the end, never after it', () => {
  const res = new EventEmitter(); res.writableEnded = false;
  const c = cancelOnClose(res); res.emit('close');
  assert.equal(c.signal.aborted, true);
  const done = new EventEmitter(); done.writableEnded = true;
  const d = cancelOnClose(done); done.emit('close');
  assert.equal(d.signal.aborted, false);
});
