'use strict';

const PAGE_SIZE = 20;
const MAX_PAGE = 500;

function parseQuery(query) {
  const city = typeof query.city === 'string' ? query.city.trim() : '';
  const page = query.page === undefined ? 1 : Number(query.page);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    return { error: `Paramètre "page" invalide (entier entre 1 et ${MAX_PAGE})` };
  }
  return { city, page };
}

function createListingsHandler(db) {
  return async function listingsHandler(req, res, next) {
    const parsed = parseQuery(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { city, page } = parsed;

    try {
      const { rows } = await db.query(
        `SELECT * FROM listings WHERE city = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [city, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE],
      );

      const hasMore = rows.length > PAGE_SIZE;
      const listings = rows.slice(0, PAGE_SIZE);

      if (listings.length === 0) {
        return res.json({ items: [], page, pageSize: PAGE_SIZE, hasMore: false });
      }

      const listingIds = listings.map((l) => l.id);
      const agencyIds = [...new Set(listings.map((l) => l.agency_id).filter((id) => id != null))];

      const [agenciesResult, photosResult] = await Promise.all([
        agencyIds.length
          ? db.query('SELECT * FROM agencies WHERE id = ANY($1)', [agencyIds])
          : Promise.resolve({ rows: [] }),
        db.query('SELECT listing_id, url FROM photos WHERE listing_id = ANY($1) ORDER BY listing_id, id', [listingIds]),
      ]);

      const agenciesById = new Map(agenciesResult.rows.map((a) => [a.id, a]));
      const photosByListing = new Map();
      for (const photo of photosResult.rows) {
        if (!photosByListing.has(photo.listing_id)) photosByListing.set(photo.listing_id, []);
        photosByListing.get(photo.listing_id).push(photo.url);
      }

      const items = listings.map(({ agency_id, ...listing }) => ({
        ...listing,
        agency: agenciesById.get(agency_id) || null,
        photos: photosByListing.get(listing.id) || [],
      }));

      return res.json({ items, page, pageSize: PAGE_SIZE, hasMore });
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { createListingsHandler, parseQuery, PAGE_SIZE };
