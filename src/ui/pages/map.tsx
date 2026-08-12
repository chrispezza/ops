import type { ArchivedEntity, EntityView } from "../../core/queries";
import { Chip, Dot, formatSignalValue, newIssueUrl, timeAgo } from "../components";
import type { TriageRow } from "./triage";

const SECTIONS: { category: string; title: string }[] = [
  { category: "static_site", title: "Static Sites" },
  { category: "web_app", title: "Web Apps" },
  { category: "plugin_skill", title: "Plugins · MCPs · Skills" },
  { category: "tooling", title: "Tools · Templates · Experiments" },
  { category: "client_project", title: "Client Projects" },
];

export function MapPage(props: {
  rows: TriageRow[];
  archived: ArchivedEntity[];
  q?: string;
  owner?: string;
  owners: string[];
  now: number;
}) {
  const { rows, now } = props;
  if (rows.length === 0 && !props.q && !props.owner) return <SetupChecklist />;

  const known = new Set(SECTIONS.map((s) => s.category));
  // Portfolio sections hold repos; vendor/spend entities get their own section;
  // "tag these repos" only ever applies to actual repos (spec §2.4).
  const vendors = rows.filter((r) => r.view.category === "vendor_api");
  const untagged = rows.filter((r) => r.view.kind === "repo" && (!r.view.category || !known.has(r.view.category)));
  const other = rows.filter(
    (r) => r.view.kind !== "repo" && r.view.category !== "vendor_api" && !known.has(r.view.category ?? ""),
  );

  return (
    <>
      <form class="filters" hx-get="/" hx-target="#map-region" hx-select="#map-region" hx-swap="outerHTML" hx-push-url="true">
        <input type="search" name="q" placeholder="filter… ( / )" value={props.q ?? ""} />
        <button type="submit">apply</button>
        {/* ux §1: owner is a first-class map param */}
        <span class="owner-toggle">
          <a href={props.q ? `/?q=${encodeURIComponent(props.q)}` : "/"} class={!props.owner ? "active" : ""}>
            all
          </a>
          {props.owners.map((o) => (
            <a
              href={`/?owner=${encodeURIComponent(o)}${props.q ? `&q=${encodeURIComponent(props.q)}` : ""}`}
              class={props.owner === o ? "active" : ""}
            >
              {o}
            </a>
          ))}
        </span>
      </form>
      <AttentionStrip rows={rows} />
      <div id="map-region">
        {SECTIONS.map((s) => (
          <Section
            title={s.title}
            // individual skills would flood the one-screen map: repos and
            // plugins get rows, skills roll up into the section header
            rows={rows.filter((r) => r.view.category === s.category && r.view.kind !== "skill")}
            now={now}
            hint={`No ${s.title.toLowerCase()} yet — tag repos with the matching topic.`}
            rollup={s.category === "plugin_skill" ? skillsRollup(rows) : undefined}
            note={uptimeHint(s.category, rows)}
          />
        ))}
        {vendors.length > 0 && <Section title="Vendor APIs & Keys" rows={vendors} now={now} />}
        {untagged.length > 0 && (
          <Section
            title="Uncategorized"
            rows={untagged}
            now={now}
            warning="tag these repos with a topic: static-site · web-app · mcp · skill"
          />
        )}
        {other.length > 0 && <Section title="Other" rows={other} now={now} />}
        {props.archived.length > 0 && (
          <details class="section archived-section">
            <summary>
              Archived <span class="rollup num">{props.archived.length}</span>
            </summary>
            <table class="rows">
              {props.archived
                .filter((a) => !props.owner || a.owner === props.owner)
                .map((a) => (
                  <tr class="row" data-href={`/e/${a.id}`}>
                    <td class="c-dot">
                      <Dot severity={0} />
                    </td>
                    <td class="c-name">
                      <a href={`/e/${a.id}`}>{a.name}</a>
                    </td>
                    <td class="c-kind">
                      {a.category ?? a.kind}
                      {a.owner && <span class="owner"> · {a.owner}</span>}
                    </td>
                  </tr>
                ))}
            </table>
          </details>
        )}
      </div>
    </>
  );
}

