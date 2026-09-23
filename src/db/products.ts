import { query, queryOne } from './pool.ts';
import { recordAudit } from './audit.ts';

export type ProductRow = {
  id: string;
  owner_id: string;
  code: string;
  channel: 'note' | 'coconala' | 'other';
  /** digital_product: 売り切り / service: 役務提供（納期と作業が発生する） */
  kind: 'digital_product' | 'service';
  name: string;
  price_yen: number;
  note_url: string | null;
  composition: string[];
  is_published: boolean;
};

export async function listProducts(ownerId: string): Promise<ProductRow[]> {
  return query<ProductRow>(
    `SELECT * FROM products WHERE owner_id = $1 ORDER BY price_yen, code`, [ownerId],
  );
}

export async function upsertProduct(
  ownerId: string,
  input: {
    code: string; name: string; priceYen: number; noteUrl: string | null;
    composition: string[]; isPublished: boolean;
    channel?: 'note' | 'coconala' | 'other';
    kind?: 'digital_product' | 'service';
  },
): Promise<ProductRow> {
  const row = await queryOne<ProductRow>(
    `INSERT INTO products (owner_id, code, name, price_yen, note_url, composition, is_published, channel, kind)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, COALESCE($8, 'note'), COALESCE($9, 'digital_product'))
     ON CONFLICT (owner_id, code) DO UPDATE
       SET name = EXCLUDED.name,
           price_yen = EXCLUDED.price_yen,
           note_url = EXCLUDED.note_url,
           composition = EXCLUDED.composition,
           is_published = EXCLUDED.is_published,
           channel = EXCLUDED.channel,
           kind = EXCLUDED.kind,
           updated_at = now()
     RETURNING *`,
    [ownerId, input.code, input.name, input.priceYen, input.noteUrl,
     JSON.stringify(input.composition), input.isPublished, input.channel ?? null, input.kind ?? null],
  );
  await recordAudit({
    ownerId, actor: 'owner', action: 'product.upsert', targetType: 'product', targetId: input.code,
    detail: { priceYen: input.priceYen, isPublished: input.isPublished },
  });
  return row!;
}
