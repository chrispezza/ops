import { type BoardCard, type BoardColumn, PR_AGE_BAR_MAX_DAYS } from "../../core/board";
import { Dot, formatSignalValue, safeHref } from "../components";

export interface BoardFilters {
  owner?: string;
  category?: string;
  q?: string;
}

// A derived kanban (ux §2.8): five columns computed from stored severity,
// nothing draggable. Moving a card means changing the system of record —
// the card's link goes straight there — and the next poll moves it.
export function BoardPage(props: { columns: BoardColumn[]; filters: BoardFilters; owners: string[]; now: number }) {
  const f = props.filters;
  const total = props.columns.reduce((n, c) => n + c.cards.length, 0);
  return (
    <>
      <form class="filters" hx-get="/board" hx-target="#board" hx-select="#board" hx-swap="outerHTML" hx-push-url="true">
        <input type="search" name="q" placeholder="filter… ( / )" value={f.q ?? ""} aria-label="filter entities" />
        <select name="owner" aria-label="owner">
          <option value="">all owners</option>
          {props.owners.map((o) => (
            <option value={o} selected={f.owner === o}>
              {o}
            </option>
          ))}
        </select>
        <select name="category" aria-label="category">
          <option value="">all categories</option>
          {["static_site", "web_app", "plugin_skill", "tooling", "client_project", "vendor_api"].map((c) => (
            <option value={c} selected={f.category === c}>
              {c}
            </option>
          ))}
        </select>
        <button type="submit">apply</button>
      </form>
      <div id="board">
        {total === 0 ? (
          <p class="hint">
            No cards. Either nothing needs attention and nothing moved this week, or the filters are too tight. Cards arrive
            with the hourly GitHub poll.
          </p>
        ) : (
          <div class="board">
            {props.columns.map((col) => (
              <Column column={col} now={props.now} />
            ))}
          </div>
        )}
        <p class="hint">
          Columns are derived from stored severity on every load — the same bands as /findings, at issue and PR granularity.
          Nothing here is draggable: relabel the issue, merge the PR or fix the build on GitHub and the next poll moves the
          card. Dependabot PRs appear only for major bumps or after 30 days.
        </p>
      </div>
    </>
  );
}

function Column(props: { column: BoardColumn; now: number }) {
  const { column } = props;
  return (
    <section class={`column column-${column.key}`} aria-labelledby={`col-${column.key}`}>
      <h2 id={`col-${column.key}`}>
        {column.title} <span class="rollup num">{column.cards.length}</span>
      </h2>
      <p class="column-why">{column.why}</p>
      {column.cards.length === 0 ? (
        <p class="hint">empty</p>
      ) : (
        <ul class="cards">
          {column.cards.map((card) => (
            <Card card={card} now={props.now} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Card(props: { card: BoardCard; now: number }) {
  const { card } = props;
  const href = safeHref(card.url);
  // value_text is the explanation when there is one ("2 high · 2 moderate/low");
  // otherwise the same formatting every other view uses, never a raw number
  const value = card.signal ? (card.signal.value_text ?? formatSignalValue(card.signal, props.now)) : undefined;
  const detail = [card.detail, value].filter(Boolean).join(" · ");
  return (
    <li class={`card card-${card.kind}`} data-sev={card.severity}>
      <div class="card-head">
        <Dot severity={card.severity} />
        <a class="card-entity" href={`/e/${card.entityId}`}>
          {card.entityName}
        </a>
        <span class="card-kind">{card.kind === "activity" ? "push" : card.kind}</span>
      </div>
      <div class="card-title">{href ? <a href={href}>{card.title}</a> : card.title}</div>
      {detail && <div class="card-detail">{detail}</div>}
      {card.kind === "pr" && card.ageDays != null && <AgeBar days={card.ageDays} severity={card.severity} draft={card.draft} />}
    </li>
  );
}

// PR age as a bar against a 30-day scale — the length is the message, the
// number under it is the recovery. Inline SVG, no chart library (ux §2.3).
export function AgeBar(props: { days: number; severity: number; draft?: boolean }) {
  const w = 120;
  const h = 4;
  const fill = Math.max(2, Math.round((Math.min(props.days, PR_AGE_BAR_MAX_DAYS) / PR_AGE_BAR_MAX_DAYS) * w));
  return (
    <svg class="agebar" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`open ${props.days} days of ${PR_AGE_BAR_MAX_DAYS}`}>
      <title>open {props.days}d · bar scales to {PR_AGE_BAR_MAX_DAYS}d</title>
      <rect class="agebar-track" x="0" y="0" width={w} height={h} />
      <rect class={props.draft ? "agebar-fill draft" : "agebar-fill"} data-sev={props.severity} x="0" y="0" width={fill} height={h} />
    </svg>
  );
}
