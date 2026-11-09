"""
Celery tasks for Raha VPN backend.

These tasks run in a separate worker process; they use synchronous Motor via
asyncio.run() because Celery workers are not async by default. For long-running
async work we run an event loop explicitly.
"""
import asyncio
import logging
from datetime import datetime, timezone

from app.celery_worker import celery_app
from app.config import get_settings
from app.integrations.xui_api import build_xui_client
from app.utils.usage import compute_usage_delta
from motor.motor_asyncio import AsyncIOMotorClient

logger = logging.getLogger(__name__)

_BYTES_TO_GB = 1024 ** 3


def _get_db():
    settings = get_settings()
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    return client[settings.MONGODB_DB_NAME], client


# ---------------------------------------------------------------------------
# Hourly usage tracking (Bucket Pattern)
# ---------------------------------------------------------------------------

@celery_app.task(name="app.tasks.track_hourly_usage", bind=True, max_retries=3)
def track_hourly_usage(self) -> dict:
    """
    Fetch live traffic data from each XUI server, compute per-client hourly
    deltas, and persist them into the config_usages / server_usages bucket
    collections using MongoDB's $inc operator.

    Non-active (disabled/expired) configs that have just transitioned from
    active will have their final delta captured before being skipped in
    subsequent runs.  Configs already marked "deleted" in the DB, or those
    that were non-active on the previous run with no new traffic, are skipped
    entirely to avoid redundant work.
    """
    async def _run():
        db, mongo_client = _get_db()
        try:
            settings = get_settings()
            now = datetime.now(timezone.utc)
            today_midnight = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
            hour = now.hour

            async def _fetch_server(server: dict) -> tuple[dict, list, dict]:
                server_name = server.get("name", "")
                try:
                    xui = build_xui_client(server)
                    clients = await xui.get_client_info()
                    try:
                        online_emails = await xui.get_online_emails()
                    except Exception:
                        online_emails = []
                    return server, clients, {"online": online_emails}
                except Exception as exc:
                    logger.error("track_hourly_usage: failed to fetch clients from server %s: %s", server_name, exc)
                    return server, [], {}

            tasks = [_fetch_server(s) for s in settings.get_enabled_servers()]
            server_results = await asyncio.gather(*tasks)

            telegram_ids = set()
            async for user_doc in db.users.find({}, {"telegram_id": 1, "_id": 0}):
                telegram_ids.add(str(user_doc["telegram_id"]))

            async def _persist_snapshot(
                *,
                email: str,
                server_name: str,
                config_uuid: str,
                snapshot: dict | None,
                usage_up: float,
                usage_down: float,
                client_status: str,
            ) -> None:
                """Upsert the usage snapshot on its stable identity.

                Updates the existing document (found by ``(server, email)`` or the
                legacy UUID lookup) so the same client never ends up with two
                competing snapshot rows after a key regeneration.
                """
                values = {
                    "usage_up": usage_up,
                    "usage_down": usage_down,
                    "client_status": client_status,
                    "server_name": server_name,
                    "email": email,
                    "updated_at": now,
                }
                if snapshot is not None and snapshot.get("_id") is not None:
                    await db.usage_snapshots.update_one(
                        {"_id": snapshot["_id"]}, {"$set": values}
                    )
                else:
                    await db.usage_snapshots.update_one(
                        {"uuid": config_uuid},
                        {"$set": values, "$setOnInsert": {"uuid": config_uuid}},
                        upsert=True,
                    )

            for server, clients, meta in server_results:
                if not clients: continue
                server_name = server.get("name", "")
                online_emails = meta.get("online", [])
                
                # Accumulate inbound-level deltas: {inbound_id -> {"up": bytes, "down": bytes}}
                inbound_deltas: dict = {}

                for c in clients:
                    c["is_online"] = c.get("email", "") in online_emails
                    config_uuid = c.get("uuid", "")
                    if not config_uuid:
                        continue

                    email = c.get("email", "")

                    # Only track configs belonging to telegram users.
                    # Telegram user configs have emails in the format "{telegram_id}-{custom_name}".
                    email_prefix = email.split("-")[0] if "-" in email else ""
                    if email_prefix not in telegram_ids:
                        continue
                    usage_up = float(c.get("usage_up", 0))
                    usage_down = float(c.get("usage_down", 0))
                    enable = c.get("enable", True)
                    total_gb = c.get("total_gb", 0.0)
                    expiry_ms = c.get("expiry_time_ms", 0)
                    expiry_date = (
                        datetime.fromtimestamp(expiry_ms / 1000, tz=timezone.utc)
                        if expiry_ms and expiry_ms > 0
                        else None
                    )
                    used_gb = (usage_up + usage_down) / _BYTES_TO_GB

                    if not enable:
                        client_status = "disabled"
                    elif (total_gb > 0 and used_gb >= total_gb) or (
                        expiry_date and expiry_date < now
                    ):
                        client_status = "expired"
                    else:
                        client_status = "active"

                    # Hard-skip configs already marked "deleted" in the DB — they have
                    # been fully accounted for by the delete API route.
                    existing_doc = await db.config_usages.find_one(
                        {"uuid": config_uuid, "date": today_midnight},
                        {"client_status": 1, "_id": 0},
                    )
                    if existing_doc and existing_doc.get("client_status") == "deleted":
                        continue

                    # Retrieve the previous usage snapshot to compute delta and to
                    # know whether this config was already non-active on the last run.
                    #
                    # The panel keeps traffic counters per *email* for the whole
                    # lifetime of the client; regenerating a key (or re-creating a
                    # config with a new UUID) keeps those counters but changes the
                    # UUID.  Keying the snapshot by UUID alone therefore made the
                    # next run see "no previous snapshot" and book the entire
                    # lifetime traffic as one hour of usage (the doubled/overshot
                    # days).  Look the snapshot up by the stable (server, email)
                    # identity first, fall back to the legacy UUID key, and treat a
                    # genuinely missing snapshot as a baseline to seed rather than
                    # as zero.
                    snapshot = await db.usage_snapshots.find_one(
                        {"server_name": server_name, "email": email}
                    )
                    if snapshot is None:
                        snapshot = await db.usage_snapshots.find_one(
                            {"uuid": config_uuid}
                        )

                    (
                        delta_up_bytes,
                        delta_down_bytes,
                        prev_status,
                        _first_seen,
                    ) = compute_usage_delta(snapshot, usage_up, usage_down)

                    # For non-active configs: skip only if this config was already
                    # non-active in the previous run AND produced no new traffic.
                    # This ensures any bandwidth consumed right before a status change
                    # (disabled/expired) is captured in the final delta pass.
                    if client_status != "active":
                        if prev_status != "active" and delta_up_bytes == 0.0 and delta_down_bytes == 0.0:
                            continue

                        # Capture the final delta for this now-non-active config.
                        empty_hourly = [{"u": 0.0, "d": 0.0} for _ in range(24)]
                        await db.config_usages.update_one(
                            {"uuid": config_uuid, "date": today_midnight},
                            {
                                "$set": {
                                    "email": email,
                                    "server_name": server_name,
                                    "client_status": client_status,
                                },
                                "$setOnInsert": {"hourly_usage": empty_hourly},
                            },
                            upsert=True,
                        )

                        # Persist snapshot (including status) so the next run can
                        # safely skip this config when it is still non-active.
                        await _persist_snapshot(
                            email=email,
                            server_name=server_name,
                            config_uuid=config_uuid,
                            snapshot=snapshot,
                            usage_up=usage_up,
                            usage_down=usage_down,
                            client_status=client_status,
                        )

                        delta_up_gb = round(delta_up_bytes / _BYTES_TO_GB, 2)
                        delta_down_gb = round(delta_down_bytes / _BYTES_TO_GB, 2)
                        if delta_up_gb > 0 or delta_down_gb > 0:
                            await db.config_usages.update_one(
                                {"uuid": config_uuid, "date": today_midnight},
                                {
                                    "$inc": {
                                        f"hourly_usage.{hour}.u": delta_up_gb,
                                        f"hourly_usage.{hour}.d": delta_down_gb,
                                    }
                                },
                            )

                        inbound_id = c.get("inbound_id", server.get("inbound_id", 1))
                        if inbound_id not in inbound_deltas:
                            inbound_deltas[inbound_id] = {"up": 0.0, "down": 0.0}
                        inbound_deltas[inbound_id]["up"] += delta_up_bytes
                        inbound_deltas[inbound_id]["down"] += delta_down_bytes

                        continue

                    empty_hourly = [{"u": 0.0, "d": 0.0} for _ in range(24)]
                    # Upsert today's document; pre-allocate hourly_usage on first insert
                    await db.config_usages.update_one(
                        {"uuid": config_uuid, "date": today_midnight},
                        {
                            "$set": {
                                "email": email,
                                "server_name": server_name,
                                "client_status": client_status,
                            },
                            "$setOnInsert": {"hourly_usage": empty_hourly},
                        },
                        upsert=True,
                    )

                    # Persist snapshot update regardless of whether deltas are zero
                    await _persist_snapshot(
                        email=email,
                        server_name=server_name,
                        config_uuid=config_uuid,
                        snapshot=snapshot,
                        usage_up=usage_up,
                        usage_down=usage_down,
                        client_status=client_status,
                    )

                    # Convert to GB (2 decimal places) and update hourly bucket
                    delta_up_gb = round(delta_up_bytes / _BYTES_TO_GB, 2)
                    delta_down_gb = round(delta_down_bytes / _BYTES_TO_GB, 2)

                    if delta_up_gb > 0 or delta_down_gb > 0:
                        await db.config_usages.update_one(
                            {"uuid": config_uuid, "date": today_midnight},
                            {
                                "$inc": {
                                    f"hourly_usage.{hour}.u": delta_up_gb,
                                    f"hourly_usage.{hour}.d": delta_down_gb,
                                }
                            },
                        )
                    # Accumulate inbound-level deltas
                    inbound_id = c.get("inbound_id", server.get("inbound_id", 1))
                    if inbound_id not in inbound_deltas:
                        inbound_deltas[inbound_id] = {"up": 0.0, "down": 0.0}
                    inbound_deltas[inbound_id]["up"] += delta_up_bytes
                    inbound_deltas[inbound_id]["down"] += delta_down_bytes

                # Update server_usages for each inbound that had active traffic
                empty_hourly_inbound = [{"u": 0.0, "d": 0.0} for _ in range(24)]
                for inbound_id, deltas in inbound_deltas.items():
                    await db.server_usages.update_one(
                        {
                            "server_name": server_name,
                            "date": today_midnight,
                        },
                        {"$setOnInsert": {"hourly_usage": empty_hourly_inbound}},
                        upsert=True,
                    )
                    delta_up_gb = round(deltas["up"] / _BYTES_TO_GB, 2)
                    delta_down_gb = round(deltas["down"] / _BYTES_TO_GB, 2)
                    if delta_up_gb > 0 or delta_down_gb > 0:
                        await db.server_usages.update_one(
                            {
                                "server_name": server_name,
                                "date": today_midnight,
                            },
                            {
                                "$inc": {
                                    f"hourly_usage.{hour}.u": delta_up_gb,
                                    f"hourly_usage.{hour}.d": delta_down_gb,
                                }
                            },
                        )

            return {"ok": True}
        finally:
            mongo_client.close()

    try:
        return asyncio.run(_run())
    except Exception as exc:
        logger.error("track_hourly_usage failed: %s", exc)
        raise self.retry(exc=exc, countdown=60)


