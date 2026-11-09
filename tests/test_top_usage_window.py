"""Tests for rolling-window top-user usage ranking and delta baselines."""

import logging
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from app.utils.usage import compute_usage_delta

logging.disable(logging.CRITICAL)

GB = 1024 ** 3


class AsyncCursor:
    """Minimal async cursor that supports ``async for``."""

    def __init__(self, docs):
        self._docs = list(docs)

    def __aiter__(self):
        self._iter = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


def _hourly(entries):
    buckets = [{"u": 0.0, "d": 0.0} for _ in range(24)]
    for hour, up, down in entries:
        buckets[hour] = {"u": up, "d": down}
    return buckets


def _db_with(config_docs, user_docs):
    db = MagicMock()
    db.config_usages = MagicMock()
    db.config_usages.find.return_value = AsyncCursor(config_docs)
    db.users = MagicMock()
    db.users.find.return_value = AsyncCursor(user_docs)
    return db


def _today_midnight():
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)


# ──────────────────────────────────────────────────────────────────────────────
# Delta baseline
# ──────────────────────────────────────────────────────────────────────────────

class TestComputeUsageDelta:
    def test_missing_snapshot_seeds_baseline_without_counting_lifetime(self):
        delta_up, delta_down, prev_status, first_seen = compute_usage_delta(
            None, usage_up=300 * GB, usage_down=900 * GB
        )

        assert (delta_up, delta_down) == (0.0, 0.0)
        assert prev_status == "active"
        assert first_seen is True

    def test_existing_snapshot_counts_only_new_bytes(self):
        snapshot = {"usage_up": 5 * GB, "usage_down": 7 * GB, "client_status": "active"}

        delta_up, delta_down, prev_status, first_seen = compute_usage_delta(
            snapshot, usage_up=6 * GB, usage_down=9 * GB
        )

        assert delta_up == 1 * GB
        assert delta_down == 2 * GB
        assert prev_status == "active"
        assert first_seen is False

    def test_counter_reset_never_produces_negative_delta(self):
        snapshot = {"usage_up": 10 * GB, "usage_down": 10 * GB}

        delta_up, delta_down, _, _ = compute_usage_delta(
            snapshot, usage_up=1 * GB, usage_down=2 * GB
        )

        assert delta_up == 0.0
        assert delta_down == 0.0


# ──────────────────────────────────────────────────────────────────────────────
# /admin/users/top rolling filters
# ──────────────────────────────────────────────────────────────────────────────

async def _call_top(db, filter_name, limit=5):
    from app.routers.admin import get_top_users

    return await get_top_users(
        filter=filter_name,
        limit=limit,
        _admin=MagicMock(telegram_id=999),
        db=db,
        settings=MagicMock(),
    )


class TestRollingTopUsers:
    @pytest.mark.asyncio
    async def test_1d_only_counts_last_24_hours(self):
        today = _today_midnight()
        docs = [
            {"email": "111-alice", "date": today, "hourly_usage": _hourly([(0, 5.0, 1.0)])},
            {
                "email": "111-alice",
                "date": today - timedelta(days=2),
                "hourly_usage": _hourly([(0, 100.0, 100.0)]),
            },
        ]
        db = _db_with(docs, [{"telegram_id": 111, "nickname": "Alice"}])

        result = await _call_top(db, "most_used_traffic_1d")

        assert len(result) == 1
        assert result[0]["telegram_id"] == 111
        assert result[0]["value"] == pytest.approx(6.0)
        assert result[0]["metric"] == "GB used (24h)"

    @pytest.mark.asyncio
    async def test_7d_counts_a_week_and_ignores_older_days(self):
        today = _today_midnight()
        docs = [
            {"email": "111-alice", "date": today, "hourly_usage": _hourly([(0, 2.0, 0.0)])},
            {
                "email": "111-alice",
                "date": today - timedelta(days=3),
                "hourly_usage": _hourly([(0, 3.0, 0.0)]),
            },
            {
                "email": "111-alice",
                "date": today - timedelta(days=10),
                "hourly_usage": _hourly([(0, 500.0, 0.0)]),
            },
        ]
        db = _db_with(docs, [{"telegram_id": 111, "nickname": "Alice"}])

        result = await _call_top(db, "most_used_traffic_7d")

        assert len(result) == 1
        assert result[0]["value"] == pytest.approx(5.0)
        assert result[0]["metric"] == "GB used (7d)"

    @pytest.mark.asyncio
    async def test_ranks_users_by_window_usage(self):
        today = _today_midnight()
        docs = [
            {"email": "111-alice", "date": today, "hourly_usage": _hourly([(1, 1.0, 0.0)])},
            {"email": "222-bob", "date": today, "hourly_usage": _hourly([(1, 9.0, 0.0)])},
        ]
        db = _db_with(
            docs,
            [
                {"telegram_id": 111, "nickname": "Alice"},
                {"telegram_id": 222, "telegram_info": {"first_name": "Bob", "username": "bob"}},
            ],
        )

        result = await _call_top(db, "most_used_traffic_1d")

        assert [r["telegram_id"] for r in result] == [222, 111]
        assert result[0]["display_name"] == "Bob"
        assert result[0]["username"] == "bob"

    @pytest.mark.asyncio
    async def test_non_telegram_emails_are_ignored(self):
        today = _today_midnight()
        docs = [
            {"email": "not-a-user", "date": today, "hourly_usage": _hourly([(1, 50.0, 0.0)])},
            {"email": "111-alice", "date": today, "hourly_usage": _hourly([(1, 1.0, 0.0)])},
        ]
        db = _db_with(docs, [{"telegram_id": 111, "nickname": "Alice"}])

        result = await _call_top(db, "most_used_traffic_1d")

        assert [r["telegram_id"] for r in result] == [111]
