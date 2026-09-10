import { query, queryOne } from './pool.ts';
import { recordAudit } from './audit.ts';

export type ProductRow = {
  id: string;
  owner_id: string;
  code: string;
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
  input: { code: string; name: string; priceYen: number; noteUrl: string | null; composition: string[]; isPublished: boolean },
): Promise<ProductRow> {
  const row = await queryOne<ProductRow>(
    `INSERT INTO products (owner_id, code, name, price_yen, note_url, composition, is_published)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (owner_id, code) DO UPDATE
       SET name = EXCLUDED.name,
           price_yen = EXCLUDED.price_yen,
           note_url = EXCLUDED.note_url,
           composition = EXCLUDED.composition,
           is_published = EXCLUDED.is_published,
           updated_at = now()
     RETURNING *`,
    [ownerId, input.code, input.name, input.priceYen, input.noteUrl, JSON.stringify(input.composition), input.isPublished],
  );
  await recordAudit({
    ownerId, actor: 'owner', action: 'product.upsert', targetType: 'product', targetId: input.code,
    detail: { priceYen: input.priceYen, isPublished: input.isPublished },
  });
  return row!;
}
