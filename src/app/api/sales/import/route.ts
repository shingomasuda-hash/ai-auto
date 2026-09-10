import { NextResponse } from 'next/server';
import { withOwner, readJson, str, badRequest } from '../../../../lib/api.ts';
import { importSalesCsv } from '../../../../db/sales.ts';

export const POST = withOwner(async (user, request) => {
  const payload = await readJson(request);
  const csv = str(payload.csv);
  if (csv.trim() === '') return badRequest(['CSVの内容が空です。']);

  try {
    const result = await importSalesCsv(user.id, csv);
    return NextResponse.json(result);
  } catch (error) {
    return badRequest([error instanceof Error ? error.message : 'CSVを解釈できませんでした。']);
  }
});
