import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Any
from fastapi import APIRouter, Depends, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field
from app.database import get_database
from app.dependencies import require_admin, get_current_user
from app.models.user import UserModel, UserRole
from app.models.ticket import TicketModel
from app.models.setting import ReferralSettings, FreeTrialSettings
from app.integrations.xui_api import build_xui_client
from app.config import get_settings, Settings
from app.utils.security import hash_password, verify_password
from app.utils.telegram import send_telegram_message

logger = logging.getLogger(__name__)
router = APIRouter()


class UserRoleUpdate(BaseModel):
    role: UserRole


class SetAdminPasswordPayload(BaseModel):
    password: str = Field(
        ..., min_length=4, description="New admin 2FA password"
    )


class VerifyAdminPasswordPayload(BaseModel):
    password: str = Field(..., description="Admin 2FA password to verify")


class SendMessagePayload(BaseModel):
    telegram_id: int = Field(..., description="Target user's Telegram ID")
    message: str = Field(..., min_length=1, description="Message text to send")


class BroadcastPayload(BaseModel):
    message: str = Field(..., min_length=1, description="Broadcast message text")
    target: str = Field(
        default="all",
        description="Target group: 'all', 'unpaid_loans', 'active_configs'",
    )


@router.get("/stats", summary="Dashboard statistics")
async def get_stats(
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict:
    total_users = await db.users.count_documents({})
    pipeline: list[dict[str, Any]] = [
        {"$match": {"status": "completed"}},
        {"$group": {"_id": None, "total": {"$sum": "$amount_usd"}}},
    ]
    revenue_cursor = db.payments.aggregate(pipeline)
    revenue_doc = await revenue_cursor.to_list(length=1)
    total_revenue = revenue_doc[0]["total"] if revenue_doc else 0.0
    total_tickets = await db.tickets.count_documents({})
    open_tickets = await db.tickets.count_documents({"status": "open"})

    # Count unsettled (unpaid) loans total
    loans_pipeline: list[dict[str, Any]] = [
        {"$match": {"status": "unpaid"}},
        {"$group": {"_id": None, "total": {"$sum": "$amount_usdt"}}},
    ]
    loans_cursor = db.loans.aggregate(loans_pipeline)
    loans_doc = await loans_cursor.to_list(length=1)
    total_unsettled_loans = loans_doc[0]["total"] if loans_doc else 0.0

    # Cumulative unused traffic: sum of all users' traffic_balance_gb
    unused_pipeline: list[dict[str, Any]] = [
        {"$group": {"_id": None, "total": {"$sum": "$traffic_balance_gb"}}},
    ]
    unused_cursor = db.users.aggregate(unused_pipeline)
    unused_doc = await unused_cursor.to_list(length=1)
    total_unused_traffic_gb = unused_doc[0]["total"] if unused_doc else 0.0

    # Cumulative traffic purchased (from completed non-loan payments)
    purchased_pipeline: list[dict[str, Any]] = [
        {"$match": {"status": "completed", "type": {"$ne": "loan"}, "traffic_gb": {"$gt": 0}}},
        {"$group": {"_id": None, "total": {"$sum": "$traffic_gb"}}},
    ]
    purchased_cursor = db.payments.aggregate(purchased_pipeline)
    purchased_doc = await purchased_cursor.to_list(length=1)
    total_purchased_traffic_gb = purchased_doc[0]["total"] if purchased_doc else 0.0
    total_traffic_used_gb = max(0.0, total_purchased_traffic_gb - total_unused_traffic_gb)

    # Count configs live from XUI — only those belonging to telegram users (numeric id prefix)
    active_configs = 0
    total_configs = 0

    async def _fetch(server: dict) -> tuple[int, int]:
        try:
            xui = build_xui_client(server)
            clients = await xui.get_client_info()
            ac = 0
            tc = 0
            for c in clients:
                email = c.get("email", "")
                try:
                    int(email.split("-")[0].strip())
                except (ValueError, IndexError):
                    continue
                tc += 1
                if c.get("enable", True):
                    ac += 1
            return ac, tc
        except Exception as exc:
            logger.warning("Stats: could not reach server %s: %s", server.get("name"), exc)
            return 0, 0

    server_tasks = [_fetch(s) for s in settings.get_enabled_servers()]
    task_results = await asyncio.gather(*server_tasks)
    for ac, tc in task_results:
        active_configs += ac
        total_configs += tc
    return {
        "total_users": total_users,
        "active_configs": active_configs,
        "total_configs": total_configs,
        "total_revenue_usd": round(total_revenue, 2),
        "total_tickets": total_tickets,
        "open_tickets": open_tickets,
        "total_unsettled_loans_usd": round(total_unsettled_loans, 2),
        "total_traffic_used_gb": round(total_traffic_used_gb, 2),
        "total_unused_traffic_gb": round(total_unused_traffic_gb, 2),
    }


@router.get("/users/top", summary="Get top users by a given metric (admin)")
async def get_top_users(
    filter: str = Query(
        ...,
        description=(
            "Metric to rank by: most_used_traffic | most_used_traffic_1d | "
            "most_used_traffic_7d | most_unused_traffic | "
            "most_purchases | most_unsettled_loans | most_configs"
        ),
    ),
    limit: int = Query(5, ge=1, le=50, description="Number of top users to return (default 5)"),
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> list[dict]:
    """Return the top N users ranked by the requested metric."""

    if filter == "most_unused_traffic":
        # Users with most remaining traffic balance
        results = []
        async for doc in db.users.find(
            {"traffic_balance_gb": {"$gt": 0}},
            {"telegram_id": 1, "nickname": 1, "telegram_info": 1, "traffic_balance_gb": 1},
        ).sort("traffic_balance_gb", -1).limit(limit):
            doc.pop("_id", None)
            results.append({
                "telegram_id": doc.get("telegram_id"),
                "display_name": (
                    doc.get("nickname")
                    or (doc.get("telegram_info") or {}).get("first_name")
                    or f"ID:{doc.get('telegram_id')}"
                ),
                "username": (doc.get("telegram_info") or {}).get("username"),
                "value": round(doc.get("traffic_balance_gb", 0.0), 2),
                "metric": "GB unused",
            })
        return results

    if filter in ("most_used_traffic_1d", "most_used_traffic_7d"):
        # Rank users by *actual* traffic consumed inside a rolling window,
        # aggregated from the hourly usage buckets (per telegram-id prefix).
        window_hours = 24 if filter == "most_used_traffic_1d" else 24 * 7
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=window_hours)
        start_day = datetime(
            cutoff.year, cutoff.month, cutoff.day, tzinfo=timezone.utc
        )

        usage_by_tid: dict[int, float] = defaultdict(float)
        cursor = db.config_usages.find(
            {"date": {"$gte": start_day}},
            {"email": 1, "date": 1, "hourly_usage": 1, "_id": 0},
        )
        async for doc in cursor:
            prefix = (doc.get("email") or "").split("-")[0].strip()
            try:
                tid = int(prefix)
            except (TypeError, ValueError):
                continue

            day = doc.get("date")
            if day is None:
                continue
            if day.tzinfo is None:
                day = day.replace(tzinfo=timezone.utc)

            # Only count hourly buckets that fall inside the rolling window.
            used = 0.0
            for hour, bucket in enumerate(doc.get("hourly_usage", [])):
                if day + timedelta(hours=hour) < cutoff:
                    continue
                used += float(bucket.get("u", 0) or 0) + float(bucket.get("d", 0) or 0)
            if used > 0:
                usage_by_tid[tid] += used

        top = sorted(usage_by_tid.items(), key=lambda x: x[1], reverse=True)[:limit]
        if not top:
            return []

        user_docs: dict[int, Any] = {}
        async for u in db.users.find(
            {"telegram_id": {"$in": [tid for tid, _ in top]}},
            {"telegram_id": 1, "nickname": 1, "telegram_info": 1},
        ):
            user_docs[u["telegram_id"]] = u

        metric = (
            "GB used (24h)" if window_hours == 24 else "GB used (7d)"
        )
        results = []
        for tid, used in top:
            u = user_docs.get(tid, {})
            results.append({
                "telegram_id": tid,
                "display_name": (
                    u.get("nickname")
                    or (u.get("telegram_info") or {}).get("first_name")
                    or f"ID:{tid}"
                ),
                "username": (u.get("telegram_info") or {}).get("username"),
                "value": round(used, 2),
                "metric": metric,
            })
        return results

    if filter == "most_used_traffic":
        # Total purchased from payments minus current balance per user
        purchased_pipeline: list[dict[str, Any]] = [
            {"$match": {"status": "completed", "type": {"$ne": "loan"}, "traffic_gb": {"$gt": 0}}},
            {"$group": {"_id": "$telegram_id", "purchased": {"$sum": "$traffic_gb"}}},
        ]
        purchased_map: dict[int, float] = {}
        async for doc in db.payments.aggregate(purchased_pipeline):
            purchased_map[doc["_id"]] = doc["purchased"]

        if not purchased_map:
            return []

        # Fetch current balances for those users
        user_docs: dict[int, Any] = {}
        async for doc in db.users.find(
            {"telegram_id": {"$in": list(purchased_map.keys())}},
            {"telegram_id": 1, "nickname": 1, "telegram_info": 1, "traffic_balance_gb": 1},
        ):
            user_docs[doc["telegram_id"]] = doc

        ranked = []
        for tid, purchased in purchased_map.items():
            balance = user_docs.get(tid, {}).get("traffic_balance_gb", 0.0)
            used = max(0.0, purchased - balance)
            u = user_docs.get(tid, {})
            ranked.append({
                "telegram_id": tid,
                "display_name": (
                    u.get("nickname")
                    or (u.get("telegram_info") or {}).get("first_name")
                    or f"ID:{tid}"
                ),
                "username": (u.get("telegram_info") or {}).get("username"),
                "value": round(used, 2),
                "metric": "GB used",
            })
        ranked.sort(key=lambda x: x["value"], reverse=True)
        return ranked[:limit]

    if filter == "most_purchases":
        purchases_pipeline: list[dict[str, Any]] = [
            {"$match": {"status": "completed", "type": {"$ne": "loan"}}},
            {"$group": {"_id": "$telegram_id", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$limit": limit},
        ]
        results = []
        async for doc in db.payments.aggregate(purchases_pipeline):
            purchase_tid = doc["_id"]
            u = await db.users.find_one(
                {"telegram_id": purchase_tid},
                {"nickname": 1, "telegram_info": 1},
            )
            results.append({
                "telegram_id": purchase_tid,
                "display_name": (
                    (u or {}).get("nickname")
                    or ((u or {}).get("telegram_info") or {}).get("first_name")
                    or f"ID:{purchase_tid}"
                ),
                "username": ((u or {}).get("telegram_info") or {}).get("username"),
                "value": doc["count"],
                "metric": "purchases",
            })
        return results

    if filter == "most_unsettled_loans":
        unsettled_pipeline: list[dict[str, Any]] = [
            {"$match": {"status": "unpaid"}},
            {"$group": {"_id": "$telegram_id", "total": {"$sum": "$amount_usdt"}}},
            {"$sort": {"total": -1}},
            {"$limit": limit},
        ]
        results = []
        async for doc in db.loans.aggregate(unsettled_pipeline):
            loan_tid = doc["_id"]
            u = await db.users.find_one(
                {"telegram_id": loan_tid},
                {"nickname": 1, "telegram_info": 1},
            )
            results.append({
                "telegram_id": loan_tid,
                "display_name": (
                    (u or {}).get("nickname")
                    or ((u or {}).get("telegram_info") or {}).get("first_name")
                    or f"ID:{loan_tid}"
                ),
                "username": ((u or {}).get("telegram_info") or {}).get("username"),
                "value": round(doc["total"], 2),
                "metric": "USDT owed",
            })
        return results

    if filter == "most_configs":
        # Count per-telegram-id configs from XUI (only telegram-user configs)
        config_counts: dict[int, int] = {}

        async def _fetch(server: dict) -> dict[int, int]:
            local_counts: dict[int, int] = {}
            try:
                xui = build_xui_client(server)
                clients = await xui.get_client_info()
                for c in clients:
                    email = c.get("email", "")
                    try:
                        tid = int(email.split("-")[0].strip())
                        local_counts[tid] = local_counts.get(tid, 0) + 1
                    except (ValueError, IndexError):
                        pass
            except Exception as exc:
                logger.warning("top users most_configs: server error: %s", exc)
            return local_counts

        server_tasks = [_fetch(s) for s in settings.get_enabled_servers()]
        task_results = await asyncio.gather(*server_tasks)
        for local_counts in task_results:
            for tid, count in local_counts.items():
                config_counts[tid] = config_counts.get(tid, 0) + count

        if not config_counts:
            return []

        top = sorted(config_counts.items(), key=lambda x: x[1], reverse=True)[:limit]
        results = []
        for tid, count in top:
            u = await db.users.find_one(
                {"telegram_id": tid},
                {"nickname": 1, "telegram_info": 1},
            )
            results.append({
                "telegram_id": tid,
                "display_name": (
                    (u or {}).get("nickname")
                    or ((u or {}).get("telegram_info") or {}).get("first_name")
                    or f"ID:{tid}"
                ),
                "username": ((u or {}).get("telegram_info") or {}).get("username"),
                "value": count,
                "metric": "configs",
            })
        return results

    if filter == "recently_joined":
        results = []
        async for doc in db.users.find(
            {},
            {"telegram_id": 1, "nickname": 1, "telegram_info": 1, "created_at": 1},
        ).sort("created_at", -1).limit(limit):
            doc.pop("_id", None)
            created_at = doc.get("created_at")
            results.append({
                "telegram_id": doc.get("telegram_id"),
                "display_name": (
                    doc.get("nickname")
                    or (doc.get("telegram_info") or {}).get("first_name")
                    or f"ID:{doc.get('telegram_id')}"
                ),
                "username": (doc.get("telegram_info") or {}).get("username"),
                "value": created_at.isoformat() if created_at else "",
                "metric": "joined",
            })
        return results

    raise HTTPException(status_code=400, detail=(
        "Invalid filter. Use one of: most_used_traffic, most_used_traffic_1d, "
        "most_used_traffic_7d, most_unused_traffic, most_purchases, "
        "most_unsettled_loans, most_configs, recently_joined"
    ))


@router.get("/users/search", summary="Search users by any identifier (admin)")
async def search_users(
    q: str = Query(..., min_length=1, description="Query: telegram_id, nickname, username, phone, or name"),
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> list[UserModel]:
    """Search across all user fields: telegram_id, nickname, telegram username, phone, name."""
    conditions: list[dict[str, Any]] = []
    # Try numeric match for telegram_id
    try:
        tid = int(q)
        conditions.append({"telegram_id": tid})
    except ValueError:
        pass
    # Text-based matches (case-insensitive regex)
    regex = {"$regex": q, "$options": "i"}
    conditions.extend([
        {"nickname": regex},
        {"telegram_info.username": regex},
        {"telegram_info.first_name": regex},
        {"telegram_info.last_name": regex},
        {"telegram_info.phone_number": regex},
    ])
    query = {"$or": conditions} if conditions else {}
    results = []
    async for doc in db.users.find(query).limit(20):
        doc.pop("_id", None)
        results.append(UserModel(**doc))
    return results


@router.post(
    "/users/send-message",
    summary="Send a message to a specific user (admin)",
)
async def send_message_to_user(
    payload: SendMessagePayload,
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Send a Telegram message to a specific user by their Telegram ID."""
    # Verify user exists
    user_doc = await db.users.find_one({"telegram_id": payload.telegram_id})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found")
    if not settings.BOT_TOKEN:
        raise HTTPException(status_code=503, detail="Bot token not configured")
    success = await send_telegram_message(
        settings.BOT_TOKEN, payload.telegram_id, payload.message
    )
    if not success:
        raise HTTPException(
            status_code=502,
            detail="Failed to send message via Telegram Bot API",
        )
    return {
        "status": "success",
        "message": f"Message sent to user {payload.telegram_id}",
    }


@router.post(
    "/users/broadcast",
    summary="Broadcast message to multiple users (admin)",
)
async def broadcast_message(
    payload: BroadcastPayload,
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict:
    """
    Send a broadcast message to:
    - 'all': all users
    - 'unpaid_loans': users with unpaid loans
    - 'active_configs': users with active VPN configs
    """
    if not settings.BOT_TOKEN:
        raise HTTPException(status_code=503, detail="Bot token not configured")
    target_ids: list[int] = []
    if payload.target == "all":
        async for doc in db.users.find({}, {"telegram_id": 1}):
            if doc.get("telegram_id"):
                target_ids.append(doc["telegram_id"])
    elif payload.target == "unpaid_loans":
        async for doc in db.loans.find({"status": "unpaid"}, {"telegram_id": 1}):
            tid = doc.get("telegram_id")
            if tid and tid not in target_ids:
                target_ids.append(tid)
    elif payload.target == "active_configs":
        # Get all active config emails from XUI servers
        active_tids: set[int] = set()

        async def _fetch(server: dict) -> list[int]:
            tids = []
            try:
                xui = build_xui_client(server)
                clients = await xui.get_client_info()
                for c in clients:
                    if c.get("enable", True):
                        email = c.get("email", "")
                        try:
                            tids.append(int(email.split("-")[0]))
                        except (ValueError, IndexError):
                            pass
            except Exception as exc:
                logger.warning("broadcast active_configs: server error: %s", exc)
            return tids

        server_tasks = [_fetch(s) for s in settings.get_enabled_servers()]
        task_results = await asyncio.gather(*server_tasks)
        for tids in task_results:
            active_tids.update(tids)

        target_ids = list(active_tids)
    else:
        raise HTTPException(status_code=400, detail="Invalid target. Use 'all', 'unpaid_loans', or 'active_configs'")
    if not target_ids:
        return {"status": "success", "sent": 0, "failed": 0, "total": 0, "message": "No users found for target group"}
    sent = 0
    failed = 0
    for tid in target_ids:
        ok = await send_telegram_message(settings.BOT_TOKEN, tid, payload.message)
        if ok:
            sent += 1
        else:
            failed += 1
    return {
        "status": "success",
        "sent": sent,
        "failed": failed,
        "total": len(target_ids),
        "message": f"Broadcast complete: {sent} sent, {failed} failed out of {len(target_ids)} users"
    }


@router.put("/users/{telegram_id}/role", summary="Change user role (admin)")
async def change_user_role(
    telegram_id: int,
    payload: UserRoleUpdate,
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
):
    result = await db.users.update_one(
        {"telegram_id": telegram_id},
        {"$set": {"role": payload.role.value}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return {"status": "success", "message": f"User role updated to {payload.role.value}"}


@router.get(
    "/users/{telegram_id}/usage-history",
    summary="Get a specific user's config usage history (admin)",
)
async def get_admin_user_usage_history(
    telegram_id: int,
    timeframe: str = Query(default="H", pattern="^(H|D)$", description="H=hourly, D=daily"),
    window: str = Query(default="1D", pattern="^(1D|7D|30D|all)$", description="Time window: 1D, 7D, 30D, or all"),
    config: str = Query(default="all", description="Config UUID or 'all' for all configs"),
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> list[dict]:
    """Return usage history points for a given user, same format as /me/usage-history."""
    now = datetime.now(timezone.utc)
    today = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)

    query: dict = {}
    if window == "1D":
        query["date"] = {"$gte": today}
    elif window == "7D":
        query["date"] = {"$gte": today - timedelta(days=6)}
    elif window == "30D":
        query["date"] = {"$gte": today - timedelta(days=29)}

    if config == "all":
        query["email"] = {"$regex": f"^{telegram_id}-"}
    else:
        query["email"] = config

    cursor = db.config_usages.find(
        query,
        {"date": 1, "hourly_usage": 1, "_id": 0},
    ).sort("date", 1)
    docs = await cursor.to_list(length=None)

    def _utc_day(day: datetime) -> datetime:
        return day if day.tzinfo is not None else day.replace(tzinfo=timezone.utc)

    if timeframe == "H":
        bucket_map: dict = defaultdict(float)
        for doc in docs:
            day = _utc_day(doc["date"])
            for hour, bucket in enumerate(doc.get("hourly_usage", [])):
                ts = (day + timedelta(hours=hour)).isoformat()
                bucket_map[ts] += (bucket.get("u", 0) + bucket.get("d", 0))
        return [{"ts": ts, "gb": round(v, 4)} for ts, v in sorted(bucket_map.items())]
    else:
        daily_map: dict = defaultdict(float)
        for doc in docs:
            day = _utc_day(doc["date"])
            day_str = day.isoformat()
            for bucket in doc.get("hourly_usage", []):
                daily_map[day_str] += (bucket.get("u", 0) + bucket.get("d", 0))
        return [{"ts": ts, "gb": round(v, 4)} for ts, v in sorted(daily_map.items())]


@router.get("/users/{telegram_id}/tickets", response_model=list[TicketModel], summary="Get user's tickets (admin)")
async def get_user_tickets(
    telegram_id: int,
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> list[TicketModel]:
    results = []
    async for doc in db.tickets.find({"telegram_id": telegram_id}):
        doc.pop("_id", None)
        results.append(TicketModel(**doc))
    return results


@router.post(
    "/sync-configs",
    summary="Test connectivity to all XUI servers and return status",
)
async def sync_configs(
    _admin: UserModel = Depends(require_admin),
    settings: Settings = Depends(get_settings),
) -> dict:
    async def _fetch(server: dict) -> tuple[bool, int, str | None]:
        server_name = server.get("name", server.get("server_name", ""))
        try:
            xui = build_xui_client(server)
            clients = await xui.get_client_info()
            return True, len(clients), None
        except Exception as exc:
            logger.warning("sync_configs error for %s: %s", server_name, exc)
            return False, 0, f"{server_name}: connection failed"

    server_tasks = [_fetch(s) for s in settings.get_server_list()]
    task_results = await asyncio.gather(*server_tasks)

    servers_ok = 0
    servers_failed = 0
    total_clients = 0
    errors = []
    for ok, count, err in task_results:
        if ok:
            servers_ok += 1
            total_clients += count
        else:
            servers_failed += 1
            errors.append(err)

    return {
        "servers_ok": servers_ok,
        "servers_failed": servers_failed,
        "total_clients": total_clients,
        "errors": errors,
    }


@router.get(
    "/referral-settings",
    response_model=ReferralSettings,
    summary="Get referral layer percentages (admin)",
)
async def get_referral_settings(
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> ReferralSettings:
    doc = await db.settings.find_one({"_id": "referral_settings"})
    if doc:
        data = doc.get("data", {})
        return ReferralSettings(
            layer_1=data.get("layer_1", settings.REFERRAL_LAYER_1_PCT),
            layer_2=data.get("layer_2", settings.REFERRAL_LAYER_2_PCT),
            layer_3=data.get("layer_3", settings.REFERRAL_LAYER_3_PCT),
            layer_4=data.get("layer_4", settings.REFERRAL_LAYER_4_PCT),
            layer_5=data.get("layer_5", settings.REFERRAL_LAYER_5_PCT),
        )
    return ReferralSettings(
        layer_1=settings.REFERRAL_LAYER_1_PCT,
        layer_2=settings.REFERRAL_LAYER_2_PCT,
        layer_3=settings.REFERRAL_LAYER_3_PCT,
        layer_4=settings.REFERRAL_LAYER_4_PCT,
        layer_5=settings.REFERRAL_LAYER_5_PCT,
    )


@router.put(
    "/referral-settings",
    response_model=ReferralSettings,
    summary="Update referral layer percentages (admin)",
)
async def update_referral_settings(
    payload: ReferralSettings,
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> ReferralSettings:
    data = payload.model_dump()
    await db.settings.update_one(
        {"_id": "referral_settings"},
        {"$set": {"data": data}},
        upsert=True,
    )
    return payload


@router.get(
    "/free-trial-settings",
    response_model=FreeTrialSettings,
    summary="Get free trial settings (admin)",
)
async def get_free_trial_settings(
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> FreeTrialSettings:
    doc = await db.settings.find_one({"_id": "free_trial_settings"})
    if doc:
        data = doc.get("data", {})
        return FreeTrialSettings(
            traffic_gb=data.get("traffic_gb", settings.FREE_TRIAL_GB),
        )
    return FreeTrialSettings(
        traffic_gb=settings.FREE_TRIAL_GB,
    )


@router.put(
    "/free-trial-settings",
    response_model=FreeTrialSettings,
    summary="Update free trial settings (admin)",
)
async def update_free_trial_settings(
    payload: FreeTrialSettings,
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> FreeTrialSettings:
    data = payload.model_dump()
    await db.settings.update_one(
        {"_id": "free_trial_settings"},
        {"$set": {"data": data}},
        upsert=True,
    )
    return payload


class GrantFreeTrialResponse(BaseModel):
    affected_users: int = Field(..., description="Number of users who received the free trial")


@router.post(
    "/grant-free-trial",
    response_model=GrantFreeTrialResponse,
    summary="Grant free trial traffic to all users who haven't used it yet (admin)",
)
async def grant_free_trial(
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> GrantFreeTrialResponse:
    ft_doc = await db.settings.find_one({"_id": "free_trial_settings"})
    ft_traffic_gb = ft_doc["data"].get("traffic_gb", 0.0) if ft_doc else settings.FREE_TRIAL_GB

    if ft_traffic_gb <= 0:
        raise HTTPException(status_code=400, detail="Free trial traffic must be greater than 0")

    cursor = db.users.find({"has_used_free_trial": False})
    affected = 0
    async for user_doc in cursor:
        telegram_id = user_doc["telegram_id"]
        await db.users.update_one(
            {"telegram_id": telegram_id},
            {
                "$inc": {"traffic_balance_gb": ft_traffic_gb},
                "$set": {"has_used_free_trial": True},
                "$push": {
                    "purchase_history": {
                        "date": datetime.now(timezone.utc),
                        "plan_name": "Free Trial",
                        "price_usd": 0.0,
                        "traffic_gb": ft_traffic_gb,
                    }
                },
            },
        )
        affected += 1

    return GrantFreeTrialResponse(affected_users=affected)


@router.put("/users/{telegram_id}/set-admin-password", summary="Set or update admin 2FA password for a user (admin)")
async def set_admin_password(
    telegram_id: int,
    payload: SetAdminPasswordPayload,
    _admin: UserModel = Depends(require_admin),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> dict:
    """Set a 2FA dashboard password for an admin user. The password is stored as a secure hash."""
    user_doc = await db.users.find_one({"telegram_id": telegram_id})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found")
    if user_doc.get("role") != UserRole.admin.value:
        raise HTTPException(status_code=400, detail="User is not an admin")
    hashed = hash_password(payload.password)
    await db.users.update_one(
        {"telegram_id": telegram_id},
        {"$set": {"admin_password": hashed}},
    )
    return {"status": "success", "message": f"Admin password set for user {telegram_id}"}


@router.post("/verify-password", summary="Verify calling admin's 2FA password")
async def verify_admin_password(
    payload: VerifyAdminPasswordPayload,
    current_user: UserModel = Depends(get_current_user),
    db: AsyncIOMotorDatabase = Depends(get_database),
) -> dict:
    """Verify the admin 2FA password without requiring it as a header (used by the login flow)."""
    if current_user.role != UserRole.admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    if not current_user.has_admin_password:
        return {"valid": True}
    admin_doc = await db.users.find_one(
        {"telegram_id": current_user.telegram_id}, {"admin_password": 1}
    )
    stored_hash = admin_doc.get("admin_password") if admin_doc else None
    if not stored_hash or not verify_password(payload.password, stored_hash):
        raise HTTPException(status_code=403, detail="Invalid admin password")
    return {"valid": True}
