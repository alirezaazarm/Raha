"""Helpers for turning cumulative panel counters into per-run deltas."""

from __future__ import annotations


def compute_usage_delta(
    snapshot: dict | None, usage_up: float, usage_down: float
) -> tuple[float, float, str, bool]:
    """Compute the per-run traffic delta from a stored usage snapshot.

    Returns ``(delta_up_bytes, delta_down_bytes, previous_status, first_seen)``.

    The panel exposes cumulative lifetime counters per client.  When no
    snapshot exists (a brand new client *or* an existing one whose key/UUID
    was regenerated) the current counters are treated as the baseline and the
    delta is zero.  Treating the previous value as zero in that case would
    attribute the whole lifetime traffic to a single hour and produce the
    doubled/overshot days.
    """
    if snapshot is None:
        return 0.0, 0.0, "active", True

    prev_up = float(snapshot.get("usage_up", 0.0) or 0.0)
    prev_down = float(snapshot.get("usage_down", 0.0) or 0.0)
    prev_status = snapshot.get("client_status", "active") or "active"
    return (
        max(0.0, usage_up - prev_up),
        max(0.0, usage_down - prev_down),
        prev_status,
        False,
    )
