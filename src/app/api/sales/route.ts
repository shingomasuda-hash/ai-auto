import { NextResponse } from 'next/server';
import { withOwner, readJson, str, int, badRequest } from '../../../lib/api.ts';
import { insertSales } from '../../../db/sales.ts';
import { parseJstLocalInput } from '../../../domain/time.ts';

export const POST = withOwner(async (user, request) => {
  const payload = await readJson(request);
  const errors: string[] = [];

  const externalOrderId = str(payload.externalOrderId).trim();
  if (externalOrderId === '') errors.push('注文IDは必須です。');

  const kind = str(payload.kind, 'SALE');
  if (kind !== 'SALE' && kind !== 'REFUND') errors.push('区分が不正です。');

  const productCode = str(payload.productCode).trim();
  if (productCode === '') errors.push('商品を選んでください。');

  const grossYen = int(payload.grossYen);
  if (grossYen === null || grossYen < 0) errors.push('金額は0以上の整数(円)で入力してください。');

  const feeRaw = str(payload.feeYen).trim();
  const feeYen = feeRaw === '' ? null : int(feeRaw);
  if (feeRaw !== '' && (feeYen === null || feeYen < 0)) {
    errors.push('販売手数料は0以上の整数(円)で入力してください。');
  }

  let occurredAt: Date | null = null;
  try {
    occurredAt = parseJstLocalInput(str(payload.occurredAt));
  } catch {
    errors.push('購入日時の形式が不正です。');
  }

  let settledOn: Date | null = null;
  const settledRaw = str(payload.settledOn).trim();
  if (settledRaw !== '') {
    const parsed = new Date(`${settledRaw}T00:00:00+09:00`);
    if (Number.isNaN(parsed.getTime())) errors.push('入金日の形式が不正です。');
    else settledOn = parsed;
  }

  if (errors.length > 0) return badRequest(errors);

  const { inserted, skipped } = await insertSales(
    user.id,
    [{
      externalOrderId,
      kind: kind as 'SALE' | 'REFUND',
      productCode,
      grossYen: grossYen!,
      feeYen,
      occurredAt: occurredAt!,
      settledOn,
      note: str(payload.note) || null,
    }],
    'manual',
  );

  if (inserted.length === 0) {
    return badRequest([`注文ID ${skipped[0]} はすでに登録されています。`]);
  }
  return NextResponse.json({
    id: inserted[0].id,
    message: feeYen === null
      ? '登録しました。販売手数料が未入力のため、利益は確定表示されません。'
      : '登録しました。',
  }, { status: 201 });
});