# ---------------------------------------------------------------------------
# Config status sync (every 10 minutes)
# ---------------------------------------------------------------------------

@celery_app.task(name="app.tasks.sync_config_statuses", bind=True, max_retries=3)
def sync_config_statuses(self) -> dict:
    """Iterate all enabled servers and update config statuses in the
    config_usages collection to reflect live panel state."""
    async def _run():
        db, mongo_client = _get_db()
        try:
            settings = get_settings()
            now = datetime.now(timezone.utc)
            today = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
            total_updated = 0
            server_count = 0
            changed_events: list[tuple[str, str]] = []

            async def _fetch_server(server: dict) -> tuple[dict, list]:
                server_name = server.get("name", "")
                try:
                    xui = build_xui_client(server)
                    clients = await xui.get_client_info()
                    return server, clients
                except Exception as exc:
                    logger.error("sync_config_statuses: failed to fetch clients from %s: %s", server_name, exc)
                    return server, []

            tasks = [_fetch_server(s) for s in settings.get_enabled_servers()]
            results = await asyncio.gather(*tasks)

            for server, clients in results:
                server_name = server.get("name", "")
                if not clients: continue
                server_count += 1
                for c in clients:
                    config_uuid = c.get("uuid", "")
                    if not config_uuid:
                        continue
                    email = c.get("email", "")
                    usage_up = float(c.get("usage_up", 0))
                    usage_down = float(c.get("usage_down", 0))
                    enable = c.get("enable", True)
                    total_gb = c.get("total_gb", 0.0)
                    expiry_ms = c.get("expiry_time_ms", 0)
                    expiry_date = (
                        datetime.fromtimestamp(expiry_ms / 1000, tz=timezone.utc)
                        if expiry_ms and expiry_ms > 0
                        else None
                    )
                    used_gb = (usage_up + usage_down) / _BYTES_TO_GB

                    if not enable:
                        client_status = "disabled"
                    elif (total_gb > 0 and used_gb >= total_gb) or (
                        expiry_date and expiry_date < now
                    ):
                        client_status = "expired"
                    else:
                        client_status = "active"

                    existing = await db.config_usages.find_one(
                        {"uuid": config_uuid, "date": today},
                        {"client_status": 1},
                    )
                    old_status = existing.get("client_status") if existing else None

                    result = await db.config_usages.update_one(
                        {"uuid": config_uuid, "date": today},
                        {
                            "$set": {
                                "client_status": client_status,
                                "email": email,
                                "server_name": server_name,
                                "updated_at": now,
                            },
                            "$setOnInsert": {
                                "hourly_usage": [{"u": 0.0, "d": 0.0} for _ in range(24)],
                            },
                        },
                        upsert=True,
                    )
                    if result.modified_count > 0 or result.upserted_id:
                        total_updated += 1

                    if old_status and old_status != client_status and "-" in email:
                        tid_str = email.split("-")[0]
                        changed_events.append((tid_str, email))

            logger.info("sync_config_statuses: %d servers, %d configs updated, %d status changes", server_count, total_updated, len(changed_events))
            return {"ok": True, "servers": server_count, "updated": total_updated}
        finally:
            mongo_client.close()

    try:
        return asyncio.run(_run())
    except Exception as exc:
        logger.error("sync_config_statuses failed: %s", exc)
        raise self.retry(exc=exc, countdown=60)


