import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialConsent, applyConsentEvent, canReceive, evaluateDeliveryGate, isValidEmail, normalizeEmail,
} from '../../src/domain/email-consent.ts';
import type { ConsentRecord } from '../../src/domain/email-consent.ts';

const t0 = new Date('2026-04-01T00:00:00Z');
const t1 = new Date('2026-04-01T01:00:00Z');

function subscribed(): ConsentRecord {
  return applyConsentEvent(initialConsent(), { type: 'subscribe', at: t0, consentTextVersion: 'v1' }).record;
}
function confirmed(): ConsentRecord {
  return applyConsentEvent(subscribed(), { type: 'confirm', at: t1 }).record;
}

test('同意しただけでは配信できない', () => {
  const record = subscribed();
  assert.equal(record.state, 'PENDING');
  assert.equal(canReceive(record), false);
});

test('確認ページのGETでは登録が有効化されない', () => {
  const result = applyConsentEvent(subscribed(), { type: 'confirm_page_viewed', at: t1 });
  assert.equal(result.changed, false);
  assert.equal(result.record.state, 'PENDING');
  assert.equal(canReceive(result.record), false);
});

test('確認(POST)で有効化される', () => {
  const record = confirmed();
  assert.equal(record.state, 'CONFIRMED');
  assert.equal(record.confirmedAt?.toISOString(), t1.toISOString());
  assert.equal(canReceive(record), true);
});

test('同意の記録がないまま確認できない', () => {
  const result = applyConsentEvent(initialConsent(), { type: 'confirm', at: t1 });
  assert.equal(result.changed, false);
  assert.equal(result.record.state, 'PENDING');
});

test('解除は未確認でも受け付ける', () => {
  const result = applyConsentEvent(subscribed(), { type: 'unsubscribe', at: t1 });
  assert.equal(result.record.state, 'UNSUBSCRIBED');
});

test('解除済みは確認しても復活しない', () => {
  const unsub = applyConsentEvent(confirmed(), { type: 'unsubscribe', at: t1 }).record;
  const result = applyConsentEvent(unsub, { type: 'confirm', at: t1 });
  assert.equal(result.changed, false);
  assert.equal(result.record.state, 'UNSUBSCRIBED');
  assert.equal(canReceive(result.record), false);
});

test('解除済みが再同意したら PENDING からやり直す', () => {
  const unsub = applyConsentEvent(confirmed(), { type: 'unsubscribe', at: t1 }).record;
  const again = applyConsentEvent(unsub, { type: 'subscribe', at: t1, consentTextVersion: 'v2' }).record;
  assert.equal(again.state, 'PENDING');
  assert.equal(again.unsubscribedAt, null);
  assert.equal(canReceive(again), false);
});

const gateBase = {
  deliveredSteps: new Set<string>(),
  stepKey: 'step-1',
  emailStop: false,
  testMode: false,
  allowedTestRecipients: new Set<string>(),
  email: 'owner@example.com',
};

test('未確認・解除済みへは送らない', () => {
  const pending = evaluateDeliveryGate({ ...gateBase, record: subscribed() });
  assert.equal(pending.allowed === false && pending.code, 'not_confirmed');
  const unsub = applyConsentEvent(confirmed(), { type: 'unsubscribe', at: t1 }).record;
  const result = evaluateDeliveryGate({ ...gateBase, record: unsub });
  assert.equal(result.allowed === false && result.code, 'unsubscribed');
});

test('同一ステップを二度配信しない', () => {
  const result = evaluateDeliveryGate({
    ...gateBase,
    record: confirmed(),
    deliveredSteps: new Set(['step-1']),
  });
  assert.equal(result.allowed === false && result.code, 'already_delivered');
});

test('配信停止中は送らないが、解除は常に有効', () => {
  const stopped = evaluateDeliveryGate({ ...gateBase, record: confirmed(), emailStop: true });
  assert.equal(stopped.allowed === false && stopped.code, 'stopped');
  // 停止中でも解除は状態を変える
  const result = applyConsentEvent(confirmed(), { type: 'unsubscribe', at: t1 });
  assert.equal(result.changed, true);
  assert.equal(result.record.state, 'UNSUBSCRIBED');
});

test('テストモードでは指定宛先以外へ送らない', () => {
  const blocked = evaluateDeliveryGate({ ...gateBase, record: confirmed(), testMode: true });
  assert.equal(blocked.allowed === false && blocked.code, 'test_recipient_not_allowed');
  const allowed = evaluateDeliveryGate({
    ...gateBase,
    record: confirmed(),
    testMode: true,
    allowedTestRecipients: new Set(['owner@example.com']),
  });
  assert.equal(allowed.allowed, true);
});

test('条件が揃えば配信できる', () => {
  assert.deepEqual(evaluateDeliveryGate({ ...gateBase, record: confirmed() }), { allowed: true });
});

test('バウンスは配信対象から外す', () => {
  const bounced = applyConsentEvent(confirmed(), { type: 'bounce', at: t1 }).record;
  assert.equal(canReceive(bounced), false);
});

test('メールアドレスの検証と正規化', () => {
  assert.equal(normalizeEmail('  Owner@Example.COM '), 'owner@example.com');
  assert.equal(isValidEmail('owner@example.com'), true);
  assert.equal(isValidEmail('owner@example'), false);
  assert.equal(isValidEmail('owner example.com'), false);
  assert.equal(isValidEmail(''), false);
});
