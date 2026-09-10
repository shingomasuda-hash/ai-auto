import type { PoolClient } from 'pg';
import { getPool, withTransaction } from './pool.ts';
import type { BudgetCategory, EnvelopeState, PricingStatus, ReservationDecision } from '../domain/budget.ts';
import { DEFAULT_ENVELOPES, DEFAULT_MONTHLY_BUDGET_YEN, decideReservation, settle, viewEnvelope } from '../domain/budget.ts';
import { jstMonthKey } from '../domain/time.ts';

export type ReservationRow = {
  id: string;
  owner_id: string;
  month_key: string;
  category: BudgetCategory;
  state: 'RESERVED' | 'SETTLED' | 'RELEASED' | 'UNSETTLED';
  reserved_yen: number;
  settled_yen: number;
  purpose: string;
  note: string;
};

/** 月次の枠を用意する。存在すれば何もしない。 */
export async function ensureEnvelopes(
  ownerId: string,
  monthKey: string,
  limits: Readonly<Record<BudgetCategory, number>> = DEFAULT_ENVELOPES,
  client?: PoolClient,
): Promise<void> {
  const runner = client ?? getPool();
  for (const [category, limitYen] of Object.entries(limits)) {
    await runner.query(
      `INSERT INTO budget_envelopes (owner_id, month_key, category, limit_yen)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, month_key, category) DO NOTHING`,
      [ownerId, monthKey, category, limitYen],
    );
  }
}

/**
 * 枠の現況を読む。
 * committed = 固定費 + 精算済み + 未精算の予約(RESERVED/UNSETTLED)。
 */
async function loadEnvelope(
  client: PoolClient,
  ownerId: string,
  monthKey: string,
  category: BudgetCategory,
  lock: boolean,
): Promise<EnvelopeState | null> {
  const { rows } = await client.query<{ limit_yen: number; fixed_yen: number }>(
    `SELECT limit_yen, fixed_yen FROM budget_envelopes
      WHERE owner_id = $1 AND month_key = $2 AND category = $3
      ${lock ? 'FOR UPDATE' : ''}`,
    [ownerId, monthKey, category],
  );
  if (rows.length === 0) return null;

  const { rows: sums } = await client.query<{ settled: string; reserved: string }>(
    `SELECT
       COALESCE(SUM(settled_yen) FILTER (WHERE state = 'SETTLED'), 0)::text AS settled,
       COALESCE(SUM(reserved_yen) FILTER (WHERE state IN ('RESERVED', 'UNSETTLED')), 0)::text AS reserved
     FROM budget_reservations
     WHERE owner_id = $1 AND month_key = $2 AND category = $3`,
    [ownerId, monthKey, category],
  );

  return {
    category,
    limitYen: rows[0].limit_yen,
    fixedYen: rows[0].fixed_yen,
    settledYen: Number(sums[0].settled),
    reservedYen: Number(sums[0].reserved),
  };
}

