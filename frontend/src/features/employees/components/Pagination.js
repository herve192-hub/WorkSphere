export default function Pagination({ pagination, onPage, itemLabel = "employees" }) {
  if (!pagination || pagination.totalPages <= 1) return null;
  const { page, totalPages, totalItems } = pagination;
  return <div className="pagination"><span>Page {page} of {totalPages} · {totalItems} {itemLabel}</span><div className="actions"><button className="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button><button className="secondary" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</button></div></div>;
}
