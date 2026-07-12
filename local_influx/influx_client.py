from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .config import Settings


VOLTAGE_FIELDS = (
    "inputVoltage",
    "inputVoltageR",
    "inputVoltageY",
    "inputVoltageB",
    "outputVoltage",
    "outputCurrent",
    "temperature",
)


def parse_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed


def parse_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value == "true":
        return True
    if value == "false":
        return False
    return None


def machine_identifier(payload: dict[str, Any], topic: str | None = None) -> str | None:
    if payload.get("machineCode") not in (None, ""):
        return str(payload["machineCode"]).strip()
    if payload.get("machineId") not in (None, ""):
        return str(payload["machineId"]).strip()

    prefix = "machine/data/"
    if topic and topic.startswith(prefix):
        candidate = topic[len(prefix) :].strip()
        if candidate and "/" not in candidate:
            return candidate

    return None


def _escape_key(value: str) -> str:
    return value.replace("\\", "\\\\").replace(" ", "\\ ").replace(",", "\\,").replace("=", "\\=")


def _format_field(value: Any) -> str:
    bool_value = parse_bool(value)
    if bool_value is not None:
        return "true" if bool_value else "false"

    number_value = parse_number(value)
    if number_value is not None:
        return str(number_value)

    text_value = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{text_value}"'


def _timestamp_ns(payload: dict[str, Any]) -> int:
    raw_value = payload.get("timestamp") or payload.get("time_date")
    if raw_value:
        try:
            normalized = str(raw_value).replace("Z", "+00:00")
            parsed = datetime.fromisoformat(normalized)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return int(parsed.timestamp() * 1_000_000_000)
        except ValueError:
            pass

    return int(datetime.now(timezone.utc).timestamp() * 1_000_000_000)


def build_line_protocol(payload: dict[str, Any], topic: str, settings: Settings) -> str | None:
    identifier = machine_identifier(payload, topic)
    if not identifier:
        return None

    tags = {
        "machine": identifier,
        "topic": topic,
    }

    fields: dict[str, Any] = {}
    for field_name in VOLTAGE_FIELDS:
        number_value = parse_number(payload.get(field_name))
        if number_value is not None:
            fields[field_name] = number_value

    for field_name in ("arcOn", "machineOn"):
        bool_value = parse_bool(payload.get(field_name))
        if bool_value is not None:
            fields[field_name] = bool_value

    if not fields:
        return None

    tag_text = ",".join(f"{_escape_key(key)}={_escape_key(str(value))}" for key, value in tags.items())
    field_text = ",".join(f"{_escape_key(key)}={_format_field(value)}" for key, value in fields.items())
    return f"{_escape_key(settings.influxdb_measurement)},{tag_text} {field_text} {_timestamp_ns(payload)}"


def _request(settings: Settings, path: str, body: bytes | None = None, content_type: str = "application/json") -> bytes:
    headers = {
        "Authorization": f"Bearer {settings.influxdb_token}",
        "Content-Type": content_type,
    }
    request = Request(f"{settings.influxdb_url}{path}", data=body, headers=headers, method="POST")

    try:
        with urlopen(request, timeout=10) as response:
            return response.read()
    except HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"InfluxDB request failed with HTTP {error.code}: {details}") from error


def ensure_database(settings: Settings) -> None:
    payload = json.dumps({"db": settings.influxdb_database}).encode("utf-8")
    try:
        _request(settings, "/api/v3/configure/database", body=payload)
    except RuntimeError as error:
        if "already exists" not in str(error).lower():
            raise


def write_line_protocol(settings: Settings, line_protocol: str) -> None:
    query = urlencode({"db": settings.influxdb_database})
    _request(
        settings,
        f"/api/v3/write_lp?{query}",
        body=line_protocol.encode("utf-8"),
        content_type="text/plain; charset=utf-8",
    )


def query_sql(settings: Settings, sql: str) -> list[dict[str, Any]]:
    payload = json.dumps(
        {
            "db": settings.influxdb_database,
            "q": sql,
            "format": "jsonl",
        }
    ).encode("utf-8")
    response_body = _request(settings, "/api/v3/query_sql", body=payload)

    rows: list[dict[str, Any]] = []
    for line in response_body.decode("utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def sql_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'
