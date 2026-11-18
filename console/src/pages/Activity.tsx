import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  conflictFromError,
  fetchChanges,
  fetchMemoryItems,
  formatReviewAge,
  postItemAction,
} from "../api";
import type {
  AutomationStatus,
  ChangelogEntry,
  ChangeEvent,
  HookRecord,
  MemoryItem,
  Metrics,
  ReviewRecord,
} from "../types";
import {
  ACTIVITY_TYPE_LABEL,
  activitySummary,
  compareActivity,
  eventFromChange,
  eventFromChangelog,
  eventFromHook,
  eventFromReview,
  reasonCategoryLabel,
} from "./activity-model";
import type { ActivityEvent, ActivityType } from "./activity-model";
import { activityEventLink, memoryItemLink } from "./audit-links";
import {
  addItemActionLock,
  isActionLocked,
  unknownLockFor,
  unknownOutcomeChanged,
  unlockUnknownLocks,
  useItemActionLocks,
} from "./item-action-locks";
import { axisChips } from "./status-model";

interface Props {
  refreshKey: number;
  automation?: AutomationStatus;
  metrics?: Metrics;
  /** #activity/event/<id> */
  eventID?: string;
  lockScope?: string;
  onChanged: () => void;
}

const FILTERS: Array<{ id: ActivityType | "all"; label: string }> = [
  { id: "all", label: "全部事件" },
  { id: "write", label: "自动写入" },
  { id: "skip", label: "跳过" },
  { id: "failure", label: "失败" },
  { id: "revert", label: "撤销" },
  { id: "restore", label: "恢复" },
  { id: "stop", label: "停止使用" },
  { id: "review", label: "复盘" },
  { id: "maintenance", label: "维护" },
  { id: "migration", label: "迁移" },
];