// The daily question answered in zero clicks: top scorers, right at the top.
function AttentionStrip(props: { rows: TriageRow[] }) {
  const top = [...props.rows].sort((a, b) => b.score.total - a.score.total).filter((r) => r.score.total > 0).slice(0, 3);
  if (top.length === 0) return null;
  return (
    <p class="attention">
      <span class="attention-label">needs attention</span>
      {top.map((r) => (
        <a href={`/e/${r.view.id}`}>
          <Dot severity={r.view.maxSeverity} /> {r.view.name} <span class="num">{r.score.total}</span>
        </a>
      ))}
      <a href="/triage" class="attention-more">
        triage →
      </a>
    </p>
  );
}

// Teach the Website-field enrollment exactly when it applies: a deployed-site
// section containing repos with no uptime signal.
function uptimeHint(category: string, rows: TriageRow[]): string | undefined {
  if (category !== "static_site" && category !== "web_app") return undefined;
  const inSection = rows.filter((r) => r.view.category === category);
  if (inSection.length === 0 || !inSection.some((r) => !r.view.latest["site.up"])) return undefined;
  return "repos with a Website field on GitHub get uptime monitoring";
}

// ux §2.1: skills section header rolls up skill inventory + 30d invocations.
function skillsRollup(rows: TriageRow[]): string | undefined {
  const parts: string[] = [];
  const skills = rows.filter((r) => r.view.category === "plugin_skill" && r.view.kind === "skill");
  if (skills.length > 0) {
    const flagged = skills.filter((r) => r.view.maxSeverity >= 1).length;
    parts.push(`${skills.length} skills${flagged > 0 ? ` (${flagged} flagged)` : ""}`);
  }
  const sums = rows.filter((r) => r.view.category === "plugin_skill" && r.usage30d != null);
  if (sums.length > 0) parts.push(`Σ ${sums.reduce((total, r) => total + (r.usage30d ?? 0), 0)} invocations 30d`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function Section(props: {
  title: string;
  rows: TriageRow[];
  now: number;
  hint?: string;
  warning?: string;
  rollup?: string;
  note?: string;
}) {
  const { title, rows, now } = props;
  const problems = rows.filter((r) => r.view.maxSeverity >= 2).length;
  return (
    <section class={props.warning ? "section warn" : "section"}>
      <h2>
        {title} <span class="rollup num">{rows.length}</span>
        {problems > 0 && <span class="rollup num sev">{problems} ▲</span>}
        {props.rollup && <span class="rollup num">{props.rollup}</span>}
        {props.warning && <span class="rollup warn-text">{props.warning}</span>}
      </h2>
      {/* ux §3: empty sections render with hint text, not omitted — the IA stays stable */}
      {rows.length === 0 ? (
        <p class="hint">{props.hint}</p>
      ) : (
        <>
          <table class="rows">
            {rows.map((r) => (
              <Row row={r} now={now} />
            ))}
          </table>
          {props.note && <p class="hint">{props.note}</p>}
        </>
      )}
    </section>
  );
}

function Row(props: { row: TriageRow; now: number }) {
  const { view: e, score } = props.row;
  return (
    <tr class="row" data-href={`/e/${e.id}`}>
      <td class="c-dot">
        <Dot severity={e.maxSeverity} />
      </td>
      <td class="c-name">
        <a href={`/e/${e.id}`}>{e.name}</a>
      </td>
      <td class="c-kind">
        {e.category ?? e.kind}
        {e.owner && <span class="owner"> · {e.owner}</span>}
      </td>
      <td class="c-chips">
        <Chips row={props.row} now={props.now} />
      </td>
      <td class="num">{score.total > 0 ? score.total : ""}</td>
      <td class="c-links">
        {e.source_url && <a href={e.source_url}>↗</a>}
        {/* pre-filled new-issue is a repo affordance — meaningless on vendor consoles */}
        {e.kind === "repo" && e.source_url && <a href={newIssueUrl(e.source_url)}>+issue</a>}
      </td>
    </tr>
  );
}

// Per-category chip sets, hardcoded v1 (ux §6 decision: move to config only if they churn).
function Chips(props: { row: TriageRow; now: number }) {
  const { view: e, usage30d } = props.row;
  const { now } = props;
  const l = e.latest;
  const pushed = (
    <Chip label="pushed" signal={l["repo.pushed_at"]} now={now} render={(s) => timeAgo(s.value_num ?? 0, now)} />
  );
  // site.up appears only for repos with a deployed homepage — not expected of
  // every repo, so absence renders nothing rather than a warning dash
  const site = l["site.up"] && (
    <Chip label="site" signal={l["site.up"]} now={now} render={(s) => (s.value_num === 1 ? "up" : "DOWN")} />
  );
  const branches = l["repo.branches"] && <Chip label="br" signal={l["repo.branches"]} now={now} />;
  switch (e.category) {
    case "static_site":
      return (
        <>
          {site}
          <Chip label="LHCI" signal={l["lhci.performance"]} now={now} />
          {branches}
          {pushed}
        </>
      );
    case "web_app":
      return (
        <>
          {site}
          <Chip label="CI" signal={l["ci.status"]} now={now} render={(s) => (s.value_text === "success" ? "✓" : (s.value_text ?? "?"))} />
          <Chip label="vulns" signal={l["deps.vuln_count"]} now={now} render={(s) => String(s.value_num ?? 0)} />
          <Chip label="PRs" signal={l["prs.open"]} now={now} />
          {branches}
          {pushed}
        </>
      );
    case "tooling":
      return (
        <>
          <Chip label="issues" signal={l["issues.open"]} now={now} />
          {branches}
          {pushed}
        </>
      );
    case "plugin_skill":
      if (e.kind === "plugin") {
        return (
          <>
            <Chip label="skills" signal={l["manifest.skill_count"]} now={now} />
            <Chip label="manifest" signal={l["manifest.description"]} now={now} />
          </>
        );
      }
      return (
        <>
          {/* interval metric: 30d SUM, never the latest row (spec §2.2) */}
          {usage30d == null ? (
            <span class="chip missing" title="usage 30d: no data">
              usage 30d —
            </span>
          ) : (
            <span class="chip" title="invocations, 30d sum">
              usage 30d {usage30d}
            </span>
          )}
          {pushed}
        </>
      );
    case "vendor_api": {
      if (e.kind === "worker") {
        return <Chip label="errors" signal={l["cf.error_rate"]} now={now} render={(s) => formatSignalValue(s, now)} />;
      }
      if (e.kind === "database") {
        return <Chip label="size" signal={l["d1.size_bytes"]} now={now} render={(s) => formatSignalValue(s, now)} />;
      }
      const anomaly = l["spend.anomaly"];
      const budget = l["budget.status"];
      return (
        <>
          {anomaly && anomaly.severity >= 2 && <Chip label="anomaly" signal={anomaly} now={now} render={(s) => formatSignalValue(s, now)} />}
          {budget && budget.severity >= 2 && <Chip label="budget" signal={budget} now={now} render={(s) => formatSignalValue(s, now)} />}
          <a href="/spend" class="chip">
            spend →
          </a>
        </>
      );
    }
    default:
      return (
        <>
          <Chip label="issues" signal={l["issues.open"]} now={now} />
          <Chip label="PRs" signal={l["prs.open"]} now={now} />
          {branches}
          {pushed}
        </>
      );
  }
}

// ux §3: first-run empty state teaches setup
export function SetupChecklist() {
  return (
    <div class="empty-state">
      <strong>No data yet.</strong> To fill this dashboard:
      <ol>
        <li>
          Set secrets: <code>wrangler secret put GITHUB_PAT</code>
        </li>
        <li>
          Set <code>GITHUB_OWNERS</code> in wrangler.jsonc vars
        </li>
        <li>Tag repos with topics: static-site · web-app · mcp · skill</li>
        <li>
          Wait for the hourly cron, or trigger a poll from <a href="/health">/health</a>
        </li>
      </ol>
    </div>
  );
}
