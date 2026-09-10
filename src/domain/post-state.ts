/**
 * 投稿の共通状態遷移。
 *
 * DRAFT → APPROVED → SCHEDULED → CLAIMED → PUBLISHING → PUBLISHED
 *
 * 失敗は FAILED、送信結果が不明なら UNKNOWN、期限切れは EXPIRED。
 * UNKNOWN からは「自動で」送信側へ戻せない。外部の公開状態を照合した
 * 結果としてのみ PUBLISHED / FAILED へ落ちる。
 */

export const POST_STATES = [
  'DRAFT',
  'APPROVED',
  'SCHEDULED',
  'CLAIMED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'UNKNOWN',
  'EXPIRED',
] as const;

export type PostState = (typeof POST_STATES)[number];

export function isPostState(value: unknown): value is PostState {
  return typeof value === 'string' && (POST_STATES as readonly string[]).includes(value);
}

/** 送信が外部へ到達した可能性がある状態。ここから先は「取り消し」ができない。 */
export const IRREVERSIBLE_STATES: readonly PostState[] = ['PUBLISHING', 'PUBLISHED', 'UNKNOWN'];

/** ワーカーが取得(claim)しうる状態。 */
export const CLAIMABLE_STATES: readonly PostState[] = ['SCHEDULED'];

export type TransitionActor = 'owner' | 'worker' | 'reconciler' | 'scheduler';

type TransitionRule = {
  from: PostState;
  to: PostState;
  actors: readonly TransitionActor[];
  note: string;
};

const RULES: readonly TransitionRule[] = [
  { from: 'DRAFT', to: 'APPROVED', actors: ['owner'], note: '管理者が承認する' },
  { from: 'APPROVED', to: 'DRAFT', actors: ['owner'], note: '承認を取り消す / 本文変更で再承認待ちへ戻す' },
  { from: 'APPROVED', to: 'SCHEDULED', actors: ['owner'], note: '予約日時を設定する' },
  { from: 'SCHEDULED', to: 'APPROVED', actors: ['owner'], note: '予約を取り消す' },
  { from: 'SCHEDULED', to: 'DRAFT', actors: ['owner'], note: '本文変更で再承認待ちへ戻す' },
  { from: 'SCHEDULED', to: 'CLAIMED', actors: ['worker'], note: 'ワーカーが原子的に取得する' },
  { from: 'SCHEDULED', to: 'EXPIRED', actors: ['scheduler', 'worker'], note: '予約時刻から猶予を過ぎた' },
  { from: 'CLAIMED', to: 'PUBLISHING', actors: ['worker'], note: 'attempt を永続化して送信を開始する' },
  { from: 'CLAIMED', to: 'SCHEDULED', actors: ['worker', 'owner'], note: '送信前に claim を解放する（外部未送信）' },
  { from: 'CLAIMED', to: 'EXPIRED', actors: ['scheduler', 'worker'], note: '送信前に期限切れ' },
  { from: 'PUBLISHING', to: 'PUBLISHED', actors: ['worker'], note: '外部IDを取得できた' },
  { from: 'PUBLISHING', to: 'FAILED', actors: ['worker'], note: '外部が明確に失敗を返した（未送信が確定）' },
  { from: 'PUBLISHING', to: 'UNKNOWN', actors: ['worker', 'scheduler'], note: '送信結果が不明。再送せず隔離する' },
  { from: 'FAILED', to: 'SCHEDULED', actors: ['owner'], note: '管理者が再予約する' },
  { from: 'FAILED', to: 'DRAFT', actors: ['owner'], note: '下書きへ戻す' },
  { from: 'UNKNOWN', to: 'PUBLISHED', actors: ['reconciler', 'owner'], note: '外部で公開済みと照合できた' },
  { from: 'UNKNOWN', to: 'FAILED', actors: ['reconciler', 'owner'], note: '外部に存在しないと照合できた' },
  { from: 'EXPIRED', to: 'DRAFT', actors: ['owner'], note: '作り直す' },
  { from: 'EXPIRED', to: 'APPROVED', actors: ['owner'], note: '内容はそのままで再承認する' },
];

export type TransitionCheck =
  | { ok: true; note: string }
  | { ok: false; reason: string };

export function canTransition(from: PostState, to: PostState, actor: TransitionActor): TransitionCheck {
  if (!isPostState(from)) return { ok: false, reason: `unknown from state: ${String(from)}` };
  if (!isPostState(to)) return { ok: false, reason: `unknown to state: ${String(to)}` };
  if (from === to) return { ok: false, reason: 'no-op transition' };

  const rule = RULES.find((r) => r.from === from && r.to === to);
  if (!rule) return { ok: false, reason: `transition ${from} -> ${to} is not allowed` };
  if (!rule.actors.includes(actor)) {
    return { ok: false, reason: `actor ${actor} may not perform ${from} -> ${to}` };
  }
  return { ok: true, note: rule.note };
}

export function assertTransition(from: PostState, to: PostState, actor: TransitionActor): void {
  const check = canTransition(from, to, actor);
  if (!check.ok) throw new Error(check.reason);
}

export function allowedTransitions(from: PostState, actor: TransitionActor): PostState[] {
  return RULES.filter((r) => r.from === from && r.actors.includes(actor)).map((r) => r.to);
}

/**
 * 本文・CTA等の実質的な変更が「再承認」を必要とするか。
 * 承認済み以降の状態で内容が変わったなら必ず DRAFT へ戻す。
 */
export function requiresReapproval(current: PostState, contentChanged: boolean): boolean {
  if (!contentChanged) return false;
  return current === 'APPROVED' || current === 'SCHEDULED';
}

/** 内容を編集してよい状態か。送信中/送信済みは編集不可。 */
export function isEditable(state: PostState): boolean {
  return state === 'DRAFT' || state === 'APPROVED' || state === 'SCHEDULED' || state === 'FAILED' || state === 'EXPIRED';
}

/** 停止(kill switch)によって送信を止められる状態か。 */
export function isStoppableBeforeSend(state: PostState): boolean {
  return state === 'SCHEDULED' || state === 'CLAIMED';
}
