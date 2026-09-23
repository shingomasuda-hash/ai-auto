import { requireOwner } from '../../../lib/session.ts';
import { listProducts } from '../../../db/products.ts';
import { listSales, summarizeMonth } from '../../../db/sales.ts';
import { formatYen } from '../../../domain/money.ts';
import { formatJst, jstMonthKey } from '../../../domain/time.ts';
import { CHANNEL_LABELS } from '../../../domain/sales-import.ts';
import { PageHeader, Empty } from '../_ui.tsx';
import SalesForms from './SalesForms.tsx';

export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const user = await requireOwner();
  const monthKey = jstMonthKey(new Date());

  const [products, sales, monthly] = await Promise.all([
    listProducts(user.id),
    listSales(user.id, 100),
    summarizeMonth(user.id, monthKey),
  ]);

  return (
    <>
      <PageHeader title="商品 / 売上" description="チャネルごとの商品と、手動入力・CSV取込による売上" />

      <div className="card">
        <h2>商品</h2>
        {products.length === 0 ? (
          <Empty title="商品が登録されていません">
            <div className="small">
              seed スクリプトで販売案（Starter / 全10本）を投入できます。価格の変更と公開は手動操作のみです。
            </div>
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>チャネル</th><th>コード</th><th>名称</th><th className="num">価格</th>
                  <th>構成</th><th>商品ページ</th><th>公開</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <span className="badge">{CHANNEL_LABELS[product.channel]}</span>
                      {product.kind === 'service' && (
                        <span className="badge" style={{ marginLeft: 4 }}>役務</span>
                      )}
                    </td>
                    <td className="mono">{product.code}</td>
                    <td>{product.name}</td>
                    <td className="num">{formatYen(product.price_yen)}</td>
                    <td className="small">
                      {product.composition.length > 0 ? product.composition.join(' / ') : '—'}
                    </td>
                    <td className="small">
                      {product.note_url
                        ? <a href={product.note_url} target="_blank" rel="noreferrer">開く</a>
                        : <span className="muted">未設定</span>}
                    </td>
                    <td>{product.is_published ? '公開' : <span className="muted">非公開</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
          全10本にはStarterの3本が含まれます。すでにStarterを購入した方へ二重購入を勧めないでください。
        </p>
      </div>

      <div className="card">
        <h2>今月の売上<span className="sub">{monthKey}(JST)</span></h2>
        <div className="grid cols-4">
          <div className="stat">
            <span className="label">売上（総額）</span>
            <span className="value">{formatYen(monthly.summary.grossSalesYen)}</span>
            <span className="note">{monthly.summary.saleCount}件</span>
          </div>
          <div className="stat">
            <span className="label">返金</span>
            <span className="value">{formatYen(monthly.summary.refundsYen)}</span>
            <span className="note">{monthly.summary.refundCount}件</span>
          </div>
          <div className="stat">
            <span className="label">販売手数料</span>
            <span className={`value${monthly.summary.feesYen === null ? ' muted' : ''}`}>
              {monthly.summary.feesYen === null ? '未確定' : formatYen(monthly.summary.feesYen)}
            </span>
            {monthly.summary.missingFeeCount > 0 && (
              <span className="note">{monthly.summary.missingFeeCount}件が未入力</span>
            )}
          </div>
          <div className="stat">
            <span className="label">入金済み</span>
            <span className="value">
              {monthly.sales.filter((s) => s.settled_on !== null).length}
              <span className="small muted"> / {monthly.sales.length}</span>
            </span>
            <span className="note">入金日は売上計上日と区別しています</span>
          </div>
        </div>
      </div>

      {monthly.byChannel.length > 1 && (
        <div className="card">
          <h2>チャネル別の内訳<span className="sub">事業の軸が別なので合計とは分けて見る</span></h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>チャネル</th><th className="num">売上</th><th className="num">返金</th>
                  <th className="num">手数料</th><th className="num">件数</th>
                </tr>
              </thead>
              <tbody>
                {monthly.byChannel.map((row) => (
                  <tr key={row.channel}>
                    <td>{CHANNEL_LABELS[row.channel]}</td>
                    <td className="num">{formatYen(row.grossSalesYen)}</td>
                    <td className="num">
                      {row.refundsYen === 0 ? <span className="muted">—</span> : formatYen(row.refundsYen)}
                    </td>
                    <td className="num">
                      {row.feesYen === null
                        ? <span className="muted">未確定</span>
                        : formatYen(row.feesYen)}
                    </td>
                    <td className="num">{row.saleCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <SalesForms
        products={products.map((p) => ({
          code: p.code, name: p.name, priceYen: p.price_yen, channel: p.channel,
        }))}
      />

      <div className="card">
        <h2>売上の明細</h2>
        {sales.length === 0 ? (
          <Empty title="売上がまだありません">
            <div className="small">0件から始まります。上のフォームで手動入力するか、CSVを取り込んでください。</div>
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>チャネル</th><th>注文ID</th><th>区分</th><th>商品</th>
                  <th className="num">金額</th><th className="num">手数料</th>
                  <th>購入日時 (JST)</th><th>入金日</th><th>取込元</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((sale) => (
                  <tr key={sale.id}>
                    <td><span className="badge">{CHANNEL_LABELS[sale.channel]}</span></td>
                    <td className="mono">{sale.external_order_id}</td>
                    <td>
                      <span className="badge">{sale.kind === 'REFUND' ? '返金' : '売上'}</span>
                    </td>
                    <td className="small">{sale.product_code}</td>
                    <td className="num">{formatYen(sale.gross_yen)}</td>
                    <td className="num">
                      {sale.fee_yen === null ? <span className="muted">未入力</span> : formatYen(sale.fee_yen)}
                    </td>
                    <td className="small">{formatJst(sale.occurred_at)}</td>
                    <td className="small">
                      {sale.settled_on ? formatJst(sale.settled_on) : <span className="muted">未入金</span>}
                    </td>
                    <td className="small muted">{sale.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
