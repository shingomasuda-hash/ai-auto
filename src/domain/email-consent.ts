/**
 * メール配信の同意管理。
 *
 * 条件:
 *  - 明示同意 → 確認後にはじめて登録が有効になる（double opt-in）。
 *  - 確認用の GET だけで登録を有効化しない。確認は POST で行う。
 *  - 解除は配信停止中でも常に有効。
 *  - 未確認・解除済みへは送らない。
 *  - 同一ステップの重複配信を防ぐ（DB側にも一意制約を張る）。
 */

export const SUBSCRIBER_STATES = ['PENDING', 'CONFIRMED', 'UNSUBSCRIBED', 'BOUNCED'] as const;
export type SubscriberState = (typeof SUBSCRIBER_STATES)[number];

export type ConsentRecord = {
  state: SubscriberState;
  /** 同意時に記録した文言のバージョン。 */
  consentTextVersion: string | null;
  consentedAt: Date | null;
  confirmedAt: Date | null;
  unsubscribedAt: Date | null;
};

export type ConsentEvent =
  | { type: 'subscribe'; at: Date; consentTextVersion: string }
  /** 確認リンクを開いただけ（GET）。状態は変えない。 */
  | { type: 'confirm_page_viewed'; at: Date }
  /** 確認ボタンを押した（POST）。 */
  | { type: 'confirm'; at: Date }
  | { type: 'unsubscribe'; at: Date }
  | { type: 'bounce'; at: Date };

export type ConsentApplyResult = {
  record: ConsentRecord;
  changed: boolean;
  reason: string;
};

export function initialConsent(): ConsentRecord {
  return {
    state: 'PENDING',
    consentTextVersion: null,
    consentedAt: null,
    confirmedAt: null,
    unsubscribedAt: null,
  };
}

export function applyConsentEvent(record: ConsentRecord, event: ConsentEvent): ConsentApplyResult {
  switch (event.type) {
    case 'subscribe': {
      // 解除済みの人が再度同意した場合は PENDING からやり直す。
      if (record.state === 'CONFIRMED') {
        return { record, changed: false, reason: 'すでに確認済みです。' };
      }
      return {
        record: {
          state: 'PENDING',
          consentTextVersion: event.consentTextVersion,
          consentedAt: event.at,
          confirmedAt: null,
          unsubscribedAt: null,
        },
        changed: true,
        reason: '確認メールを送ります。',
      };
    }

    case 'confirm_page_viewed': {
      // GET では絶対に状態を変えない。
      return { record, changed: false, reason: '確認ページの表示のみ。登録は有効化しません。' };
    }

    case 'confirm': {
      if (record.state === 'UNSUBSCRIBED') {
        return { record, changed: false, reason: '解除済みのため確認できません。' };
      }
      if (record.state === 'BOUNCED') {
        return { record, changed: false, reason: '配信不能のため確認できません。' };
      }
      if (record.state === 'CONFIRMED') {
        return { record, changed: false, reason: 'すでに確認済みです。' };
      }
      if (record.consentedAt === null) {
        return { record, changed: false, reason: '同意の記録がありません。' };
      }
      return {
        record: { ...record, state: 'CONFIRMED', confirmedAt: event.at },
        changed: true,
        reason: '登録を有効化しました。',
      };
    }

    case 'unsubscribe': {
      // 停止中でも、未確認でも、常に受け付ける。
      if (record.state === 'UNSUBSCRIBED') {
        return { record, changed: false, reason: 'すでに解除済みです。' };
      }
      return {
        record: { ...record, state: 'UNSUBSCRIBED', unsubscribedAt: event.at },
        changed: true,
        reason: '配信を解除しました。',
      };
    }

    case 'bounce': {
      if (record.state === 'UNSUBSCRIBED') {
        return { record, changed: false, reason: '解除済みのため変更しません。' };
      }
      return { record: { ...record, state: 'BOUNCED' }, changed: true, reason: '配信不能として記録しました。' };
    }
  }
}

/** 送信してよい相手か。 */
export function canReceive(record: ConsentRecord): boolean {
  return record.state === 'CONFIRMED';
}

export type DeliveryGateInput = {
  record: ConsentRecord;
  /** すでに配信済みのステップキー一覧。 */
  deliveredSteps: ReadonlySet<string>;
  stepKey: string;
  /** メール配信の停止フラグ。 */
  emailStop: boolean;
  /** 送信先が許可済みテスト宛先か（テストモード時に使う）。 */
  testMode: boolean;
  allowedTestRecipients: ReadonlySet<string>;
  email: string;
};

export type DeliveryGateResult =
  | { allowed: true }
  | {
      allowed: false;
      code: 'not_confirmed' | 'unsubscribed' | 'already_delivered' | 'stopped' | 'test_recipient_not_allowed';
      message: string;
    };

export function evaluateDeliveryGate(input: DeliveryGateInput): DeliveryGateResult {
  if (input.record.state === 'UNSUBSCRIBED') {
    return { allowed: false, code: 'unsubscribed', message: '解除済みの宛先には送信しません。' };
  }
  if (!canReceive(input.record)) {
    return { allowed: false, code: 'not_confirmed', message: '未確認の宛先には送信しません。' };
  }
  if (input.deliveredSteps.has(input.stepKey)) {
    return { allowed: false, code: 'already_delivered', message: `ステップ ${input.stepKey} は配信済みです。` };
  }
  if (input.emailStop) {
    return { allowed: false, code: 'stopped', message: 'メール配信が停止されています。' };
  }
  if (input.testMode && !input.allowedTestRecipients.has(input.email.toLowerCase())) {
    return {
      allowed: false,
      code: 'test_recipient_not_allowed',
      message: 'テストモードでは指定されたテスト宛先以外へ送信しません。',
    };
  }
  return { allowed: true };
}

/** 解除は停止中でも受け付ける、という不変条件を明示する。 */
export function unsubscribeIsAlwaysAvailable(): true {
  return true;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  return normalized.length <= 254 && EMAIL_PATTERN.test(normalized);
}
