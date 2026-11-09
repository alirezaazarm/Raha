import asyncio
import base64
import hashlib
import io
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import unquote, urlsplit

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import Settings
from app.integrations.xui_api import build_xui_client, AsyncXUIClient
from app.models.vpn_config import VpnConfigResponse, ConfigStatus

logger = logging.getLogger(__name__)


_MAX_SANE_TIMESTAMP_MS = 253402300799000  # year 9999 in ms


def _safe_from_timestamp_ms(ms: int) -> Optional[datetime]:
    if not ms or ms <= 0 or ms > _MAX_SANE_TIMESTAMP_MS:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    except (OSError, OverflowError, ValueError):
        return None


def _today_midnight() -> datetime:
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)


def _parse_telegram_id_from_email(email: str) -> Optional[int]:
    try:
        return int(email.split("-")[0])
    except (ValueError, IndexError):
        return None


def _parse_name_from_email(email: str) -> str:
    parts = email.split("-", 1)
    return parts[1] if len(parts) > 1 else email


def _decode_vmess_name(link: str) -> str:
    try:
        payload = link.split("://", 1)[1].split("#", 1)[0]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.b64decode(payload).decode("utf-8", "ignore"))
        return str(data.get("ps") or "").strip()
    except Exception:
        return ""


def _proxy_endpoint_label(link: str, index: int) -> str:
    scheme = link.split("://", 1)[0].lower() if "://" in link else ""
    try:
        parsed = urlsplit(link)
        host = parsed.hostname or ""
        port = parsed.port
    except Exception:
        host, port = "", None
    label = scheme.upper() if scheme else f"Proxy {index + 1}"
    if host:
        label = f"{label} · {host}" + (f":{port}" if port else "")
    return label


def proxy_display_name(link: str, index: int, ignore_names: Optional[set] = None) -> str:
    """Best-effort human readable name for a proxy URI."""
    scheme = link.split("://", 1)[0].lower() if "://" in link else ""
    name = ""
    if scheme == "vmess":
        name = _decode_vmess_name(link)
    if not name:
        try:
            name = unquote(urlsplit(link).fragment or "").strip()
        except Exception:
            name = ""
    if name and ignore_names and name in ignore_names:
        # XUI puts the client email in the fragment, which is identical for
        # every proxy. Fall back to protocol + endpoint so each QR is distinct.
        name = ""
    return name or _proxy_endpoint_label(link, index)


def _normalize_raw_xui_client(raw: dict, server: dict) -> dict:
    traffic = raw.get("traffic") or {}
    inbound_ids = raw.get("inboundIds") or []
    raw_total = raw.get("totalGB", 0) or 0
    total_gb = float(raw_total) / (1024**3) if raw_total else 0.0
    return {
        "uuid": str(raw.get("uuid") or raw.get("id") or ""),
        "email": raw.get("email") or "",
        "inbound_id": inbound_ids[0] if inbound_ids else int(server.get("inbound_id", 1)),
        "inbound_ids": inbound_ids,
        "usage_up": float(traffic.get("up", 0) or 0),
        "usage_down": float(traffic.get("down", 0) or 0),
        "total_gb": total_gb,
        "expiry_time_ms": min(int(raw.get("expiryTime", 0) or 0), _MAX_SANE_TIMESTAMP_MS),
        "enable": bool(raw.get("enable", traffic.get("enable", True))),
        "limit_ip": int(raw.get("limitIp", 0) or 0),
        "subId": raw.get("subId") or "",
        "last_online": int(raw.get("last_online", 0) or 0),
    }


