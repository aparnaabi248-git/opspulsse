const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Read `page` / `limit` query params into a safe MongoDB skip/limit pair.
 */
const getPagination = (query = {}) => {
  const rawPage = parseInt(query.page, 10);
  const rawLimit = parseInt(query.limit, 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  return { page, limit, skip: (page - 1) * limit };
};

/**
 * Build the pagination block returned to the client.
 */
const buildPaginationMeta = ({ page, limit, total }) => {
  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
};

module.exports = { getPagination, buildPaginationMeta, DEFAULT_LIMIT, MAX_LIMIT };