import { NextResponse } from 'next/server';
import { withOwner, readJson, str, badRequest } from '../../../../lib/api.ts';
import { importSalesCsv } from '../../../../db/sales.ts';
import { isSalesChannel } from '../../../../domain/sales-import.ts';

export const POST = withOwner(async (user, request) => {
  const payload = await readJson(request);
  const csv = str(payload.csv);
  if (csv.trim() === '') return badRequest(['CSVの内容が空です。']);

  const channel = str(payload.channel, 'note');
  if (!isSalesChannel(channel)) return badRequest(['販売チャネルが不正です。']);

  try {
    const result = await importSalesCsv(user.id, csv, channel);
    return NextResponse.json(result);
  } catch (error) {
    return badRequest([error instanceof Error ? error.message : 'CSVを解釈できませんでした。']);
  }
});