/** 月全体で確定している額(固定費+精算済み+未精算予約)。 */
async function loadMonthCommitted(client: PoolClient, ownerId: string, monthKey: string): Promise<number> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT (
       COALESCE((SELECT SUM(fixed_yen) FROM budget_envelopes
                  WHERE owner_id = $1 AND month_key = $2), 0)
     + COALESCE((SELECT SUM(settled_yen) FROM budget_reservations
                  WHERE owner_id = $1 AND month_key = $2 AND state = 'SETTLED'), 0)
     + COALESCE((SELECT SUM(reserved_yen) FROM budget_reservations
                  WHERE owner_id = $1 AND month_key = $2 AND state IN ('RESERVED', 'UNSETTLED')), 0)
     )::text AS total`,
    [ownerId, monthKey],
  );
  return Number(rows[0].total);
}

export type ReserveInput = {
  ownerId: string;
  category: BudgetCategory;
  pricing: PricingStatus;
  retryFactor: number;
  purpose: string;
  refId?: string | null;
  /** 同じ鍵での二重予約を防ぐ。 */
  idempotencyKey: string;
  now?: Date;
  monthlyBudgetYen?: number;
};

export type ReserveResult =
  | { ok: true; reservation: ReservationRow; reusedExisting: boolean }
  | { ok: false; decision: Exclude<ReservationDecision, { allowed: true }> };

/**
 * 有料呼出しの「前」に最大見込額を予約する。
 *
 * 同一の(owner, month, category)の枠行を FOR UPDATE でロックしてから
 * 残高を数えるので、並行して予約しても枠を超えない。
 */
export async function reserveBudget(input: ReserveInput): Promise<ReserveResult> {
  const now = input.now ?? new Date();
  const monthKey = jstMonthKey(now);
  const monthlyBudgetYen = input.monthlyBudgetYen ?? DEFAULT_MONTHLY_BUDGET_YEN;

  return withTransaction(async (client) => {
    const existing = await client.query<ReservationRow>(
      `SELECT * FROM budget_reservations WHERE owner_id = $1 AND idempotency_key = $2`,
      [input.ownerId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      return { ok: true, reservation: existing.rows[0], reusedExisting: true };
    }

    // 枠行のロックで、この (owner, month, category) の予約を直列化する。
    const envelope = await loadEnvelope(client, input.ownerId, monthKey, input.category, true);
    if (!envelope) {
      return {
        ok: false,
        decision: {
          allowed: false,
          code: 'pricing_unknown',
          reason: `${monthKey} の予算枠(${input.category})が未設定です。`,
        },
      };
    }

    const monthCommittedYen = await loadMonthCommitted(client, input.ownerId, monthKey);
    const decision = decideReservation({
      envelope,
      monthCommittedYen,
      monthlyBudgetYen,
      pricing: input.pricing,
      retryFactor: input.retryFactor,
    });

    if (!decision.allowed) return { ok: false, decision };

    const { rows } = await client.query<ReservationRow>(
      `INSERT INTO budget_reservations
         (owner_id, month_key, category, reserved_yen, purpose, ref_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.ownerId,
        monthKey,
        input.category,
        decision.reserveYen,
        input.purpose,
        input.refId ?? null,
        input.idempotencyKey,
      ],
    );
    return { ok: true, reservation: rows[0], reusedExisting: false };
  });
}

export type SettleOutcome =
  | { kind: 'success'; actualYen: number }
  | { kind: 'failed_not_charged' }
  | { kind: 'failed_unknown' };

/**
 * 予約を精算する。
 * 課金有無が不明な失敗では予約を解放せず UNSETTLED として保持する。
 */
export async function settleReservation(reservationId: string, outcome: SettleOutcome): Promise<ReservationRow> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<ReservationRow>(
      `SELECT * FROM budget_reservations WHERE id = $1 FOR UPDATE`,
      [reservationId],
    );
    const reservation = rows[0];
    if (!reservation) throw new Error(`予約が見つかりません: ${reservationId}`);
    if (reservation.state !== 'RESERVED') return reservation;

    const result = settle({ reservedYen: reservation.reserved_yen, outcome });

    const { rows: updated } = await client.query<ReservationRow>(
      `UPDATE budget_reservations
          SET state = $2,
              settled_yen = $3,
              reserved_yen = $4,
              settled_at = now(),
              note = $5
        WHERE id = $1
        RETURNING *`,
      [
        reservationId,
        result.state,
        result.settledYen,
        // UNSETTLED は予約額を保持し続ける。RELEASED/SETTLED は予約を消す。
        result.state === 'UNSETTLED' ? result.heldYen : 0,
        result.note,
      ],
    );
    return updated[0];
  });
}

export type BudgetOverview = {
  monthKey: string;
  monthlyBudgetYen: number;
  monthCommittedYen: number;
  envelopes: ReturnType<typeof viewEnvelope>[];
  unsettledCount: number;
};

export async function getBudgetOverview(
  ownerId: string,
  now: Date = new Date(),
  monthlyBudgetYen: number = DEFAULT_MONTHLY_BUDGET_YEN,
): Promise<BudgetOverview> {
  const monthKey = jstMonthKey(now);
  return withTransaction(async (client) => {
    const envelopes = [];
    for (const category of Object.keys(DEFAULT_ENVELOPES) as BudgetCategory[]) {
      const state = await loadEnvelope(client, ownerId, monthKey, category, false);
      if (state) envelopes.push(viewEnvelope(state));
    }
    const monthCommittedYen = await loadMonthCommitted(client, ownerId, monthKey);
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM budget_reservations
        WHERE owner_id = $1 AND month_key = $2 AND state = 'UNSETTLED'`,
      [ownerId, monthKey],
    );
    return {
      monthKey,
      monthlyBudgetYen,
      monthCommittedYen,
      envelopes,
      unsettledCount: Number(rows[0].count),
    };
  });
}
