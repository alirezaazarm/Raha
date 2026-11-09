import httpx
import json
import logging
from typing import Optional, Any
from urllib.parse import urlparse, quote

logger = logging.getLogger(__name__)

_cookie_cache: dict[str, str] = {}
_csrf_cache: dict[str, str] = {}
_prefix_cache: dict[str, str] = {}

_MAX_SANE_TIMESTAMP_MS = 253402300799000  # year 9999 in ms

_BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
}


def _parse_settings(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return {}


class AsyncXUIClient:
    def __init__(
        self,
        base_url: str,
        username: str = "",
        password: str = "",
        inbound_id: int = 1,
        server_name: str = "",
        db: Any = None,
        api_token: Optional[str] = None,
        base_path: str = "",
        sub_uri: Optional[str] = None,
        sub_port: Optional[int] = None,
        sub_path: str = "",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.inbound_id = inbound_id
        self.server_name = server_name
        self.api_token = (api_token or "").strip()
        self._bearer = bool(self.api_token)
        self._fallback_to_cookie = False
        self._base_path = base_path or ""
        self.sub_uri = sub_uri
        self.sub_port = sub_port
        self.sub_path = sub_path or ""
        self._cookie = _cookie_cache.get(server_name, "")
        self._csrf_token = _csrf_cache.get(server_name, "")
        self._prefix = _prefix_cache.get(server_name, self._base_path)
        self._panel_settings: Optional[dict] = None

    def _make_client(self, extra_headers: Optional[dict] = None) -> httpx.AsyncClient:
        headers = dict(_BASE_HEADERS)
        if self._bearer:
            headers["Authorization"] = f"Bearer {self.api_token}"
        else:
            if self._cookie:
                headers["Cookie"] = self._cookie
            if self._csrf_token:
                headers["X-CSRF-Token"] = self._csrf_token
        if extra_headers:
            headers.update(extra_headers)
        return httpx.AsyncClient(headers=headers, verify=False, timeout=30, follow_redirects=False)

    async def login(self) -> str:
        if self._bearer:
            return ""
        candidates: list[str] = []
        if self._base_path:
            candidates.append(self._base_path)
        if "" not in candidates:
            candidates.append("")
        if "/xui" not in candidates:
            candidates.append("/xui")
        for prefix in candidates:
            csrf_url = f"{self.base_url}{prefix}/csrf-token"
            login_url = f"{self.base_url}{prefix}/login"
            try:
                async with httpx.AsyncClient(
                    headers=_BASE_HEADERS, verify=False, timeout=15, follow_redirects=False
                ) as client:
                    csrf_resp = await client.get(csrf_url)
                    if csrf_resp.status_code != 200:
                        continue
                    csrf_data = csrf_resp.json()
                    if not csrf_data.get("success"):
                        continue
                    csrf_token = csrf_data.get("obj", "")
                    if not csrf_token:
                        continue
                    session_cookie = csrf_resp.headers.get("set-cookie", "").split(";")[0]
                    if not session_cookie:
                        continue
                    login_headers = dict(_BASE_HEADERS)
                    login_headers["Cookie"] = session_cookie
                    login_headers["X-CSRF-Token"] = csrf_token
                    login_headers["Content-Type"] = "application/json"
                    login_resp = await client.post(
                        login_url,
                        json={"username": self.username, "password": self.password},
                        headers=login_headers,
                    )
                    if login_resp.status_code != 200:
                        continue
                    login_data = login_resp.json()
                    if not login_data.get("success"):
                        continue
                    session_cookie = (
                        login_resp.headers.get("set-cookie", "").split(";")[0]
                        or session_cookie
                    )
                    self._prefix = prefix
                    _prefix_cache[self.server_name] = prefix
                    self._cookie = session_cookie
                    _cookie_cache[self.server_name] = session_cookie
                    self._csrf_token = csrf_token
                    _csrf_cache[self.server_name] = csrf_token
                    return self._cookie
            except Exception:
                continue
        raise RuntimeError(f"XUI login failed for {self.server_name}")

    async def _request(
        self, method: str, path: str, retry_on_401: bool = True, **kwargs
    ) -> httpx.Response:
        if not self._cookie and not self._bearer:
            await self.login()
        if self._bearer and self._fallback_to_cookie:
            self._bearer = False
        url = f"{self.base_url}{self._prefix}{path}"
        async with self._make_client() as client:
            try:
                resp = await client.request(method, url, **kwargs)
                if resp.status_code == 401:
                    if retry_on_401:
                        if self._bearer and self.username:
                            self._bearer = False
                            self._fallback_to_cookie = True
                            await self.login()
                            return await self._request(
                                method, path, retry_on_401=False, **kwargs
                            )
                        if not self._bearer:
                            await self.login()
                            return await self._request(
                                method, path, retry_on_401=False, **kwargs
                            )
                if not self._bearer:
                    if resp.status_code == 404:
                        await self.login()
                        url = f"{self.base_url}{self._prefix}{path}"
                        async with self._make_client() as client2:
                            resp = await client2.request(method, url, **kwargs)
                return resp
            except httpx.RequestError as exc:
                raise RuntimeError(f"Connection error: {exc}")

    async def get_inbounds(self) -> list:
        resp = await self._request("GET", "/panel/api/inbounds/list")
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def get_inbound_list(self) -> list[dict]:
        resp = await self._request("GET", "/panel/api/inbounds/list")
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def get_inbound_map(self) -> dict[int, dict]:
        inbounds = await self.get_inbound_list()
        return {ib["id"]: ib for ib in inbounds if "id" in ib}

    async def get_inbound_options(self) -> list:
        resp = await self._request("GET", "/panel/api/inbounds/options")
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def _ensure_sub_settings(self) -> None:
        if self._panel_settings is not None:
            return
        try:
            resp = await self._request("GET", "/panel/api/setting/all")
            if resp.status_code == 200:
                data = resp.json()
                if data.get("success"):
                    self._panel_settings = data.get("obj") or {}
                    return
        except Exception:
            pass
        self._panel_settings = {}

    async def build_subscription_link(self, sub_id: str) -> str:
        if not sub_id:
            return ""
        await self._ensure_sub_settings()
        settings = self._panel_settings or {}
        sub_uri = settings.get("subURI", "") or self.sub_uri or ""
        sub_path = settings.get("subPath", "") or self.sub_path or ""
        port = settings.get("subPort") or self.sub_port
        return _build_subscription_url(
            self.base_url, sub_id,
            sub_uri=sub_uri,
            sub_port=port,
            sub_path=sub_path,
        )

    async def add_client(self, inbound_id: int, client_data: dict) -> dict:
        payload = {"client": client_data, "inboundIds": [inbound_id]}
        resp = await self._request("POST", "/panel/api/clients/add", json=payload)
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def add_client_to_inbounds(self, inbound_ids: list[int], client_data: dict) -> dict:
        payload = {"client": client_data, "inboundIds": inbound_ids}
        resp = await self._request("POST", "/panel/api/clients/add", json=payload)
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def update_client(self, email: str, client_data: dict) -> dict:
        resp = await self._request(
            "POST",
            f"/panel/api/clients/update/{quote(email, safe='')}",
            json=client_data,
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def delete_client(self, email: str, keep_traffic: bool = False) -> dict:
        path = f"/panel/api/clients/del/{quote(email, safe='')}"
        path += f"?keepTraffic={'1' if keep_traffic else '0'}"
        resp = await self._request("POST", path)
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def get_client_links(self, email: str) -> list:
        resp = await self._request(
            "GET", f"/panel/api/clients/links/{quote(email, safe='')}"
        )
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def get_sub_links(self, sub_id: str) -> list:
        if not sub_id:
            return []
        resp = await self._request(
            "GET", f"/panel/api/clients/subLinks/{quote(sub_id, safe='')}"
        )
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def get_online_emails(self) -> list:
        resp = await self._request("POST", "/panel/api/clients/onlines")
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def get_client_by_email(self, email: str) -> dict:
        resp = await self._request(
            "GET", f"/panel/api/clients/get/{quote(email, safe='')}"
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("obj") or {}
        return {}

    async def bulk_disable_clients(self, emails: list[str]) -> dict:
        resp = await self._request(
            "POST",
            "/panel/api/clients/bulkDisable",
            json={"emails": emails},
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def _last_online_map(self) -> dict[str, int]:
        resp = await self._request("POST", "/panel/api/clients/lastOnline")
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            if isinstance(obj, dict):
                return {k: int(v) * 1000 for k, v in obj.items() if v}
        return {}

    async def _enrich_clients(self, raw_clients: list, last_online_map: dict, inbound_map: dict[int, dict] | None = None) -> list[dict]:
        await self._ensure_sub_settings()
        settings = self._panel_settings or {}
        sub_uri = settings.get("subURI", "") or self.sub_uri or ""
        sub_path = settings.get("subPath", "") or self.sub_path or ""
        port = settings.get("subPort") or self.sub_port
        clients: list[dict] = []
        for c in raw_clients:
            traffic = c.get("traffic") or {}
            inbound_ids = c.get("inboundIds") or []
            sub_id = c.get("subId") or ""
            uuid_val = c.get("uuid") or c.get("id") or ""
            total_gb = (
                float(c.get("totalGB", 0) or 0) / (1024**3)
                if c.get("totalGB")
                else 0.0
            )
            sub_link = _build_subscription_url(self.base_url, sub_id, sub_uri=sub_uri, sub_port=port, sub_path=sub_path) if sub_id else ""
            inbound_names = []
            if inbound_map:
                for ib_id in inbound_ids:
                    ib = inbound_map.get(ib_id)
                    if ib:
                        inbound_names.append(ib.get("remark", f"inbound-{ib_id}"))
            clients.append({
                "uuid": str(uuid_val),
                "email": c.get("email") or "",
                "inbound_id": inbound_ids[0] if inbound_ids else self.inbound_id,
                "inbound_ids": inbound_ids,
                "inbound_names": inbound_names,
                "usage_up": float(traffic.get("up", 0) or 0),
                "usage_down": float(traffic.get("down", 0) or 0),
                "total_gb": total_gb,
                "expiry_time_ms": min(int(c.get("expiryTime", 0) or 0), _MAX_SANE_TIMESTAMP_MS),
                "enable": bool(c.get("enable", traffic.get("enable", True))),
                "limit_ip": int(c.get("limitIp", 0) or 0),
                "last_online": int(last_online_map.get(c.get("email"), 0) or 0),
                "subId": sub_id,
                "subscription_link": sub_link,
            })
        return clients

    async def get_client_info(self, email: Optional[str] = None) -> list:
        resp = await self._request("GET", "/panel/api/clients/list")
        if resp.status_code != 200:
            return []
        data = resp.json()
        if not data.get("success"):
            return []
        raw_clients = data.get("obj")
        if not isinstance(raw_clients, list):
            return []
        
        if email:
            raw_clients = [c for c in raw_clients if c.get("email") == email]

        try:
            last_online_map = await self._last_online_map()
        except Exception:
            last_online_map = {}

        inbound_map = None
        try:
            inbound_map = await self.get_inbound_map()
        except Exception:
            pass

        return await self._enrich_clients(raw_clients, last_online_map, inbound_map=inbound_map)

    async def get_hosts(self, inbound_id: int) -> list:
        resp = await self._request("GET", f"/panel/api/hosts/byInbound/{inbound_id}")
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def get_inbound_slim(self) -> list:
        resp = await self._request("GET", "/panel/api/inbounds/list/slim")
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def get_inbound(self, inbound_id: int) -> dict:
        resp = await self._request("GET", f"/panel/api/inbounds/get/{inbound_id}")
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("obj") or {}
        return {}

    async def add_inbound(self, data: dict) -> dict:
        resp = await self._request("POST", "/panel/api/inbounds/add", json=data)
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def update_inbound(self, inbound_id: int, data: dict) -> dict:
        resp = await self._request(
            "POST", f"/panel/api/inbounds/update/{inbound_id}", json=data
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def delete_inbound(self, inbound_id: int) -> dict:
        resp = await self._request(
            "POST", f"/panel/api/inbounds/del/{inbound_id}"
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def bulk_delete_inbounds(self, ids: list[int]) -> dict:
        resp = await self._request(
            "POST", "/panel/api/inbounds/bulkDel", json={"inboundIds": ids}
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def set_inbound_enable(self, inbound_id: int, enable: bool) -> dict:
        resp = await self._request(
            "POST",
            f"/panel/api/inbounds/setEnable/{inbound_id}",
            json={"enable": enable},
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def reset_inbound_traffic(self, inbound_id: int) -> dict:
        resp = await self._request(
            "POST", f"/panel/api/inbounds/{inbound_id}/resetTraffic"
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def delete_all_inbound_clients(self, inbound_id: int) -> dict:
        resp = await self._request(
            "POST", f"/panel/api/inbounds/{inbound_id}/delAllClients"
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def reset_all_inbounds_traffic(self) -> dict:
        resp = await self._request(
            "POST", "/panel/api/inbounds/resetAllTraffics"
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def get_inbound_fallbacks(self, inbound_id: int) -> list:
        resp = await self._request(
            "GET", f"/panel/api/inbounds/{inbound_id}/fallbacks"
        )
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def set_inbound_fallbacks(self, inbound_id: int, fallbacks: list) -> dict:
        resp = await self._request(
            "POST",
            f"/panel/api/inbounds/{inbound_id}/fallbacks",
            json={"fallbacks": fallbacks},
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def get_server_status(self) -> dict:
        resp = await self._request("GET", "/panel/api/server/status")
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("obj") or {}
        return {}

    async def restart_xray(self) -> dict:
        resp = await self._request("POST", "/panel/api/server/restartXrayService")
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def get_xray_version(self) -> list:
        resp = await self._request("GET", "/panel/api/server/getXrayVersion")
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def get_config_json(self) -> dict:
        resp = await self._request("GET", "/panel/api/server/getConfigJson")
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("obj") or {}
        return {}

    async def get_all_settings(self) -> dict:
        resp = await self._request("GET", "/panel/api/setting/all")
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("obj") or {}
        return {}

    async def get_new_uuid(self) -> str:
        resp = await self._request("GET", "/panel/api/server/getNewUUID")
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("obj") or ""
        return ""

    async def get_new_x25519_cert(self) -> dict:
        resp = await self._request("GET", "/panel/api/server/getNewX25519Cert")
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("obj") or {}
        return {}

    async def add_host(self, host_data: dict) -> dict:
        resp = await self._request("POST", "/panel/api/hosts/add", json=host_data)
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def update_host(self, host_data: dict) -> dict:
        resp = await self._request(
            "POST", "/panel/api/hosts/update", json=host_data
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def delete_host(self, host_id: int) -> dict:
        resp = await self._request(
            "POST", f"/panel/api/hosts/del/{host_id}"
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def reset_client_traffic(self, email: str) -> dict:
        resp = await self._request(
            "POST",
            f"/panel/api/clients/resetTraffic/{quote(email, safe='')}",
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def get_client_traffic(self, email: str) -> dict:
        resp = await self._request(
            "GET",
            f"/panel/api/clients/traffic/{quote(email, safe='')}",
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("obj") or {}
        return {}

    async def attach_client(self, email: str, inbound_ids: list[int]) -> dict:
        resp = await self._request(
            "POST",
            f"/panel/api/clients/{quote(email, safe='')}/attach",
            json={"inboundIds": inbound_ids},
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def detach_client(self, email: str, inbound_ids: list[int]) -> dict:
        resp = await self._request(
            "POST",
            f"/panel/api/clients/{quote(email, safe='')}/detach",
            json={"inboundIds": inbound_ids},
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def bulk_delete_clients(
        self, emails: list[str], keep_traffic: bool = False
    ) -> dict:
        resp = await self._request(
            "POST",
            "/panel/api/clients/bulkDel",
            json={"emails": emails, "keepTraffic": keep_traffic},
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def bulk_create_clients(self, payload: list[dict]) -> dict:
        resp = await self._request(
            "POST", "/panel/api/clients/bulkCreate", json=payload
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def bulk_enable_clients(self, emails: list[str]) -> dict:
        resp = await self._request(
            "POST",
            "/panel/api/clients/bulkEnable",
            json={"emails": emails},
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def bulk_reset_traffic(self, emails: list[str]) -> dict:
        resp = await self._request(
            "POST",
            "/panel/api/clients/bulkResetTraffic",
            json={"emails": emails},
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def bulk_adjust_clients(
        self,
        emails: list[str],
        add_days: Optional[int] = None,
        add_bytes: Optional[int] = None,
        flow: Optional[str] = None,
    ) -> dict:
        body: dict = {"emails": emails}
        if add_days is not None:
            body["addDays"] = add_days
        if add_bytes is not None:
            body["addBytes"] = add_bytes
        if flow is not None:
            body["flow"] = flow
        resp = await self._request(
            "POST", "/panel/api/clients/bulkAdjust", json=body
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def update_client_traffic(
        self, email: str, upload: int, download: int
    ) -> dict:
        resp = await self._request(
            "POST",
            f"/panel/api/clients/updateTraffic/{quote(email, safe='')}",
            json={"upload": upload, "download": download},
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def get_client_ips(self, email: str) -> list:
        resp = await self._request(
            "POST",
            f"/panel/api/clients/ips/{quote(email, safe='')}",
        )
        if resp.status_code == 200:
            obj = resp.json().get("obj")
            return obj if isinstance(obj, list) else []
        return []

    async def clear_client_ips(self, email: str) -> dict:
        resp = await self._request(
            "POST",
            f"/panel/api/clients/clearIps/{quote(email, safe='')}",
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def get_clients_paged(
        self,
        page: int = 1,
        page_size: int = 25,
        search: str = "",
        filter_field: str = "",
        protocol: str = "",
        sort_field: str = "",
        order: str = "ascend",
    ) -> dict:
        params = {
            "page": page,
            "pageSize": page_size,
            "search": search,
            "filter": filter_field,
            "protocol": protocol,
            "sort": sort_field,
            "order": order,
        }
        resp = await self._request(
            "GET", "/panel/api/clients/list/paged", params=params
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("obj") or {}
        return {}

    async def delete_depleted_clients(self) -> dict:
        resp = await self._request(
            "POST", "/panel/api/clients/delDepleted"
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def delete_orphan_clients(self) -> dict:
        resp = await self._request(
            "POST", "/panel/api/clients/delOrphans"
        )
        return (
            resp.json()
            if resp.status_code == 200
            else {"success": False, "msg": f"HTTP {resp.status_code}"}
        )

    async def get_clients_by_email_prefix(self, prefix: str) -> list[dict]:
        results: list[dict] = []
        page = 1
        page_size = 100
        while True:
            paged = await self.get_clients_paged(
                page=page,
                page_size=page_size,
                search=prefix,
            )
            items = paged.get("items") or []
            total = paged.get("total", 0)
            if not items:
                break
            for item in items:
                if item.get("email", "").startswith(prefix):
                    results.append(item)
            if len(results) >= total or len(items) < page_size:
                break
            page += 1

        try:
            last_online_map = await self._last_online_map()
        except Exception:
            last_online_map = {}

        inbound_map = None
        try:
            inbound_map = await self.get_inbound_map()
        except Exception:
            pass

        return await self._enrich_clients(
            results, last_online_map, inbound_map=inbound_map
        )


def _build_subscription_url(
    base_url: str,
    sub_id: str,
    sub_uri: str = "",
    sub_port: Optional[int] = None,
    sub_path: str = "",
) -> str:
    if not sub_id:
        return ""
    if sub_uri:
        return f"{sub_uri.rstrip('/')}/{sub_id}"
    parsed = urlparse(base_url)
    domain = parsed.hostname or ""
    if not domain:
        return ""
    port = sub_port or 2096
    if sub_path:
        cleaned_path = sub_path.rstrip("/")
        if cleaned_path:
            return f"https://{domain}:{port}{cleaned_path}/{sub_id}"
    return f"https://{domain}:{port}/sub/{sub_id}"


def build_xui_client(server: dict) -> AsyncXUIClient:
    if "url" in server and server["url"]:
        base_url = server["url"].rstrip("/")
    else:
        ip = server.get("ip", server.get("ip_address", ""))
        port = server.get("port", server.get("panel_port", 2053))
        scheme = server.get("scheme", "")
        if ip.startswith("http://") or ip.startswith("https://"):
            base_url = f"{ip.rstrip('/')}:{port}"
        else:
            scheme = scheme or "http"
            base_url = f"{scheme}://{ip}:{port}"

    return AsyncXUIClient(
        base_url=base_url,
        username=server.get("username", ""),
        password=server.get("password", ""),
        inbound_id=int(server.get("inbound_id", 1)),
        server_name=server.get("name", ""),
        api_token=server.get("api_token"),
        base_path=server.get("base_path", ""),
        sub_uri=server.get("sub_uri"),
        sub_port=int(server["sub_port"]) if server.get("sub_port") else None,
        sub_path=server.get("sub_path", ""),
    )
