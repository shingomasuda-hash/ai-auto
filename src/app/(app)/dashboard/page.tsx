import { requireOwner } from '../../../lib/session.ts';
import { getSettings, listAccounts } from '../../../db/settings.ts';
import { summarizeMonth, sumExpenses } from '../../../db/sales.ts';
import { getPostCounts } from '../../../db/posts.ts';
import { getBudgetOverview, ensureEnvelopes } from '../../../db/budget.ts';
import { computeProfit, goalGap, formatYen } from '../../../domain/money.ts';
import { BUDGET_DISCLAIMER } from '../../../domain/budget.ts';
import { jstMonthKey } from '../../../domain/time.ts';
import { PageHeader, Stat, Empty } from '../_ui.tsx';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await requireOwner();
  const now = new Date();
  const monthKey = jstMonthKey(now);

  await ensureEnvelopes(user.id, monthKey);

  const [settings, accounts, monthly, expensesYen, postCounts, budget] = await Promise.all([
    getSettings(user.id),
    listAccounts(user.id),
    summarizeMonth(user.id, monthKey),
    sumExpenses(user.id, monthKey),
    getPostCounts(user.id),
    getBudgetOverview(user.id, now),
  ]);

  const { summary } = monthly;
  const profit = computeProfit({
    grossSalesYen: summary.grossSalesYen,
    refundsYen: summary.refundsYen,
    platformFeesYen: summary.feesYen,
    operatingCostsYen: expensesYen,
  });
  const gap = goalGap(profit.pretaxProfitYen, settings.monthly_goal_yen);

  const noSales = monthly.sales.length === 0;
  const disconnected = accounts.filter((a) => a.connection_mode === 'disconnected');
  const totalPosts = Object.values(postCounts).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader title="概要" description={`${monthKey}(JST)の状況`} />

      {disconnected.length > 0 && (
        <div className="notice warn">
          未接続の媒体があります: {disconnected.map((a) => (a.platform === 'x' ? 'X' : 'Threads')).join(' / ')}。
          接続するまで実際の投稿は行われません。下書きの作成と売上の手動入力は使えます。
        </div>
      )}
      {settings.global_stop && (
        <div className="notice warn">全体の処理が停止中です。送信は行われません。（設定画面で解除できます）</div>
      )}

      <div className="card">
        <h2>今月の収支<span className="sub">JST基準・整数の円</span></h2>
        {noSales ? (
          <Empty title="売上データがまだありません">
            <div className="small">
              売上は0件から始まります。手動入力かCSV取込で登録すると、ここに実績が表示されます。
            </div>
          </Empty>
        ) : (
          <div className="grid cols-4">
            <Stat label="実売上（返金差引後）" value={profit.netSalesYen}
              note={`売上 ${summary.saleCount}件 / 返金 ${summary.refundCount}件`} />
            <Stat label="販売手数料" value={summary.feesYen}
              unresolved={`${summary.missingFeeCount}件が未入力です`} />
            <Stat label="運営実費" value={expensesYen} note="登録済みの費用のみ" />
            <Stat label="税引前収支" value={profit.pretaxProfitYen}
              unresolved="販売手数料が未入力のため確定できません" />
          </div>
        )}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>目標との差<span className="sub">月次目標 {formatYen(settings.monthly_goal_yen)}</span></h2>
          {profit.pretaxProfitYen === null ? (
            <p className="small muted" style={{ margin: 0 }}>
              販売手数料が未入力のため、目標との差を確定できません。
              手数料を入力すると計算されます。
            </p>
          ) : (
            <div className="stat">
              <span className="label">税引前収支 − 目標</span>
              <span className={`value ${gap !== null && gap >= 0 ? 'pill-ok' : ''}`}>{formatYen(gap)}</span>
              <span className="note">達成時期や収益を保証するものではありません。</span>
            </div>
          )}
        </div>

        <div className="card">
          <h2>運営費<span className="sub">月次予算 {formatYen(budget.monthlyBudgetYen)}</span></h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>枠</th><th className="num">上限</th><th className="num">確定</th>
                  <th className="num">残り</th><th>状態</th>
                </tr>
              </thead>
              <tbody>
                {budget.envelopes.map((envelope) => (
                  <tr key={envelope.category}>
                    <td>{envelope.category}</td>
                    <td className="num">{formatYen(envelope.limitYen)}</td>
                    <td className="num">{formatYen(envelope.committedYen)}</td>
                    <td className="num">{formatYen(envelope.availableYen)}</td>
                    <td>
                      {envelope.exhausted ? <span className="pill-bad">上限到達</span>
                        : envelope.warn ? <span className="pill-warn">80%超</span>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {budget.unsettledCount > 0 && (
            <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>
              課金有無が不明な予約が {budget.unsettledCount} 件あります。
              提供元の明細で確認するまで枠を解放しません。
            </div>
          )}
          <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>{BUDGET_DISCLAIMER}</p>
        </div>
      </div>

      <div className="card">
        <h2>投稿の状況</h2>
        {totalPosts === 0 ? (
          <Empty title="投稿がまだありません">
            <div className="small">投稿画面から下書きを作成できます。</div>
          </Empty>
        ) : (
          <div className="grid cols-4">
            {(['DRAFT', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'UNKNOWN', 'EXPIRED'] as const)
              .filter((state) => (postCounts[state] ?? 0) > 0)
              .map((state) => (
                <div className="stat" key={state}>
                  <span className="label">{state}</span>
                  <span className="value">{postCounts[state]}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </>
  );
}