export function ActivityPage({
  refreshKey,
  automation,
  metrics,
  eventID,
  lockScope,
  onChanged,
}: Props) {
  const [changes, setChanges] = useState<ChangeEvent[]>([]);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [hooks, setHooks] = useState<HookRecord[]>([]);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [missingSources, setMissingSources] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<ActivityType | "all">("all");
  const [busy, setBusy] = useState<string | undefined>();
  const actionLocks = useItemActionLocks(lockScope);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(eventID);
  const isUnknown = (itemID: string) => Boolean(unknownLockFor(actionLocks, itemID));

  const rowRefs = useRef(new Map<string, HTMLElement>());
  const selectedRef = useRef<HTMLElement | null>(null);
  const focusedEvent = useRef<string | undefined>(undefined);

  const chips = axisChips(automation);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([
      fetchChanges(300),
      api<{ items: ChangelogEntry[] }>("/api/changelog?limit=200"),
      api<{ items: ReviewRecord[] }>("/api/reviews?limit=50"),
      api<{ items: HookRecord[] }>("/api/hooks"),
      fetchMemoryItems({ includeArchived: true }),
    ]).then(([changeResult, changelogResult, reviewResult, hookResult, itemResult]) => {
      if (cancelled) return;
      const missing: string[] = [];
      // A failed source must be cleared, not left as a stale "loaded" list.
      if (changeResult.status === "fulfilled") setChanges(changeResult.value);
      else {
        setChanges([]);
        missing.push("变更账本");
      }
      if (changelogResult.status === "fulfilled") setChangelog(changelogResult.value.items);
      else {
        setChangelog([]);
        missing.push("变更日志");
      }
      if (reviewResult.status === "fulfilled") setReviews(reviewResult.value.items);
      else {
        setReviews([]);
        missing.push("复盘记录");
      }
      if (hookResult.status === "fulfilled") setHooks(hookResult.value.items);
      else {
        setHooks([]);
        missing.push("采集记录");
      }
      if (itemResult.status === "fulfilled") setItems(itemResult.value);
      else {
        setItems([]);
        missing.push("记忆条目");
      }
      setMissingSources(missing);
      setLoadError(
        changeResult.status === "rejected"
          ? errorMessage(changeResult.reason)
          : "",
      );
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!eventID) return;
    setSelected(eventID);
  }, [eventID]);

  const itemsByID = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const versions = useMemo(
    () => new Map(items.map((item) => [item.id, item.version])),
    [items],
  );

  const events = useMemo(() => {
    const rows: ActivityEvent[] = [
      ...changes.map((change) => eventFromChange(change, itemsByID, versions)),
      ...changelog
        .map((entry) => eventFromChangelog(entry))
        .filter((entry): entry is ActivityEvent => entry !== null),
      ...reviews.map((review) => eventFromReview(review)),
      ...hooks
        .map((hook) => eventFromHook(hook))
        .filter((entry): entry is ActivityEvent => entry !== null),
    ];
    const deduped = [...new Map(rows.map((event) => [event.id, event])).values()];
    return deduped.sort(compareActivity);
  }, [changes, changelog, reviews, hooks, itemsByID, versions]);

  const summary = activitySummary(events);
  const visible = useMemo(
    () => events.filter((event) => filter === "all" || event.type === filter),
    [events, filter],
  );
  const pendingUnknown = events.find(
    (event) => event.itemID && isUnknown(event.itemID),
  );

  useEffect(() => {
    if (!eventID || focusedEvent.current === eventID) return;
    const node = rowRefs.current.get(eventID);
    if (!node) return;
    focusedEvent.current = eventID;
    node.scrollIntoView({ block: "nearest" });
    selectedRef.current?.focus({ preventScroll: true });
  }, [eventID, visible]);

  async function revert(event: ActivityEvent) {
    if (
      !event.itemID ||
      !event.changeID ||
      !event.expectedVersion ||
      busy ||
      verifying ||
      isUnknown(event.itemID) ||
      isActionLocked(
        actionLocks.locks,
        event.itemID,
        "revert",
        event.expectedVersion,
        event.changeID,
      )
    ) {
      return;
    }
    setBusy(event.id);
    setError("");
    setMessage("");
    try {
      const result = await postItemAction(event.itemID, "revert", {
        expectedVersion: event.expectedVersion,
        changeID: event.changeID,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      let refreshed: MemoryItem[] | null = null;
      try {
        refreshed = await fetchMemoryItems({ includeArchived: true });
      } catch {
        refreshed = null;
      }
      if (refreshed) setItems(refreshed);
      setMessage(
        refreshed
          ? `已撤销「${event.title}」的这次变更；可回到记忆详情查看当前版本与恢复入口。`
          : `已撤销「${event.title}」的这次变更；状态刷新不可用，请刷新后再操作。`,
      );
      onChanged();
    } catch (caught: unknown) {
      const conflict = conflictFromError(caught);
      if (conflict) {
        if (event.itemID && event.expectedVersion && event.changeID) {
          addItemActionLock(lockScope, {
            itemID: event.itemID,
            action: "revert",
            version: event.expectedVersion,
            changeID: event.changeID,
            kind: "conflict",
          });
        }
        setError(
          conflict.code === "not_revertible"
            ? "该版本不可回退（可能已撤销或超期）；只能停止使用并保留现有内容。"
            : "当前已被修改，无法安全撤销；只能停止使用并保留现有内容。",
        );
      } else if (
        caught instanceof ApiError &&
        (caught.code === "OPENMEM_OUTCOME_UNKNOWN" || caught.status === 504)
      ) {
        if (event.itemID && event.expectedVersion && event.changeID) {
          addItemActionLock(lockScope, {
            itemID: event.itemID,
            action: "revert",
            version: event.expectedVersion,
            changeID: event.changeID,
            kind: "unknown",
          });
        }
        setError("操作结果未知：已停止重复提交，请先核对服务端最新版本。");
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(undefined);
    }
  }

  async function recheckUnknown(itemID: string) {
    if (verifying) return;
    const lock = unknownLockFor(actionLocks, itemID);
    if (!lock) {
      setError("核对失败：缺少本次提交前的共享锁基线，保持锁定。");
      return;
    }
    setVerifying(true);
    try {
      const rows = await fetchMemoryItems({ includeArchived: true });
      const fresh = rows.find((item) => item.id === itemID);
      if (!fresh) {
        setError("核对失败：服务端暂未返回该条目，保持锁定。");
        return;
      }
      setItems(rows);
      const changed = unknownOutcomeChanged(lock, {
        version: fresh.version,
        changeID: fresh.changeID,
      });
      unlockUnknownLocks(lockScope, itemID);
      setError("");
      setMessage(
        changed
          ? "已核对：服务端已有新版本，撤销可能已生效；请按最新状态继续。"
          : "已核对：服务端版本未变化，未确认已提交；已解除锁定。",
      );
      onChanged();
    } catch (caught: unknown) {
      setError(`核对失败：${errorMessage(caught)}；保持锁定。`);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="activity-page">
      <header className="page-head">
        <div>
          <h1>活动</h1>
          <p className="muted small">
            自动写入、跳过、失败、撤销和恢复的记录。这里不是审批台，没有“待确认”提醒。
          </p>
        </div>
        <div className="axis-chips" aria-label="运行状态（三轴独立）">
          {chips.map((chip) => (
            <span className={`axis-chip ${chip.tone}`} key={chip.key} title={chip.detail}>
              <i aria-hidden="true" />
              {chip.label}
            </span>
          ))}
        </div>
      </header>

      {loading ? <div className="empty">正在读取活动…</div> : null}
      {!loading && loadError ? (
        <div className="banner error" role="alert">
          事件流不可用：{loadError}
          <button className="btn ghost row-action" type="button" onClick={() => onChanged()}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !loadError ? (
        <>
          <div className="activity-summary" aria-label="今日事件聚合">
            <span>今日</span>
            {(
              [
                ["write", "自动写入"],
                ["skip", "跳过"],
                ["failure", "失败"],
                ["revert", "撤销"],
              ] as const
            ).map(([type, label]) => (
              <button
                key={type}
                type="button"
                className={filter === type ? "active" : ""}
                onClick={() => setFilter(type)}
              >
                {label} {summary.today[type]}
              </button>
            ))}
            <span className="spacer" />
            <span
              className="muted small"
              aria-label={`全部项目 ${metrics?.items === undefined ? "未知" : metrics.items} 条`}
            >
              全部项目 {metrics?.items === undefined ? "未知" : metrics.items} 条
            </span>
          </div>
          <p className="muted small activity-scope" role="note">
            范围：当前已加载 变更{" "}
            {missingSources.includes("变更账本") ? "未知" : changes.length}（上限 300）· 日志{" "}
            {missingSources.includes("变更日志") ? "未知" : changelog.length}（上限 200）· 复盘{" "}
            {missingSources.includes("复盘记录") ? "未知" : reviews.length}（上限 50）· 采集{" "}
            {missingSources.includes("采集记录") ? "未知" : hooks.length} 条；聚合是当前已加载/部分事件，
            不是今日完整全量。
          </p>
          {missingSources.length > 0 ? (
            <p className="banner warning" role="status">
              部分事件：{missingSources.join("、")}不可用；聚合与列表可能不完整，未用 0 次冒充完整。
            </p>
          ) : null}

          <div className="segmented activity-filters memory-segments" role="group" aria-label="事件类型筛选">
            {FILTERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={filter === entry.id}
                className={filter === entry.id ? "active" : ""}
                onClick={() => setFilter(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {message ? (
            <div className="feedback-bar" role="status">
              {message}
            </div>
          ) : null}
          {error ? (
            <div className="banner error" role="alert">
              {error}
              {pendingUnknown?.itemID ? (
                <button
                  className="btn ghost row-action"
                  type="button"
                  disabled={verifying}
                  onClick={() => void recheckUnknown(pendingUnknown.itemID!)}
                >
                  {verifying ? "核对中…" : "核对最新版本"}
                </button>
              ) : null}
            </div>
          ) : null}

          <section className="panel activity-list-panel" aria-label="事件列表">
            {visible.length === 0 ? (
              <div className="empty">
                {filter === "all"
                  ? "今天没有事件。自动写入、跳过和失败都会记录在这里。"
                  : "没有符合这个筛选的事件。"}
              </div>
            ) : null}
            <div className="activity-list">
              {visible.map((event, index) => {
                const item = event.itemID ? itemsByID.get(event.itemID) : undefined;
                const active = selected === event.id;
                const unknown = Boolean(event.itemID && isUnknown(event.itemID));
                const revertLocked = Boolean(
                  event.itemID &&
                    event.expectedVersion &&
                    event.changeID &&
                    isActionLocked(
                      actionLocks.locks,
                      event.itemID,
                      "revert",
                      event.expectedVersion,
                      event.changeID,
                    ),
                );
                const day = dayKey(event.at);
                const newDay = index === 0 || dayKey(visible[index - 1].at) !== day;
                return (
                  <Fragment key={event.id}>
                  {newDay ? (
                    <h3 className="activity-day-head">{dayLabel(event.at)}</h3>
                  ) : null}
                  <article
                    className={`activity-row${active ? " active" : ""}`}
                    key={event.id}
                    ref={(node) => {
                      if (node) rowRefs.current.set(event.id, node);
                      else rowRefs.current.delete(event.id);
                    }}
                  >
                    <time className="activity-time" dateTime={event.at} title={event.at}>
                      {formatReviewAge(event.at)}
                    </time>
                    <span className={`badge activity-type ${event.type}`}>
                      {ACTIVITY_TYPE_LABEL[event.type]}
                    </span>
                    <div className="activity-main">
                      {event.itemID && item ? (
                        <a
                          className="activity-object"
                          href={memoryItemLink(event.itemID)}
                          ref={(node) => { if (active) selectedRef.current = node; }}
                          onClick={() => setSelected(event.id)}
                        >
                          {item.title}
                        </a>
                      ) : event.itemID ? (
                        <span className="activity-object muted" ref={(node) => { if (active) selectedRef.current = node; }} tabIndex={active ? -1 : undefined}>
                          对象已不存在 · {event.itemID.slice(0, 12)}
                        </span>
                      ) : event.reviewID ? (
                        <a
                          className="activity-object"
                          href={`#settings/advanced/review`}
                          ref={(node) => { if (active) selectedRef.current = node; }}
                        >
                          {event.title}
                        </a>
                      ) : (
                        <span className="activity-object muted" ref={(node) => { if (active) selectedRef.current = node; }}>
                          {item?.title ?? event.title}
                        </span>
                      )}
                      {event.reasonCategory && (event.type === "skip" || event.type === "failure") ? (
                        <span className="chip activity-reason-chip">
                          原因类别：{reasonCategoryLabel(event.reasonCategory)}
                        </span>
                      ) : null}
                      <details className="activity-reason">
                        <summary>{event.reason || "未记录原因"}</summary>
                        <p>
                          {event.reason || "该事件源没有记录原因，无法补造。"}
                          {event.reasonCategory
                            ? ` · 类别：${reasonCategoryLabel(event.reasonCategory)}`
                            : ""}
                        </p>
                      </details>
                      <span className="muted small">
                        来源 {event.sourceLabel}
                        {event.subtype ? ` · ${event.subtype}` : ""}
                      </span>
                    </div>
                    <span className={`activity-result ${event.result}`}>
                      {event.type === "skip"
                        ? "未写入"
                        : event.result === "success"
                          ? "成功"
                          : event.result === "failure"
                            ? "失败"
                            : "未知"}
                    </span>
                    <div className="activity-actions">
                      {unknown && event.itemID ? (
                        <button
                          className="btn ghost row-action"
                          type="button"
                          disabled={verifying}
                          onClick={() => void recheckUnknown(event.itemID!)}
                        >
                          {verifying ? "核对中…" : "核对"}
                        </button>
                      ) : event.revertible &&
                      event.changeID &&
                      event.expectedVersion &&
                      item?.latestChange?.id === event.id &&
                      !revertLocked ? (
                        <button
                          className="btn ghost row-action"
                          type="button"
                          disabled={busy !== undefined || verifying}
                          onClick={() => void revert(event)}
                        >
                          {busy === event.id ? "撤销中…" : "撤销"}
                        </button>
                      ) : event.itemID ? (
                        <a className="link-action" href={memoryItemLink(event.itemID)}>
                          {revertLocked ? "去停止使用" : "查看"}
                        </a>
                      ) : event.type === "maintenance" || event.type === "migration" ? (
                        <a className="link-action" href="#settings/advanced/history">
                          查看历史
                        </a>
                      ) : (
                        <a className="link-action" href={activityEventLink(event.id)}>
                          查看
                        </a>
                      )}
                    </div>
                  </article>
                  </Fragment>
                );
              })}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function dayKey(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    : "unknown";
}

function dayLabel(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })
    : "日期未知";
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}