@celery_app.task(name="app.tasks.expire_old_configs", bind=True, max_retries=3)
def expire_old_configs(self) -> dict:
    """Find expired configs on each server and disable them on the panel
    by calling bulk_disable_clients. Also marks them as expired in the DB."""
    async def _run():
        db, mongo_client = _get_db()
        try:
            settings = get_settings()
            now = datetime.now(timezone.utc)
            today = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
            total_disabled = 0
            server_count = 0

            async def _fetch_server(server: dict) -> tuple[dict, list]:
                server_name = server.get("name", "")
                try:
                    xui = build_xui_client(server)
                    clients = await xui.get_client_info()
                    return server, clients
                except Exception as exc:
                    logger.error("expire_old_configs: failed to fetch clients from %s: %s", server_name, exc)
                    return server, []

            tasks = [_fetch_server(s) for s in settings.get_enabled_servers()]
            results = await asyncio.gather(*tasks)

            for server, clients in results:
                server_name = server.get("name", "")
                if not clients: continue
                server_count += 1
                expired_emails: list[str] = []
                # Re-create xui client to use inside the loop for bulk action if needed, 
                # though it was already created inside _fetch_server. 
                # Actually, can just create it again or pass it through.
                # Let's recreate it simply.
                xui = build_xui_client(server)
                for c in clients:
                    if not c.get("enable", True): continue
                    total_gb = c.get("total_gb", 0.0)
                    used_gb = (float(c.get("usage_up", 0)) + float(c.get("usage_down", 0))) / _BYTES_TO_GB
                    expiry_ms = c.get("expiry_time_ms", 0)
                    expiry_date = datetime.fromtimestamp(expiry_ms / 1000, tz=timezone.utc) if expiry_ms and expiry_ms > 0 else None
                    if (total_gb > 0 and used_gb >= total_gb) or (expiry_date and expiry_date < now):
                        email = c.get("email", "")
                        if email:
                            expired_emails.append(email)
                            config_uuid = c.get("uuid", "")
                            if config_uuid:
                                await db.config_usages.update_one({"uuid": config_uuid, "date": today}, {"$set": {"client_status": "expired"}}, upsert=True)

                if expired_emails:
                    try:
                        result = await xui.bulk_disable_clients(expired_emails)
                        if result.get("success"):
                            total_disabled += len(expired_emails)
                            logger.info("expire_old_configs: disabled %d configs on %s", len(expired_emails), server_name)
                        else:
                            logger.warning("expire_old_configs: bulk disable returned failure on %s: %s", server_name, result.get("msg"))
                    except Exception as exc:
                        logger.error("expire_old_configs: failed to disable configs on %s: %s", server_name, exc)
            
            logger.info("expire_old_configs: %d servers, %d expired configs disabled", server_count, total_disabled)
            return {"ok": True, "servers": server_count, "disabled": total_disabled}
        finally:
            mongo_client.close()

    try:
        return asyncio.run(_run())
    except Exception as exc:
        logger.error("expire_old_configs failed: %s", exc)
        raise self.retry(exc=exc, countdown=60)