def _client_to_response(
    client: dict, server_name: str, telegram_id: int
) -> VpnConfigResponse:
    email = client.get("email", "")
    last_online = _safe_from_timestamp_ms(client.get("last_online", 0))
    expiry_date = _safe_from_timestamp_ms(client.get("expiry_time_ms", 0))
    enable = client.get("enable", True)
    total_gb = client.get("total_gb", 0.0)
    usage_up = client.get("usage_up", 0)
    usage_down = client.get("usage_down", 0)
    used_gb = (usage_up + usage_down) / (1024**3)
    now = datetime.now(timezone.utc)
    if not enable:
        status = ConfigStatus.disabled
    elif (total_gb > 0 and used_gb >= total_gb) or (
        expiry_date and expiry_date < now
    ):
        status = ConfigStatus.expired
    else:
        status = ConfigStatus.active
    return VpnConfigResponse(
        uuid=client.get("uuid", ""),
        telegram_id=telegram_id,
        server_name=server_name,
        email=email,
        name=_parse_name_from_email(email),
        enable=enable,
        status=status,
        total_gb=total_gb,
        usage_up=usage_up,
        usage_down=usage_down,
        expiry_date=expiry_date,
        last_online=last_online,
        is_online=False,
        domain_name=client.get("domain_name", ""),
        limit_ip=int(client.get("limit_ip", 0) or 0),
        subscription_link=client.get("subscription_link", ""),
        inbound_ids=client.get("inbound_ids", []),
        inbound_names=client.get("inbound_names", []),
    )


