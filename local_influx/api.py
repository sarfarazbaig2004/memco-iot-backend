from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query

from .config import get_settings
from .influx_client import query_sql, sql_identifier, sql_string


settings = get_settings()
app = FastAPI(title="MEMCO Local Influx Voltage API")


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "influxdb_url": settings.influxdb_url,
        "database": settings.influxdb_database,
    }


@app.get("/api/machines/{machine}/voltage")
def get_machine_voltage(
    machine: str,
    limit: int = Query(default=100, ge=1, le=1000),
    minutes: int | None = Query(default=None, ge=1, le=10080),
) -> dict[str, object]:
    where = [f"machine = {sql_string(machine)}"]
    if minutes is not None:
        where.append(f"time >= now() - interval '{minutes} minutes'")

    sql = f"""
        SELECT *
        FROM {sql_identifier(settings.influxdb_measurement)}
        WHERE {' AND '.join(where)}
        ORDER BY {sql_identifier('time')} DESC
        LIMIT {limit}
    """

    try:
        rows = query_sql(settings, sql)
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    return {
        "machine": machine,
        "count": len(rows),
        "rows": rows,
    }


@app.get("/api/machines/{machine}/latest-voltage")
def get_latest_machine_voltage(machine: str) -> dict[str, object]:
    result = get_machine_voltage(machine=machine, limit=1, minutes=None)
    rows = result["rows"]
    return {
        "machine": machine,
        "row": rows[0] if rows else None,
    }