# ---------------------------------------------------------------------------
# Payment webhook processing
# ---------------------------------------------------------------------------

@celery_app.task(name="app.tasks.process_payment_webhook", bind=True, max_retries=3)
def process_payment_webhook(self, webhook_data: dict) -> dict:
    """
    Process a Plisio IPN webhook asynchronously via Celery.
    Used when the webhook endpoint enqueues processing instead of doing it inline.
    """
    async def _run():
        db, client = _get_db()
        try:
            txn_id: str = webhook_data.get("txn_id", "")
            order_number: str = webhook_data.get("order_number", "")
            plisio_status: str = webhook_data.get("status", "")

            payment_doc = await db.payments.find_one({"payment_id": order_number})
            if not payment_doc or payment_doc.get("status") == "completed":
                return {"ok": True, "skipped": True}

            if plisio_status in ("completed", "mismatch"):
                telegram_id: int = payment_doc["telegram_id"]
                amount_usd: float = payment_doc["amount_usd"]
                await db.users.update_one(
                    {"telegram_id": telegram_id},
                    {"$inc": {"wallet_balance_usd": amount_usd}},
                )
                await db.payments.update_one(
                    {"payment_id": order_number},
                    {
                        "$set": {
                            "status": "completed",
                            "plisio_txn_id": txn_id,
                            "completed_at": datetime.now(timezone.utc),
                        }
                    },
                )
                logger.info("Task: payment %s completed for user %s", order_number, telegram_id)

            elif plisio_status in ("expired", "cancelled", "error"):
                await db.payments.update_one(
                    {"payment_id": order_number},
                    {"$set": {"status": plisio_status}},
                )

            return {"ok": True}
        finally:
            client.close()

    try:
        return asyncio.run(_run())
    except Exception as exc:
        logger.error("process_payment_webhook failed: %s", exc)
        raise self.retry(exc=exc, countdown=60)