class ConfigService:
    def __init__(self, db: AsyncIOMotorDatabase, settings: Settings):
        self._db = db
        self._settings = settings
        self._xui_cache: dict[str, tuple[float, list]] = {}
        self._cache_ttl = 30  # seconds

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #
    async def _get_clients_cached(self, xui: AsyncXUIClient) -> list:
        now = asyncio.get_event_loop().time()
        key = f"{xui.base_url}"
        if key in self._xui_cache:
            ttl, clients = self._xui_cache[key]
            if now - ttl < self._cache_ttl:
                return clients
        
        clients = await xui.get_client_info()
        self._xui_cache[key] = (now, clients)
        return clients

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #
    async def _update_today_config_status(
        self,
        config_uuid: str,
        new_status: str,
        *,
        email: str = "",
        server_name: str = "",
        upsert: bool = False,
    ) -> None:
        today = _today_midnight()
        update: dict = {"$set": {"client_status": new_status}}
        if email:
            update["$set"]["email"] = email
        if server_name:
            update["$set"]["server_name"] = server_name
        if upsert:
            update["$setOnInsert"] = {
                "hourly_usage": [{"u": 0.0, "d": 0.0} for _ in range(24)]
            }
        await self._db.config_usages.update_one(
            {"uuid": config_uuid, "date": today},
            update,
            upsert=upsert,
        )

    async def find_client_by_email(self, email: str) -> tuple[dict, dict] | tuple[None, None]:
        servers = self._settings.get_enabled_servers()
        if not servers:
            return None, None

        async def _search(server: dict) -> tuple[dict, dict] | None:
            try:
                xui = build_xui_client(server)
                raw = await xui.get_client_by_email(email)
                if raw:
                    # Some XUI versions nest under a "client" key
                    inner = raw.get("client") or raw
                    return _normalize_raw_xui_client(inner, server), server
            except Exception:
                pass
            return None

        results = await asyncio.gather(*[_search(s) for s in servers], return_exceptions=True)
        for r in results:
            if isinstance(r, tuple) and r[0] is not None:
                return r
        return None, None

    async def find_client_by_uuid(self, config_uuid: str) -> tuple[dict, dict] | tuple[None, None]:
        servers = self._settings.get_enabled_servers()
        if not servers:
            return None, None

        async def _search(server: dict) -> tuple[dict, dict] | None:
            try:
                xui = build_xui_client(server)
                clients = await self._get_clients_cached(xui)
                for c in clients:
                    if c.get("uuid") == config_uuid:
                        return c, server
            except Exception:
                pass
            return None

        results = await asyncio.gather(*[_search(s) for s in servers], return_exceptions=True)
        for r in results:
            if isinstance(r, tuple) and r[0] is not None:
                return r
        return None, None

    async def find_client_by_email(self, email: str) -> tuple[dict, dict] | tuple[None, None]:
        servers = self._settings.get_enabled_servers()
        if not servers:
            return None, None

        async def _search(server: dict) -> tuple[dict, dict] | None:
            try:
                xui = build_xui_client(server)
                clients = await self._get_clients_cached(xui)
                for c in clients:
                    if c.get("email") == email:
                        return c, server
            except Exception:
                pass
            return None

        results = await asyncio.gather(*[_search(s) for s in servers], return_exceptions=True)
        for r in results:
            if isinstance(r, tuple) and r[0] is not None:
                return r
        return None, None

    async def _send_telegram_document(
        self, bot_token: str, chat_id: int, file_content: bytes, filename: str, caption: str = ""
    ) -> bool:
        url = f"https://api.telegram.org/bot{bot_token}/sendDocument"
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                files = {"document": (filename, file_content)}
                data = {"chat_id": chat_id, "caption": caption, "parse_mode": "HTML"}
                resp = await client.post(url, data=data, files=files)
                return resp.status_code == 200 and resp.json().get("ok", False)
        except Exception as exc:
            logger.warning("Failed to send Telegram document to %s: %s", chat_id, exc)
            return False

    async def _send_telegram_message(
        self, bot_token: str, chat_id: int, text: str
    ) -> bool:
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        # Telegram caps a message at 4096 characters; split long link lists.
        chunks: list[str] = []
        current = ""
        for line in text.splitlines():
            candidate = f"{current}\n{line}" if current else line
            if len(candidate) > 3800 and current:
                chunks.append(current)
                current = line
            else:
                current = candidate
        if current:
            chunks.append(current)
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                for chunk in chunks:
                    resp = await client.post(
                        url,
                        data={"chat_id": chat_id, "text": chunk, "disable_web_page_preview": "true"},
                    )
                    if resp.status_code != 200 or not resp.json().get("ok", False):
                        return False
            return True
        except Exception as exc:
            logger.warning("Failed to send Telegram message to %s: %s", chat_id, exc)
            return False

    # ------------------------------------------------------------------ #
    # Read
    # ------------------------------------------------------------------ #
    async def get_user_configs(self, telegram_id: int) -> tuple[list[VpnConfigResponse], list[str]]:
        prefix = f"{telegram_id}-"
        results: list[VpnConfigResponse] = []
        errors: list[str] = []

        async def _fetch(server: dict) -> tuple[list[VpnConfigResponse], str | None]:
            server_name = server.get("name", server.get("server_name", ""))
            try:
                xui = build_xui_client(server)
                clients = await xui.get_clients_by_email_prefix(prefix)
                return [_client_to_response(c, server_name, telegram_id) for c in clients], None
            except Exception as exc:
                msg = f"get_user_configs error on server {server_name}: {exc}"
                return [], msg

        server_tasks = [_fetch(s) for s in self._settings.get_enabled_servers()]
        task_results = await asyncio.gather(*server_tasks)
        for configs, err in task_results:
            results.extend(configs)
            if err:
                errors.append(err)
        return results, errors

    async def list_all_configs(self, skip: int = 0, limit: int = 50) -> list[VpnConfigResponse]:
        results: list[VpnConfigResponse] = []

        async def _fetch(server: dict) -> list[VpnConfigResponse]:
            server_name = server.get("name", server.get("server_name", ""))
            try:
                xui = build_xui_client(server)
                clients = await self._get_clients_cached(xui)
                res = []
                for c in clients:
                    tid = _parse_telegram_id_from_email(c.get("email", ""))
                    res.append(_client_to_response(c, server_name, tid or 0))
                return res
            except Exception as exc:
                logger.warning("list_all_configs error on server %s: %s", server_name, exc)
                return []

        server_tasks = [_fetch(s) for s in self._settings.get_server_list()]
        task_results = await asyncio.gather(*server_tasks)
        for configs in task_results:
            results.extend(configs)
        return results[skip: skip + limit]

    async def get_user_configs_admin(self, telegram_id: int) -> tuple[list[VpnConfigResponse], list[str]]:
        prefix = f"{telegram_id}-"
        results: list[VpnConfigResponse] = []
        errors: list[str] = []

        async def _fetch(server: dict) -> tuple[list[VpnConfigResponse], str | None]:
            server_name = server.get("name", server.get("server_name", ""))
            try:
                xui = build_xui_client(server)
                clients = await xui.get_clients_by_email_prefix(prefix)
                return [_client_to_response(c, server_name, telegram_id) for c in clients], None
            except Exception as exc:
                msg = f"get_user_configs_admin error on server {server_name}: {exc}"
                return [], msg

        server_tasks = [_fetch(s) for s in self._settings.get_enabled_servers()]
        task_results = await asyncio.gather(*server_tasks)
        for configs, err in task_results:
            results.extend(configs)
            if err:
                errors.append(err)
        return results, errors

    # ------------------------------------------------------------------ #
    # Create
    # ------------------------------------------------------------------ #
    async def create_config(
        self,
        telegram_id: int,
        name: str,
        total_gb: float,
        duration_days: int,
        inbound_ids: Optional[list[int]] = None,
        limit_ip: int = 0,
    ) -> VpnConfigResponse:
        server = self._settings.get_enabled_servers()[0]
        server_name = server.get("name", server.get("server_name", ""))
        email = f"{telegram_id}-{name}"
        config_uuid = str(uuid.uuid4())
        sub_id = hashlib.md5(
            f"{telegram_id}-{name}-{config_uuid}".encode()
        ).hexdigest()[:16]
        expiry_time = 0
        if duration_days > 0:
            expiry_time = int(
                (datetime.now(timezone.utc).timestamp() + duration_days * 86400) * 1000
            )
        client_data = {
            "id": config_uuid,
            "email": email,
            "enable": True,
            "totalGB": int(total_gb * 1024**3),
            "expiryTime": expiry_time,
            "flow": "",
            "limitIp": max(0, int(limit_ip)),
            "tgId": telegram_id,
            "subId": sub_id,
        }
        xui = build_xui_client(server)
        if not inbound_ids:
            defaults_doc = await self._db.settings.find_one({"_id": "available_inbound_ids"})
            default_ids = defaults_doc.get("inbound_ids", []) if defaults_doc else []
            resolved_inbound_ids: list[int] = default_ids or [int(server.get("inbound_id", 1))]
        else:
            resolved_inbound_ids = inbound_ids
        result = await xui.add_client_to_inbounds(resolved_inbound_ids, client_data)
        if not result.get("success"):
            raise RuntimeError(f"Failed to create config on server: {result.get('msg')}")

        await self._db.users.update_one(
            {"telegram_id": telegram_id},
            {"$inc": {"traffic_balance_gb": -total_gb}},
        )

        resolved_inbound_names: list[str] = []
        try:
            ib_map = await xui.get_inbound_map()
            for ib_id in resolved_inbound_ids:
                ib = ib_map.get(ib_id)
                if ib:
                    resolved_inbound_names.append(ib.get("remark", f"inbound-{ib_id}"))
        except Exception:
            pass

        sub_link = await xui.build_subscription_link(sub_id)
        response = _client_to_response(
            {
                "uuid": config_uuid,
                "email": email,
                "enable": True,
                "total_gb": total_gb,
                "expiry_time_ms": expiry_time,
                "usage_up": 0,
                "usage_down": 0,
                "last_online": 0,
                "subId": sub_id,
                "subscription_link": sub_link,
                "limit_ip": max(0, int(limit_ip)),
                "inbound_ids": resolved_inbound_ids,
                "inbound_names": resolved_inbound_names,
            },
            server_name,
            telegram_id,
        )
        await self._db.usage_snapshots.update_one(
            {"uuid": config_uuid},
            {
                "$set": {
                    "usage_up": 0.0,
                    "usage_down": 0.0,
                    "client_status": "active",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )
        try:
            await self._update_today_config_status(
                config_uuid,
                response.status.value,
                email=email,
                server_name=server_name,
                upsert=True,
            )
        except Exception as exc:
            logger.warning(
                "create_config: failed to initialise usage bucket for %s: %s",
                config_uuid,
                exc,
            )
        return response

    # ------------------------------------------------------------------ #
    # Update
    # ------------------------------------------------------------------ #
    async def toggle_config(
        self, email: str, telegram_id: int, role: str
    ) -> VpnConfigResponse:
        tid = _parse_telegram_id_from_email(email)
        if tid != telegram_id and role != "admin":
            raise PermissionError("Access denied")
        client, server = await self.find_client_by_email(email)
        if not client or not server:
            raise ValueError("Config not found")
        inbound_id = client.get("inbound_id") or int(server.get("inbound_id", 1))
        server_name = server.get("name", server.get("server_name", ""))
        client_data = {
            "id": client["uuid"],
            "email": email,
            "enable": not client.get("enable", True),
            "totalGB": int(client.get("total_gb", 0) * 1024**3),
            "expiryTime": client.get("expiry_time_ms", 0),
            "flow": "",
            "limitIp": int(client.get("limit_ip", 0) or 0),
            "tgId": tid or 0,
            "subId": client.get("subId", ""),
        }
        xui = build_xui_client(server)
        result = await xui.update_client(email, client_data)
        if not result.get("success"):
            raise RuntimeError(f"Failed to toggle config: {result.get('msg')}")
        response = _client_to_response(
            {**client, "enable": not client.get("enable", True)},
            server_name,
            tid or telegram_id,
        )
        config_uuid = client.get("uuid", "")
        if config_uuid:
            try:
                await self._update_today_config_status(config_uuid, response.status.value)
            except Exception as exc:
                logger.warning(
                    "toggle_config: failed to update usage status for %s: %s",
                    config_uuid,
                    exc,
                )
        return response

    async def edit_config(
        self,
        email: str,
        telegram_id: int,
        role: str,
        name: Optional[str] = None,
        total_gb: Optional[float] = None,
        duration_days: Optional[int] = None,
    ) -> VpnConfigResponse:
        tid = _parse_telegram_id_from_email(email)
        if tid != telegram_id and role != "admin":
            raise PermissionError("Access denied")
        client, server = await self.find_client_by_email(email)
        if not client or not server:
            raise ValueError("Config not found")
        if total_gb is not None:
            diff = total_gb - client.get("total_gb", 0)
            if diff > 0:
                user = await self._db.users.find_one({"telegram_id": tid}, {"traffic_balance_gb": 1})
                balance = (user or {}).get("traffic_balance_gb", 0)
                if balance < diff:
                    raise ValueError(
                        f"Insufficient traffic balance. Need {diff:.2f} GB, have {balance:.2f} GB"
                    )
            if diff != 0:
                await self._db.users.update_one(
                    {"telegram_id": telegram_id},
                    {"$inc": {"traffic_balance_gb": -diff}},
                )
        inbound_id = client.get("inbound_id") or int(server.get("inbound_id", 1))
        server_name = server.get("name", server.get("server_name", ""))
        new_email = f"{tid}-{name}" if name else email
        expiry_time = client.get("expiry_time_ms", 0)
        if duration_days is not None and duration_days > 0:
            expiry_time = int(
                (datetime.now(timezone.utc).timestamp() + duration_days * 86400) * 1000
            )
        elif duration_days == 0:
            expiry_time = 0
        client_data = {
            "id": client["uuid"],
            "email": new_email,
            "enable": client.get("enable", True),
            "totalGB": int((total_gb or client.get("total_gb", 0)) * 1024**3),
            "expiryTime": expiry_time,
            "flow": "",
            "limitIp": int(client.get("limit_ip", 0) or 0),
            "tgId": tid or 0,
            "subId": client.get("subId", ""),
        }
        xui = build_xui_client(server)
        result = await xui.update_client(email, client_data)
        if not result.get("success"):
            if total_gb is not None:
                diff = total_gb - client.get("total_gb", 0)
                await self._db.users.update_one(
                    {"telegram_id": telegram_id},
                    {"$inc": {"traffic_balance_gb": diff}},
                )
            raise RuntimeError(f"XUI error: {result.get('msg')}")
        updated_client = {
            **client,
            "email": new_email,
            "enable": client.get("enable", True),
            "total_gb": total_gb or client.get("total_gb", 0),
            "expiry_time_ms": expiry_time,
        }
        response = _client_to_response(
            updated_client, server_name, tid or telegram_id
        )
        config_uuid = client.get("uuid", "")
        if config_uuid:
            try:
                await self._update_today_config_status(config_uuid, response.status.value)
            except Exception as exc:
                logger.warning(
                    "edit_config: failed to update usage status for %s: %s",
                    config_uuid,
                    exc,
                )
        return response

    async def get_subscription_link(
        self, email: str, telegram_id: int, role: str
    ) -> str:
        tid = _parse_telegram_id_from_email(email)
        if tid != telegram_id and role != "admin":
            raise PermissionError("Access denied")
        client, server = await self.find_client_by_email(email)
        if not client or not server:
            raise ValueError("Config not found")
        sub_id = client.get("subId", "")
        if not sub_id:
            return ""
        xui = build_xui_client(server)
        return await xui.build_subscription_link(sub_id)

    async def get_proxies(
        self, email: str, telegram_id: int, role: str
    ) -> list[dict]:
        tid = _parse_telegram_id_from_email(email)
        if tid != telegram_id and role != "admin":
            raise PermissionError("Access denied")
        client, server = await self.find_client_by_email(email)
        if not client or not server:
            raise ValueError("Config not found")
        xui = build_xui_client(server)
        sub_id = client.get("subId", "")
        links = await xui.get_sub_links(sub_id) if sub_id else []
        if not links:
            links = await xui.get_client_links(email) or []
        ignore_names = {email, _parse_name_from_email(email)}
        names = [proxy_display_name(link, idx, ignore_names) for idx, link in enumerate(links)]
        counts: dict[str, int] = {}
        for name in names:
            counts[name] = counts.get(name, 0) + 1
        result = []
        used: dict[str, int] = {}
        for idx, link in enumerate(links):
            name = names[idx] if counts[names[idx]] == 1 else _proxy_endpoint_label(link, idx)
            used[name] = used.get(name, 0) + 1
            if used[name] > 1:
                name = f"{name} ({used[name]})"
            result.append({"name": name, "link": link})
        return result

    async def send_links_to_bot(
        self,
        email: str,
        telegram_id: int,
        role: str,
        bot_token: str,
    ) -> dict:
        tid = _parse_telegram_id_from_email(email)
        if tid != telegram_id and role != "admin":
            raise PermissionError("Access denied")
        client, server = await self.find_client_by_email(email)
        if not client or not server:
            raise ValueError("Config not found")
        xui = build_xui_client(server)
        sub_id = client.get("subId", "")
        links = await xui.get_sub_links(sub_id) if sub_id else []
        if not links:
            links = await xui.get_client_links(email) or []
        if not links:
            raise RuntimeError("No config links available for this config")
        name_only = _parse_name_from_email(email)
        text = f"{name_only}\n\n" + "\n".join(links)
        success = await self._send_telegram_message(bot_token, telegram_id, text)
        if not success:
            raise RuntimeError("Failed to send config list via Telegram Bot")
        return {
            "status": "success",
            "message": "Config list sent to your Telegram!",
            "count": len(links),
        }

    async def regenerate_key(
        self, email: str, telegram_id: int, role: str
    ) -> VpnConfigResponse:
        tid = _parse_telegram_id_from_email(email)
        if tid != telegram_id and role != "admin":
            raise PermissionError("Access denied")
        client, server = await self.find_client_by_email(email)
        if not client or not server:
            raise ValueError("Config not found")
        inbound_id = client.get("inbound_id") or int(server.get("inbound_id", 1))
        server_name = server.get("name", server.get("server_name", ""))
        new_uuid = str(uuid.uuid4())
        client_data = {
            "id": new_uuid,
            "email": email,
            "enable": client.get("enable", True),
            "totalGB": int(client.get("total_gb", 0) * 1024**3),
            "expiryTime": client.get("expiry_time_ms", 0),
            "flow": "",
            "limitIp": int(client.get("limit_ip", 0) or 0),
            "tgId": tid or 0,
            "subId": client.get("subId", ""),
        }
        xui = build_xui_client(server)
        result = await xui.update_client(email, client_data)
        if not result.get("success"):
            raise RuntimeError(f"Failed to regenerate key: {result.get('msg')}")
        refreshed = {**client, "uuid": new_uuid}
        return _client_to_response(refreshed, server_name, tid or telegram_id)

    # ------------------------------------------------------------------ #
    # Delete
    # ------------------------------------------------------------------ #
    async def delete_config(
        self, email: str, telegram_id: int, role: str
    ) -> None:
        tid = _parse_telegram_id_from_email(email)
        if tid != telegram_id and role != "admin":
            raise PermissionError("Access denied")
        client, server = await self.find_client_by_email(email)
        if not client or not server:
            raise ValueError("Config not found")
        inbound_id = client.get("inbound_id") or int(server.get("inbound_id", 1))
        xui = build_xui_client(server)
        result = await xui.delete_client(email)
        if not result.get("success"):
            raise RuntimeError(f"Failed to delete config: {result.get('msg')}")
        total_gb = client.get("total_gb", 0.0)
        usage_bytes = client.get("usage_up", 0) + client.get("usage_down", 0)
        used_gb = usage_bytes / (1024**3)
        refund_gb = max(0.0, total_gb - used_gb)
        if refund_gb > 0 and tid:
            await self._db.users.update_one(
                {"telegram_id": tid},
                {"$inc": {"traffic_balance_gb": refund_gb}},
            )
        config_uuid = client.get("uuid", "")
        if config_uuid:
            try:
                await self._update_today_config_status(config_uuid, "deleted")
            except Exception as exc:
                logger.warning(
                    "delete_config: failed to mark usage status deleted for %s: %s",
                    config_uuid,
                    exc,
                )

    # ------------------------------------------------------------------ #
    # VLESS URI & Subscription
    # ------------------------------------------------------------------ #
    async def get_vless_uri(
        self, config_uuid: str, isp_name: str, telegram_id: int, role: str
    ) -> dict:
        client, server = await self.find_client_by_uuid(config_uuid)
        if not client or not server:
            raise ValueError("Config not found")
        tid = _parse_telegram_id_from_email(client.get("email", ""))
        if tid != telegram_id and role != "admin":
            raise PermissionError("Access denied")
        domain = server.get("ip", server.get("ip_address", ""))
        if "://" in domain:
            domain = domain.split("://")[1]
        if ":" in domain:
            domain = domain.split(":")[0]
        email = client.get("email", "")
        clean_ip = domain
        if isp_name and isp_name != "default":
            clean_ip_settings = await self._db.settings.find_one({"_id": "clean_ips"})
            clean_ip_items = clean_ip_settings.get("items", []) if clean_ip_settings else []
            clean_ip_entry = next(
                (i for i in clean_ip_items if i["isp_name"] == isp_name), None
            )
            if clean_ip_entry:
                clean_ip = clean_ip_entry["ip_address"]
        xui = build_xui_client(server)
        links = await xui.get_client_links(email)
        vless_uri = links[0] if links else ""
        sub_id = client.get("subId", "")
        subscription_link = await xui.build_subscription_link(sub_id) if sub_id else ""
        return {
            "vless_uri": vless_uri,
            "clean_ip": clean_ip,
            "domain": domain,
            "subscription_link": subscription_link,
        }

    async def send_config_to_bot(
        self,
        email: str,
        password: str,
        telegram_id: int,
        role: str,
        bot_token: str,
    ) -> dict:
        import pyzipper
        import qrcode

        client, server = await self.find_client_by_email(email)
        if not client or not server:
            raise ValueError("Config not found")

        tid = _parse_telegram_id_from_email(client.get("email", ""))
        if tid != telegram_id and role != "admin":
            raise PermissionError("Access denied")

        name_only = _parse_name_from_email(client.get("email", ""))
        email = client.get("email", "")

        xui = build_xui_client(server)
        sub_id = client.get("subId", "")
        subscription_link = await xui.build_subscription_link(sub_id) if sub_id else ""

        def _make_qr_png(text: str) -> bytes:
            img = qrcode.make(text)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return buf.getvalue()

        sub_links = await xui.get_sub_links(sub_id) if sub_id else []

        zip_buf = io.BytesIO()
        with pyzipper.AESZipFile(
            zip_buf, "w", compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES
        ) as zf:
            zf.setpassword(password.encode("utf-8"))

            if subscription_link:
                zf.writestr("0_subscription_qr.png", _make_qr_png(subscription_link))

            for idx, link in enumerate(sub_links):
                zf.writestr(
                    f"proxy_{idx+1}_qr.png",
                    _make_qr_png(link),
                )

        zip_buf.seek(0)
        zip_content = zip_buf.getvalue()
        filename = f"{name_only or email}.zip"

        caption = (
            f"Config ZIP: {name_only}\n\n"
            f"Password: {password}\n\n"
            f"This file contains all QR codes for your connection."
        )
        success = await self._send_telegram_document(
            bot_token, telegram_id, zip_content, filename, caption
        )
        if not success:
            raise RuntimeError("Failed to send ZIP via Telegram Bot")
        return {"status": "success", "message": "Config ZIP sent to your Telegram!"}
