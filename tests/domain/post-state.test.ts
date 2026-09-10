import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition, assertTransition, allowedTransitions, requiresReapproval,
  isEditable, isStoppableBeforeSend, POST_STATES, IRREVERSIBLE_STATES,
} from '../../src/domain/post-state.ts';
import type { PostState, TransitionActor } from '../../src/domain/post-state.ts';

test('正常系の一本道が通る', () => {
  assert.equal(canTransition('DRAFT', 'APPROVED', 'owner').ok, true);
  assert.equal(canTransition('APPROVED', 'SCHEDULED', 'owner').ok, true);
  assert.equal(canTransition('SCHEDULED', 'CLAIMED', 'worker').ok, true);
  assert.equal(canTransition('CLAIMED', 'PUBLISHING', 'worker').ok, true);
  assert.equal(canTransition('PUBLISHING', 'PUBLISHED', 'worker').ok, true);
});

test('段飛ばしを許さない', () => {
  assert.equal(canTransition('DRAFT', 'SCHEDULED', 'owner').ok, false);
  assert.equal(canTransition('DRAFT', 'PUBLISHED', 'owner').ok, false);
  assert.equal(canTransition('APPROVED', 'PUBLISHING', 'worker').ok, false);
  assert.equal(canTransition('SCHEDULED', 'PUBLISHED', 'worker').ok, false);
});

test('UNKNOWN からは自動で再送しない', () => {
  // 照合の結果としてのみ確定する
  assert.equal(canTransition('UNKNOWN', 'PUBLISHED', 'reconciler').ok, true);
  assert.equal(canTransition('UNKNOWN', 'FAILED', 'reconciler').ok, true);
  // 送信側へは戻せない
  assert.equal(canTransition('UNKNOWN', 'SCHEDULED', 'owner').ok, false);
  assert.equal(canTransition('UNKNOWN', 'SCHEDULED', 'worker').ok, false);
  assert.equal(canTransition('UNKNOWN', 'CLAIMED', 'worker').ok, false);
  assert.equal(canTransition('UNKNOWN', 'PUBLISHING', 'worker').ok, false);
  assert.equal(canTransition('UNKNOWN', 'DRAFT', 'owner').ok, false);
});

test('PUBLISHED は終端', () => {
  for (const to of POST_STATES) {
    for (const actor of ['owner', 'worker', 'reconciler', 'scheduler'] as TransitionActor[]) {
      assert.equal(canTransition('PUBLISHED', to, actor).ok, false, `PUBLISHED -> ${to} (${actor})`);
    }
  }
});

test('ワーカーは承認や予約をできない', () => {
  assert.equal(canTransition('DRAFT', 'APPROVED', 'worker').ok, false);
  assert.equal(canTransition('APPROVED', 'SCHEDULED', 'worker').ok, false);
});

test('所有者はワーカーの claim を代行できない', () => {
  assert.equal(canTransition('SCHEDULED', 'CLAIMED', 'owner').ok, false);
});

test('期限切れは所有者が作り直すまで送信側へ戻らない', () => {
  assert.deepEqual(allowedTransitions('EXPIRED', 'owner').sort(), ['APPROVED', 'DRAFT']);
  assert.deepEqual(allowedTransitions('EXPIRED', 'worker'), []);
});

test('assertTransition は不正遷移で例外', () => {
  assert.throws(() => assertTransition('PUBLISHED', 'DRAFT', 'owner'), /not allowed/);
  assert.throws(() => assertTransition('DRAFT', 'DRAFT', 'owner'), /no-op/);
});

test('承認後の内容変更は再承認が必要', () => {
  assert.equal(requiresReapproval('APPROVED', true), true);
  assert.equal(requiresReapproval('SCHEDULED', true), true);
  assert.equal(requiresReapproval('DRAFT', true), false);
  assert.equal(requiresReapproval('APPROVED', false), false);
});

test('送信中・送信済みは編集できない', () => {
  for (const state of ['PUBLISHING', 'PUBLISHED', 'CLAIMED', 'UNKNOWN'] as PostState[]) {
    assert.equal(isEditable(state), false, state);
  }
  for (const state of ['DRAFT', 'APPROVED', 'SCHEDULED', 'FAILED', 'EXPIRED'] as PostState[]) {
    assert.equal(isEditable(state), true, state);
  }
});

test('停止で止められるのは送信前だけ', () => {
  assert.equal(isStoppableBeforeSend('SCHEDULED'), true);
  assert.equal(isStoppableBeforeSend('CLAIMED'), true);
  for (const state of IRREVERSIBLE_STATES) {
    assert.equal(isStoppableBeforeSend(state), false, state);
  }
});
